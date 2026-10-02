// ComputerBackend — M1 of the background-first Computer Workspace spec
// (specs/computer-workspace.md). The narrow, capability-oriented seam between the
// model-facing Computer surface and whatever executes the work.
//
// M1 contains exactly two implementations' worth of structure:
//   - createNativeMacBackend: wraps the CURRENT proven native runtime unchanged
//     (observations, background-safe semantics, foreground/exclusive takeover,
//     physical-user yield). No Helper protocol rewrite, no lease-authority rewrite,
//     no new credential surface.
//   - createComputerBackendRouter: policy layer so callers stop depending on native
//     implementation details. With one backend it is a truthful pass-through; M2 adds
//     the agent-owned workspace backend without touching the model-facing API.
//
// Security boundary: a backend is NOT a credential container. The native backend receives
// only the sanctioned `execute({ toolName, arguments, context })` seam of the existing
// runtime — broker tokens, lease tokens and Helper identity stay inside the trusted
// native implementation.

import { COMPUTER_USE_MODEL_TO_METHOD } from "./capability-contract.js";

/** Broker-level methods (the values of COMPUTER_USE_MODEL_TO_METHOD). */
export const COMPUTER_BACKEND_METHODS = Object.freeze([
  ...new Set(Object.values(COMPUTER_USE_MODEL_TO_METHOD)),
]);

/** How disruptive an operation class is for the user's own foreground. */
export const COMPUTER_METHOD_CLASSES = Object.freeze({
  // Reads and status: never disturb the user.
  permission_status: "background",
  list_apps: "background",
  list_windows: "background",
  observe: "background",
  control_status: "background",
  // Semantic mutation: background-capable where the target's AX allows; a per-target
  // refusal stays a truthful refused envelope (never retried as foreground silently).
  press: "background",
  set_value: "background",
  // Physical input: synthesized pointer/keyboard lands on a frontmost surface, so on the
  // native backend these disturb the user's foreground by definition.
  move_pointer: "physical",
  click: "physical",
  type_text: "physical",
  key_press: "physical",
  scroll: "physical",
  drag: "physical",
  // Agent-workspace methods: physical work delivered independently of the user's
  // foreground (pid-targeted AX actions / keyboard events).
  workspace_click: "physical",
  workspace_type_text: "physical",
  workspace_scroll: "physical",
  workspace_confirm: "physical",
  // open_app 后台投递 open/reopen 事件；部分应用会自激活，由 Helper 的 settle/restore
  // 守卫还回前台，因此与 press/set_value 同属 best-effort background，而不是纯 background。
  open_app: "physical",
  // Lease lifecycle: foreground-control management is inherently takeover machinery.
  acquire_control: "lease",
  release_control: "lease",
  activate_target: "lease",
});

/** Route classes reported to callers. `background` is a hard promise (see invariant). */
export const COMPUTER_ROUTE_CLASSES = Object.freeze(["background", "workspace", "foreground"]);

/**
 * Truthful per-backend capability report. Backends must never fabricate support:
 * report only what the implementation actually does today.
 */
export function normalizeBackendCapabilities(capabilities) {
  const required = [
    "id",
    "observes",
    "backgroundSemanticMutation",
    "independentPointer",
    "independentTextInput",
    "ownsForegroundWorkspace",
    "requiresUserForegroundForPhysicalInput",
    "frameStream",
  ];
  for (const key of required) {
    if (!(key in capabilities)) {
      throw new Error(`ComputerBackend capabilities missing "${key}"`);
    }
  }
  if (typeof capabilities.id !== "string" || !capabilities.id.trim()) {
    throw new Error("ComputerBackend capabilities.id must be a non-empty string");
  }
  return Object.freeze({ ...capabilities });
}

/**
 * The single routing decision. Deriving the route class HERE (from the method class and
 * the backend's declared capabilities) is what makes the user-foreground invariant
 * structural: a `background` route can only ever be produced for a background-class
 * method on a backend that does not require the user's foreground for physical input.
 */
export function routeClassFor(method, capabilities) {
  const methodClass = COMPUTER_METHOD_CLASSES[method];
  if (!methodClass) throw new Error(`unknown Computer backend method: ${method}`);
  // The background promise comes from the METHOD CLASS (reads and semantic mutation never
  // activate an app, move the user's cursor, or take the exclusive lease); the backend's
  // physical-input requirement only governs physical routes.
  if (methodClass === "background") return "background";
  if (methodClass === "lease") return "foreground";
  // Physical input: a backend that needs the user's real foreground delivers it as
  // takeover ("foreground"); any backend that can act independently of the user's
  // foreground — owned workspace surface or pid-targeted synthesis — routes "workspace".
  return capabilities.requiresUserForegroundForPhysicalInput === true ? "foreground" : "workspace";
}

function modelToolNameFor(brokerMethod) {
  for (const [publicName, method] of Object.entries(COMPUTER_USE_MODEL_TO_METHOD)) {
    if (method === brokerMethod) return publicName;
  }
  throw new Error(`no model-facing tool name for backend method: ${brokerMethod}`);
}

/**
 * The proven native implementation, unchanged behind the seam. `execute` is the existing
 * runtime's sanctioned dispatch seam: `execute({ toolName, arguments, context })`.
 */
export function createNativeMacBackend({ execute }) {
  if (typeof execute !== "function") {
    throw new Error("createNativeMacBackend requires the runtime execute seam");
  }
  const capabilities = normalizeBackendCapabilities({
    id: "native-mac",
    observes: true,
    backgroundSemanticMutation: true,
    independentPointer: false,
    independentTextInput: false,
    ownsForegroundWorkspace: false,
    requiresUserForegroundForPhysicalInput: true,
    frameStream: false,
  });
  return {
    capabilities,
    async perform(method, args, context) {
      const route = routeClassFor(method, capabilities);
      const result = await execute({
        toolName: modelToolNameFor(method),
        arguments: args,
        context,
      });
      return { route, result };
    },
  };
}

/**
 * Policy layer. Registration order is the tiebreaker; capability fit decides. M1 ships
 * with the native backend only — the structure is what M2's AgentWorkspaceBackend plugs
 * into without a model-facing API change.
 */
export function createComputerBackendRouter({ backends }) {
  if (!Array.isArray(backends) || backends.length === 0) {
    throw new Error("createComputerBackendRouter requires at least one backend");
  }
  for (const backend of backends) {
    if (!backend?.capabilities || typeof backend.perform !== "function") {
      throw new Error("router backends must expose { capabilities, perform }");
    }
  }
  const supports = (backend, method) => {
    const methodClass = COMPUTER_METHOD_CLASSES[method];
    if (!methodClass) throw new Error(`unknown Computer backend method: ${method}`);
    if (methodClass === "background") return backend.capabilities.observes === true;
    if (methodClass === "lease") return backend.capabilities.id === "native-mac";
    if (
      method === "move_pointer" ||
      method === "click" ||
      method === "scroll" ||
      method === "drag" ||
      method === "workspace_click" ||
      method === "workspace_scroll"
    ) {
      return (
        backend.capabilities.independentPointer === true ||
        backend.capabilities.requiresUserForegroundForPhysicalInput === true
      );
    }
    if (method === "workspace_type_text") {
      return backend.capabilities.independentTextInput === true;
    }
    return (
      backend.capabilities.independentTextInput === true ||
      backend.capabilities.requiresUserForegroundForPhysicalInput === true
    );
  };
  return {
    /**
     * Resolve (not execute) a route so callers/tests can pin policy decisions:
     * background ops prefer a backend that does not require the user foreground;
     * physical/keyboard ops prefer an independent-workspace owner when one exists;
     * lease lifecycle always lands on the native backend.
     */
    routeFor(method) {
      const candidates = backends.filter((backend) => supports(backend, method));
      if (candidates.length === 0) {
        throw new Error(`no Computer backend supports method: ${method}`);
      }
      const methodClass = COMPUTER_METHOD_CLASSES[method];
      let chosen = candidates[0];
      if (methodClass === "physical") {
        // Prefer an owned workspace surface, then any independent (non-user-foreground)
        // delivery, and only then the native takeover route.
        chosen =
          candidates.find((b) => b.capabilities.ownsForegroundWorkspace === true) ??
          candidates.find((b) => b.capabilities.requiresUserForegroundForPhysicalInput !== true) ??
          candidates.find((b) => b.capabilities.requiresUserForegroundForPhysicalInput === true) ??
          chosen;
      } else if (methodClass === "background") {
        chosen =
          candidates.find((b) => b.capabilities.requiresUserForegroundForPhysicalInput !== true) ??
          chosen;
      }
      return { backend: chosen, routeClass: routeClassFor(method, chosen.capabilities) };
    },
    async perform(method, args, context) {
      const { backend, routeClass } = this.routeFor(method);
      const result = await backend.perform(method, args, context);
      return { routeClass, backendId: backend.capabilities.id, result };
    },
  };
}
