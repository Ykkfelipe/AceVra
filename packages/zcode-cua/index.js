import {
  normalizeComputerUseResult,
  resolveComputerUseCapabilities,
} from "./capability-contract.js";
import { describeComputerUseSurface, foregroundComputerUseAvailable } from "./computer-surface.js";
import {
  forgetForegroundObservations,
  rememberForegroundObservations,
} from "./foreground-observations.js";
import {
  rememberSemanticGeometry,
  semanticTargetOf,
  workspaceCursorOf,
} from "./semantic-geometry.js";
import { createSessionIdentityRegistry, identityText } from "./session-identity.js";
import { validateComputerUseRequest } from "./request-guard.js";
import { assertForegroundObservationId } from "./takeover-grant.js";
import { createProtectedForegroundController } from "./protected-runtime.js";
import { annotateHelperFailure, classifyThrownFailure, failureHint } from "./transport-errors.js";

/**
 * Model-facing provider-independent tool name to broker method.
 *
 * The explicit foreground names remain separate from CUA-2 semantic operations. Old arbitrary
 * input names, application launch, clipboard, zoom and process control stay unmapped.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** CUA-4: methods that stay available while the user has paused Computer Use. */
const PAUSE_EXEMPT_METHODS = new Set(["permission_status", "control_status"]);
const PAUSED_TEXT =
  "Computer Use is paused by the user. Do not retry Computer Use; tell the user you are waiting and continue only after they resume it.";

function unavailable(text, code = "unavailable", effect = "refused") {
  return {
    content: [{ type: "text", text }],
    structuredContent: { effect, route: "none", evidence: [], code },
    isError: true,
  };
}

/** Largest screenshot inlined into the chat (a Retina window PNG is usually well below this). */
const MAX_INLINE_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/**
 * The PNG the Helper just wrote for this observation, as an inline image block; undefined when
 * there is no frame, the capture was blank, or it is too large to show inline.
 */
async function readScreenshotImage(result) {
  const image = result && typeof result === "object" ? result.image : undefined;
  if (!image || typeof image.path !== "string" || image.blank === true) return undefined;
  try {
    const { readFile, stat } = await import("node:fs/promises");
    if ((await stat(image.path)).size > MAX_INLINE_SCREENSHOT_BYTES) return undefined;
    const data = (await readFile(image.path)).toString("base64");
    return { type: "image", data, mimeType: "image/png", inline_screenshot: true };
  } catch {
    return undefined;
  }
}

/**
 * Computer Use runtime using the verified Helper broker.
 *
 * The broker module is imported lazily so this entry point stays free of node builtins for a
 * consumer that only reads its types, and so a runtime that never executes a tool never opens a
 * socket.
 */
export function createComputerUseRuntime(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // CUA-1.5 launch-scoped session capability. It must be captured *here*, together with the socket
  // and for the same reason: the trusted plugin host restores the Helper credentials for exactly the
  // window in which the stdio MCP server process is created and clears them from its environment as
  // soon as that creation returns, while `callBrokerMethod` reads the token from the environment at
  // *call* time. Reading it later therefore produced `missing_session_capability` on every real
  // request even though the same process had just captured a healthy socket. Key intentionally
  // spelled here instead of importing broker.js at module scope, which would pull node builtins into
  // a consumer that only reads types.
  const brokerToken =
    typeof options.brokerToken === "string" && options.brokerToken.trim()
      ? options.brokerToken.trim()
      : env?.ZCODE_CUA_PERMISSION_BROKER_TOKEN?.trim();
  const explicitSocketPath =
    typeof options.brokerSocketPath === "string" ? options.brokerSocketPath.trim() : "";
  const leaseAuthority = options.leaseAuthority;
  // CUA-4：只记录 Helper 在本运行时会话中实际列出的 pid/窗口，用于把观察目标命名；
  // 未被列出的目标只保留已知部分，绝不猜测名称。
  const identities = createSessionIdentityRegistry();
  /** sessionId → (semantic_ref → {pid, x, y}) from that session's latest observation tree. */
  const semanticGeometry = new Map();
  /** sessionId → Set of Helper-issued foreground observation ids (see foreground-observations.js). */
  const foregroundObservations = new Map();
  let callSequence = 0;

  function reportActivity(report) {
    if (!report.session || !leaseAuthority || typeof leaseAuthority.reportActivity !== "function") {
      return;
    }
    try {
      // 投影上报只能尽力而为：不 await、不影响动作结果，sideband 故障不能改变 Computer Use 行为。
      void Promise.resolve(leaseAuthority.reportActivity(report)).catch(() => undefined);
    } catch {
      // Same rule as above.
    }
  }

  async function resolveSocketPath() {
    if (explicitSocketPath) return explicitSocketPath;
    const broker = await import("./broker.js");
    return broker.resolveBrokerSocketPath({ env });
  }

  /**
   * One relay call with the captured session capability.
   *
   * The socket is resolved (and the broker module imported) lazily; the token is not — it is part of
   * the runtime's captured transport identity, so every call carries the capability of the transport
   * this runtime was constructed against, never whatever the environment happens to say later.
   */
  async function callBroker(broker, request) {
    return await broker.callBrokerMethod({
      ...request,
      ...(brokerToken ? { token: brokerToken } : {}),
    });
  }

  /** One Helper call through the captured transport (used by the protected controller too). */
  async function helperCall(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const broker = await import("./broker.js");
    return await callBroker(broker, {
      socketPath: await resolveSocketPath(),
      method,
      params,
      timeoutMs,
      expectedHelperIdentifiers: options.expectedHelperIdentifiers,
    });
  }

  /**
   * Background/read call with one bounded recovery. A failure that provably never reached the
   * Helper (`delivery: not_sent`, e.g. the relay had no Helper attached) is retried once after the
   * lifecycle owner relaunched the Helper; a read-only method is also retried when the Helper died
   * mid-request. A mutating call whose delivery is unknown is never replayed.
   */
  async function callWithRecovery(broker, method, params) {
    try {
      return await helperCall(method, params);
    } catch (error) {
      const failure = classifyThrownFailure(error);
      const retryable =
        failure.recoverable &&
        ["helper_disconnected", "helper_exited", "connection_closed"].includes(failure.code) &&
        (failure.delivery === "not_sent" || broker.isReadOnlyBrokerMethod(method));
      if (!retryable || typeof leaseAuthority?.recoverHelper !== "function") throw error;
      let recovered;
      try {
        recovered = await leaseAuthority.recoverHelper();
      } catch {
        recovered = undefined;
      }
      if (!recovered?.connected) throw error;
      return await helperCall(method, params);
    }
  }

  const protectedForeground = createProtectedForegroundController({
    helperCall,
    leaseAuthority,
    foregroundObservations,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs,
  });

  // Canonical discovery (`await agent.computerUse.describe()`), answered without the Helper.
  const foregroundAvailableFor = (context) =>
    foregroundComputerUseAvailable(context, options.allowForegroundControl);

  return {
    async execute(input) {
      const toolName = typeof input?.toolName === "string" ? input.toolName : "";
      if (toolName === "describe") {
        return describeComputerUseSurface({
          platform,
          foregroundAvailable: foregroundAvailableFor(input?.context),
        });
      }
      const guard = validateComputerUseRequest({
        toolName,
        input,
        platform,
        allowForegroundControl: options.allowForegroundControl,
      });
      if (guard.refusal) {
        return unavailable(guard.refusal.text, guard.refusal.code);
      }
      const { method, foreground } = guard;

      const sessionId =
        typeof input?.context?.sessionId === "string" ? input.context.sessionId : "";
      const task =
        typeof input?.context?.turnId === "string" && input.context.turnId
          ? input.context.turnId
          : sessionId;
      const workspaceAction = [
        "workspace_click",
        "workspace_type_text",
        "workspace_scroll",
        "workspace_confirm",
      ].includes(method);
      const mutating =
        method === "press" ||
        method === "set_value" ||
        method === "open_app" ||
        foreground ||
        workspaceAction;
      if (
        leaseAuthority &&
        typeof leaseAuthority.admission === "function" &&
        !PAUSE_EXEMPT_METHODS.has(method)
      ) {
        let admission;
        try {
          admission = await leaseAuthority.admission();
        } catch {
          admission = undefined;
        }
        // CUA-4 暂停是真实边界：暂停期间除状态查询外一律拒绝，不能只隐藏 UI 更新。
        if (admission?.paused === true) return unavailable(PAUSED_TEXT, "paused");
        if (!admission && mutating) {
          return unavailable(
            "Computer Use control state could not be verified",
            "lease_authority_unavailable",
          );
        }
      }
      callSequence += 1;
      const callId = `${Date.now().toString(36)}-${callSequence}`;
      const activityBase = { session: sessionId, task, callId, method };
      reportActivity({ ...activityBase, phase: "started", at: Date.now() });

      try {
        if (typeof options.ensureBrokerAvailable === "function") {
          await options.ensureBrokerAvailable();
        }
        const broker = await import("./broker.js");
        const { sanitizeObservationResult } = await import("./observe-result.js");
        let result;
        if (method === "acquire_control") {
          // 修复依据（installed 9eb4f148 实测）：模型传了语义树的 tree.observation_id，Helper 只认
          // get_app_state 结果里的 foreground_geometry.observation_id。弹卡之前就如实指出。
          assertForegroundObservationId(input?.arguments?.observation_id);
          // 屏幕接管只能由用户在 AceVra 里批准；批准后由运行时持有 ProtectedForegroundGrant 绑定，
          // 模型拿到的是 protectedForeground 状态，不是原生租约 id（protected-runtime.js）。
          result = await protectedForeground.acquire({
            sessionId,
            task,
            observationId: input?.arguments?.observation_id,
          });
        } else if (method === "release_control") {
          result = await protectedForeground.release({ sessionId, task });
        } else if (method === "control_status") {
          result = await protectedForeground.status({ sessionId, task });
        } else if (foreground) {
          result = await protectedForeground.act({
            sessionId,
            task,
            method,
            args: input?.arguments ?? {},
          });
        } else {
          // `callBrokerMethod` refuses a helper whose verified signature identity is missing or is
          // not one this build expects, so what reaches a model was produced by a verified helper.
          const params = workspaceAction
            ? {
                ...input.arguments,
                owner_session: input.context.sessionId,
                owner_task: input.context.turnId || input.context.sessionId,
              }
            : (input?.arguments ?? {});
          result = await callWithRecovery(broker, method, params);
        }
        // 用户要求的截图（screenshot 工具，不是常规 get_app_state 观察）：读取 Helper 刚写的帧，
        // 以图片块带回，由 node_repl bridge 放进聊天。帧路径本身仍不出运行时。
        const screenshotImage =
          toolName === "screenshot" || toolName === "computer.screenshot"
            ? await readScreenshotImage(result)
            : undefined;
        // The model-facing boundary. `observe` answers with a host path to the frame it wrote;
        // that path is a host-internal detail, so it is replaced here by the opaque reference and
        // the whole result is bounded before it is serialized into model context.
        const { result: sanitized } = sanitizeObservationResult(result);
        if (method === "permission_status") {
          sanitized.capabilities = resolveComputerUseCapabilities({
            platform,
            helperVerified:
              sanitized.helper_identity?.verified === true || sanitized.identity_verified === true,
            accessibility: sanitized.accessibility,
          });
        }
        const action =
          method === "press" || method === "set_value" || foreground || workspaceAction;
        // Phase 2：Helper 的拒绝码映射为 canonical code（保留 original_code 与 recoverable），
        // 例如 interrupted → user_takeover；未知码原样保留。
        const normalized = action
          ? annotateHelperFailure(normalizeComputerUseResult(sanitized, method))
          : sanitized;
        identities.remember(sessionId, method, result);
        if (method === "observe") {
          rememberSemanticGeometry(semanticGeometry, sessionId, result);
          // 台账只登记 Helper 真的签发了前台几何的观察，acquire_control 据此决定能否弹卡。
          rememberForegroundObservations(foregroundObservations, sessionId, result);
        }
        const semantic = semanticTargetOf(semanticGeometry, sessionId, method, input?.arguments);
        const image =
          method === "observe" && result && typeof result === "object" ? result.image : null;
        const observationId =
          image && typeof image === "object" ? identityText(image.observation_id) : undefined;
        // M3：workspace 动作把目标与逻辑光标一并上报，宿主投影据此维护 mini Computer 视图；
        // target 只使用 Helper 已确认的身份（与 observe 同一来源），绝不猜测。
        const workspaceCursor = workspaceAction
          ? workspaceCursorOf(input?.arguments, result)
          : semantic && { x: semantic.x, y: semantic.y };
        reportActivity({
          ...activityBase,
          phase: "completed",
          at: Date.now(),
          ...(typeof normalized.effect === "string" ? { effect: normalized.effect } : {}),
          ...(typeof normalized.route === "string" ? { route: normalized.route } : {}),
          ...(typeof normalized.code === "string" ? { code: normalized.code } : {}),
          ...(typeof normalized.input_delivery === "string"
            ? { inputDelivery: normalized.input_delivery }
            : {}),
          ...(typeof normalized.application_effect === "string"
            ? { applicationEffect: normalized.application_effect }
            : {}),
          ...(workspaceCursor ? { workspaceCursor } : {}),
          ...((method === "observe" || workspaceAction) && input?.arguments?.pid !== undefined
            ? { target: identities.target(sessionId, input?.arguments) }
            : semantic
              ? { target: identities.target(sessionId, { pid: semantic.pid }) }
              : {}),
          ...(observationId
            ? {
                observation: {
                  id: observationId,
                  ...(Number.isFinite(image.width) ? { width: image.width } : {}),
                  ...(Number.isFinite(image.height) ? { height: image.height } : {}),
                  ...(typeof image.blank === "boolean" ? { blank: image.blank } : {}),
                  ...(typeof image.path === "string" ? { framePath: image.path } : {}),
                },
              }
            : {}),
        });
        return {
          content: [
            ...(screenshotImage ? [screenshotImage] : []),
            { type: "text", text: JSON.stringify(normalized) },
          ],
          ...(action
            ? {
                structuredContent: normalized,
                ...(normalized.effect === "refused" || normalized.effect === "failed"
                  ? { isError: true }
                  : {}),
              }
            : {}),
        };
      } catch (error) {
        // A missing grant, a stopped Helper and a refused method are all reported rather than
        // thrown: the caller needs the code in order to decide what to do. The text is redacted
        // like any other model-facing string — a `connect_failed` message carries the socket path,
        // and "no Helper running yet" is the ordinary first-use case, not an edge case.
        // Phase 2（proven installed 92454874）：每一层的 code 都保留到这里，由 transport-errors.js
        // 统一映射为 canonical code；original_code / recoverable / delivery 一并交给模型，
        // 绝不再出现 "(unknown): failed"。会话 socket 已消失时如实命名 helper_disconnected。
        let socketGone = false;
        try {
          const { existsSync } = await import("node:fs");
          socketGone = !existsSync(await resolveSocketPath());
        } catch {
          // 探测失败就保留原 code，绝不把分类错误伪装成成功路径。
        }
        const failure = classifyThrownFailure(error, { socketGone });
        const hint = failureHint(failure.code);
        reportActivity({
          ...activityBase,
          phase: "completed",
          at: Date.now(),
          effect: "failed",
          code: failure.code,
        });
        const message = error instanceof Error ? error.message : String(error);
        const { redactHostPaths } = await import("./observe-result.js");
        return {
          content: [
            {
              type: "text",
              text: `Computer Use request failed (${failure.code}): ${redactHostPaths(message)}${hint ? ` ${hint}` : ""}`,
            },
          ],
          structuredContent: {
            effect: "failed",
            route: "none",
            evidence: [],
            ...failure,
          },
          isError: true,
        };
      }
    },
    async closeSession(context) {
      if (context?.sessionId) {
        identities.forget(context.sessionId);
        semanticGeometry.delete(context.sessionId);
        forgetForegroundObservations(foregroundObservations, context.sessionId);
        await protectedForeground.closeSession(context.sessionId);
      }
    },
    async dispose() {
      await protectedForeground.dispose();
    },
  };
}
