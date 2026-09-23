/**
 * Model-facing provider-independent tool name to broker method.
 *
 * Coordinate and keyboard input stays fail-closed: `left_click`, `type`, `key`, `scroll`, `drag`,
 * `perform_action`, `launch_app`, `activate_window`, `clipboard_*` and `kill_app` are not
 * reachable through this runtime at all. `zoom` is also left unmapped on purpose — the broker
 * has no crop rung, and answering a crop request with a whole-window capture would silently
 * change what the caller asked for.
 */
const MODEL_TOOL_METHODS = Object.freeze({
  list_apps: "list_apps",
  list_windows: "list_windows",
  get_app_state: "observe",
  screenshot: "observe",
  request_access: "permission_status",
  "computer.press": "press",
  "computer.set_value": "set_value",
});

const MODEL_TOOL_HINT =
  "supported tools: list_apps, list_windows, get_app_state, screenshot, request_access, computer.press, computer.set_value.";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function unavailable(text) {
  return { content: [{ type: "text", text }], isError: true };
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
  const explicitSocketPath =
    typeof options.brokerSocketPath === "string" ? options.brokerSocketPath.trim() : "";

  async function resolveSocketPath() {
    if (explicitSocketPath) return explicitSocketPath;
    const broker = await import("./broker.js");
    return broker.resolveBrokerSocketPath({ env });
  }

  return {
    async execute(input) {
      const toolName = typeof input?.toolName === "string" ? input.toolName : "";
      const method = Object.prototype.hasOwnProperty.call(MODEL_TOOL_METHODS, toolName)
        ? MODEL_TOOL_METHODS[toolName]
        : undefined;
      if (!method) {
        return unavailable(
          `Computer Use tool '${toolName || "(unnamed)"}' is not available: ${MODEL_TOOL_HINT}`,
        );
      }

      try {
        if (typeof options.ensureBrokerAvailable === "function") {
          await options.ensureBrokerAvailable();
        }
        const broker = await import("./broker.js");
        const { sanitizeObservationResult } = await import("./observe-result.js");
        // `callBrokerMethod` refuses a helper whose verified signature identity is missing or is
        // not one this build expects, so what reaches a model was produced by a verified helper.
        const result = await broker.callBrokerMethod({
          socketPath: await resolveSocketPath(),
          method,
          params: input?.arguments ?? {},
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          expectedHelperIdentifiers: options.expectedHelperIdentifiers,
        });
        // The model-facing boundary. `observe` answers with a host path to the frame it wrote;
        // that path is a host-internal detail, so it is replaced here by the opaque reference and
        // the whole result is bounded before it is serialized into model context.
        const { result: sanitized } = sanitizeObservationResult(result);
        return { content: [{ type: "text", text: JSON.stringify(sanitized) }] };
      } catch (error) {
        // A missing grant, a stopped Helper and a refused method are all reported rather than
        // thrown: the caller needs the code in order to decide what to do. The text is redacted
        // like any other model-facing string — a `connect_failed` message carries the socket path,
        // and "no Helper running yet" is the ordinary first-use case, not an edge case.
        const code = error && typeof error.code === "string" ? error.code : "unknown";
        const message = error instanceof Error ? error.message : String(error);
        const { redactHostPaths } = await import("./observe-result.js");
        return unavailable(`Computer Use request failed (${code}): ${redactHostPaths(message)}`);
      }
    },
    async closeSession() {},
    async dispose() {},
  };
}
