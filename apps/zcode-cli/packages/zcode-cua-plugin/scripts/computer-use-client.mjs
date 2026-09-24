/**
 * Official Computer Use SDK bootstrap.
 *
 * The node_repl host owns the authenticated CUA bridge and the native runtime is bundled by
 * @zcode/node-repl-host/@zcode/zcode-cua. This package must not create a Helper, broker, lease,
 * or native actuator of its own. The facade only exposes the host-installed client to the skill.
 */

const unavailable = (reason = "Computer Use is unavailable for this node_repl session") => {
  throw new Error(reason);
};

const CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");

function bridgeClient(bridge) {
  if (!bridge || typeof bridge.call !== "function") return undefined;
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "documentationRoot") return bridge.documentationRoot;
        return async (input) => {
          bridge.assertAvailable?.();
          return await bridge.call(property, input);
        };
      },
    },
  );
}

/** Return the host-provided Computer Use client without constructing a second runtime. */
export function getComputerUseClient(globalObject = globalThis) {
  const existing = globalObject?.agent?.computerUse;
  if (existing) return existing;
  const client = bridgeClient(globalObject?.[CUA_BRIDGE_SYMBOL]);
  if (!client) unavailable();
  return client;
}

/** Compatibility bootstrap for skills that import this client before calling the SDK. */
export function setupComputerUseRuntime(globalObject = globalThis) {
  const client = getComputerUseClient(globalObject);
  if (globalObject.agent && !globalObject.agent.computerUse) {
    globalObject.agent.computerUse = client;
  }
  return client;
}

export const computerUseClient = {
  get: getComputerUseClient,
  setup: setupComputerUseRuntime,
};

export default computerUseClient;
