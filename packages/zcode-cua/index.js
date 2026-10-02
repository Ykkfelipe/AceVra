import {
  normalizeComputerUseResult,
  resolveComputerUseCapabilities,
} from "./capability-contract.js";
import { describeComputerUseSurface, foregroundComputerUseAvailable } from "./computer-surface.js";
import {
  forgetForegroundObservations,
  hasForegroundObservation,
  rememberForegroundObservations,
} from "./foreground-observations.js";
import {
  rememberSemanticGeometry,
  semanticTargetOf,
  workspaceCursorOf,
} from "./semantic-geometry.js";
import { createSessionIdentityRegistry, identityText } from "./session-identity.js";
import { validateComputerUseRequest } from "./request-guard.js";
import { assertForegroundObservationId, requireTakeoverGrant } from "./takeover-grant.js";

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
  const activeLeases = new Map();
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

  async function releaseAuthorityLease(sessionId, reason) {
    const current = activeLeases.get(sessionId);
    if (!current) return;
    try {
      if (leaseAuthority && current.authorityLeaseId) {
        await leaseAuthority.release(current.authorityLeaseId, reason);
      }
    } catch {
      // The service authority fences independently; the runtime projection is still disposable.
    } finally {
      activeLeases.delete(sessionId);
    }
  }

  async function releaseKnownLease(sessionId, reason = "runtime_cleanup") {
    const current = activeLeases.get(sessionId);
    if (!current) return;
    try {
      const broker = await import("./broker.js");
      await callBroker(broker, {
        socketPath: await resolveSocketPath(),
        method: "release_control",
        params: {
          lease_id: current.helperLeaseId,
          owner_session: sessionId,
          owner_task: current.task,
        },
        timeoutMs: 2000,
        expectedHelperIdentifiers: options.expectedHelperIdentifiers,
      });
    } catch {
      // The Helper also releases on disconnect and at its bounded deadline.
    } finally {
      await releaseAuthorityLease(sessionId, reason);
    }
  }

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
        // 屏幕接管只能由用户在 AceVra 里批准（specs "Screen takeover"）：Helper 租约之前先等授权。
        if (method === "acquire_control") {
          // 修复依据（installed 9eb4f148 实测）：模型传了语义树的 tree.observation_id，Helper 只认
          // get_app_state 结果里的 foreground_geometry.observation_id（Helper 以小写 UUID 签发，
          // 语义树 id 为大写），于是每次都是 stale_geometry。弹卡之前就如实指出，避免无效授权往返。
          assertForegroundObservationId(input?.arguments?.observation_id);
          // 修复依据（installed be1b1348 实测）：Helper 只在观察带 window_id 时才签发
          // foreground_geometry，所以没有该几何的观察根本不可能拿到租约。以前这里直接弹卡，
          // 用户批准之后请求必然失败——用真实的同意换一次注定失败的授权。先核对台账再问用户。
          if (
            !hasForegroundObservation(
              foregroundObservations,
              sessionId,
              input?.arguments?.observation_id,
            )
          ) {
            throw Object.assign(
              new Error(
                "this observation carries no foreground geometry, so the Helper cannot grant a lease. Call list_windows, then get_app_state with that window's window_id (foreground_geometry is only issued for an explicit window), and pass its foreground_geometry.observation_id straight to computer.acquire_control. The user was not asked for approval.",
              ),
              { code: "foreground_geometry_unavailable" },
            );
          }
          await requireTakeoverGrant(leaseAuthority, { session: sessionId, task });
        }
        const broker = await import("./broker.js");
        const { sanitizeObservationResult } = await import("./observe-result.js");
        // `callBrokerMethod` refuses a helper whose verified signature identity is missing or is
        // not one this build expects, so what reaches a model was produced by a verified helper.
        const params =
          foreground || workspaceAction
            ? {
                ...input.arguments,
                owner_session: input.context.sessionId,
                owner_task: input.context.turnId || input.context.sessionId,
              }
            : (input?.arguments ?? {});
        let result;
        if (
          method === "acquire_control" &&
          (!leaseAuthority || typeof input?.context?.sessionId !== "string")
        ) {
          throw Object.assign(new Error("foreground lease authority is unavailable"), {
            code: "lease_authority_unavailable",
          });
        }
        const reservation =
          method === "acquire_control" && leaseAuthority
            ? await leaseAuthority.beginAcquire({
                session: input.context.sessionId,
                task: input.context.turnId || input.context.sessionId,
              })
            : null;
        try {
          result = await callBroker(broker, {
            socketPath: await resolveSocketPath(),
            method,
            params,
            timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            expectedHelperIdentifiers: options.expectedHelperIdentifiers,
          });
          if (
            reservation &&
            result?.effect === "confirmed" &&
            typeof result?.lease_id === "string"
          ) {
            const requirement = result?.helper_identity?.requirement;
            if (typeof requirement !== "string" || requirement.length === 0) {
              await callBroker(broker, {
                socketPath: await resolveSocketPath(),
                method: "release_control",
                params: {
                  lease_id: result.lease_id,
                  owner_session: input.context.sessionId,
                  owner_task: params.owner_task,
                },
                timeoutMs: 2000,
                expectedHelperIdentifiers: options.expectedHelperIdentifiers,
              }).catch(() => undefined);
              throw Object.assign(new Error("verified Helper requirement is unavailable"), {
                code: "lease_authority_unavailable",
              });
            }
            const committed = await leaseAuthority.commitAcquire(
              reservation.leaseId,
              result.lease_id,
              requirement,
            );
            result = { ...result, lease_authority_generation: committed.generation };
          } else if (reservation) {
            await leaseAuthority.stop().catch(() => undefined);
            if (result?.lease_id)
              await callBroker(broker, {
                socketPath: await resolveSocketPath(),
                method: "release_control",
                params: {
                  lease_id: result.lease_id,
                  owner_session: input.context.sessionId,
                  owner_task: params.owner_task,
                },
                timeoutMs: 2000,
                expectedHelperIdentifiers: options.expectedHelperIdentifiers,
              }).catch(() => undefined);
          }
        } catch (error) {
          if (reservation) await leaseAuthority.stop().catch(() => undefined);
          if (result?.lease_id)
            await broker
              .callBrokerMethod({
                socketPath: await resolveSocketPath(),
                method: "release_control",
                params: {
                  lease_id: result.lease_id,
                  owner_session: input.context.sessionId,
                  owner_task: params.owner_task,
                },
                timeoutMs: 2000,
                expectedHelperIdentifiers: options.expectedHelperIdentifiers,
              })
              .catch(() => undefined);
          throw error;
        }
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
        const normalized = action ? normalizeComputerUseResult(sanitized, method) : sanitized;
        if (
          foreground &&
          method === "acquire_control" &&
          normalized.effect === "confirmed" &&
          typeof normalized.lease_id === "string"
        ) {
          activeLeases.set(input.context.sessionId, {
            authorityLeaseId: reservation.leaseId,
            helperLeaseId: normalized.lease_id,
            task: params.owner_task,
          });
        }
        if (foreground && method === "release_control") {
          await releaseAuthorityLease(input.context.sessionId, "model_release");
        }
        if (foreground && normalized.code === "interrupted") {
          await releaseKnownLease(input.context.sessionId, "interrupted");
        }
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
          content: [{ type: "text", text: JSON.stringify(normalized) }],
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
        const code = error && typeof error.code === "string" ? error.code : "unknown";
        reportActivity({
          ...activityBase,
          phase: "completed",
          at: Date.now(),
          effect: "failed",
          code,
        });
        const message = error instanceof Error ? error.message : String(error);
        const { redactHostPaths } = await import("./observe-result.js");
        return unavailable(
          `Computer Use request failed (${code}): ${redactHostPaths(message)}`,
          code,
          "failed",
        );
      }
    },
    async closeSession(context) {
      if (context?.sessionId) {
        identities.forget(context.sessionId);
        semanticGeometry.delete(context.sessionId);
        forgetForegroundObservations(foregroundObservations, context.sessionId);
        await releaseKnownLease(context.sessionId);
      }
    },
    async dispose() {
      for (const sessionId of activeLeases.keys()) await releaseKnownLease(sessionId);
    },
  };
}
