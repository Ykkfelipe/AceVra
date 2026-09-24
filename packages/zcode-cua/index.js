import {
  resolveComputerUseMethod,
  normalizeComputerUseResult,
  resolveComputerUseCapabilities,
  validSemanticActionInput,
  validForegroundInput,
  COMPUTER_USE_FOREGROUND_METHODS,
} from "./capability-contract.js";

/**
 * Model-facing provider-independent tool name to broker method.
 *
 * The explicit foreground names remain separate from CUA-2 semantic operations. Old arbitrary
 * input names, application launch, clipboard, zoom and process control stay unmapped.
 */
const MODEL_TOOL_HINT =
  "supported tools: list_apps, list_windows, get_app_state, screenshot, request_access, computer.press, computer.set_value, computer.control_status, computer.acquire_control, computer.release_control, computer.activate_target, computer.move_pointer, computer.click, computer.type_text, computer.key_press, computer.scroll, computer.drag.";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

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
  const explicitSocketPath =
    typeof options.brokerSocketPath === "string" ? options.brokerSocketPath.trim() : "";
  const activeLeases = new Map();

  async function resolveSocketPath() {
    if (explicitSocketPath) return explicitSocketPath;
    const broker = await import("./broker.js");
    return broker.resolveBrokerSocketPath({ env });
  }

  async function releaseKnownLease(sessionId) {
    const current = activeLeases.get(sessionId);
    if (!current) return;
    activeLeases.delete(sessionId);
    try {
      const broker = await import("./broker.js");
      await broker.callBrokerMethod({
        socketPath: await resolveSocketPath(),
        method: "release_control",
        params: { lease_id: current.id, owner_session: sessionId, owner_task: current.task },
        timeoutMs: 2000,
        expectedHelperIdentifiers: options.expectedHelperIdentifiers,
      });
    } catch {
      // The Helper also releases on disconnect and at its bounded deadline.
    }
  }

  return {
    async execute(input) {
      const toolName = typeof input?.toolName === "string" ? input.toolName : "";
      const method = resolveComputerUseMethod(toolName);
      if (platform !== "darwin") {
        return unavailable(
          "Computer Use native methods are unavailable on this platform",
          "unsupported_platform",
        );
      }
      if (!method) {
        return unavailable(
          `Computer Use tool '${toolName || "(unnamed)"}' is not available: ${MODEL_TOOL_HINT}`,
          "unsupported",
        );
      }
      if (
        (method === "press" || method === "set_value") &&
        !validSemanticActionInput(method, input?.arguments)
      ) {
        return unavailable(`${method} requires an observation-derived semantic_ref`, "bad_request");
      }
      const foreground = COMPUTER_USE_FOREGROUND_METHODS.includes(method);
      if (
        method === "control_status" &&
        (!input?.arguments ||
          Object.keys(input.arguments).length !== 1 ||
          !/^[0-9a-f-]{36}$/u.test(input.arguments.lease_id ?? ""))
      ) {
        return unavailable("control_status requires a lease_id", "bad_request");
      }
      if (foreground) {
        const foregroundControlAllowed = options.allowForegroundControl;
        const context = input?.context;
        const hostOwnsForegroundCapability =
          typeof foregroundControlAllowed === "function" && foregroundControlAllowed() === true;
        if (
          !hostOwnsForegroundCapability ||
          context?.runtimeScope !== "main" ||
          context?.clientMode !== "desktop-continuous" ||
          context?.deliveryKind !== "desktop-continuous" ||
          context?.remoteSessionId
        ) {
          return unavailable("Foreground Computer Use requires a local desktop task", "local_only");
        }
        if (!validForegroundInput(method, input?.arguments)) {
          return unavailable(`${method} arguments are invalid`, "bad_request");
        }
      }

      try {
        if (typeof options.ensureBrokerAvailable === "function") {
          await options.ensureBrokerAvailable();
        }
        const broker = await import("./broker.js");
        const { sanitizeObservationResult } = await import("./observe-result.js");
        // `callBrokerMethod` refuses a helper whose verified signature identity is missing or is
        // not one this build expects, so what reaches a model was produced by a verified helper.
        const params = foreground
          ? {
              ...input.arguments,
              owner_session: input.context.sessionId,
              owner_task: input.context.turnId || input.context.sessionId,
            }
          : (input?.arguments ?? {});
        const result = await broker.callBrokerMethod({
          socketPath: await resolveSocketPath(),
          method,
          params,
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          expectedHelperIdentifiers: options.expectedHelperIdentifiers,
        });
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
        const action = method === "press" || method === "set_value" || foreground;
        const normalized = action ? normalizeComputerUseResult(sanitized, method) : sanitized;
        if (
          foreground &&
          method === "acquire_control" &&
          normalized.effect === "confirmed" &&
          typeof normalized.lease_id === "string"
        ) {
          activeLeases.set(input.context.sessionId, {
            id: normalized.lease_id,
            task: params.owner_task,
          });
        }
        if (foreground && (method === "release_control" || normalized.code === "interrupted")) {
          activeLeases.delete(input.context.sessionId);
        }
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
      if (context?.sessionId) await releaseKnownLease(context.sessionId);
    },
    async dispose() {
      for (const sessionId of activeLeases.keys()) await releaseKnownLease(sessionId);
    },
  };
}
