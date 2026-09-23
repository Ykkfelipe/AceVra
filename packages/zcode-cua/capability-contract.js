/** The single model-independent Computer Use capability vocabulary. */
export const COMPUTER_USE_METHODS = Object.freeze({
  permission_status: "read",
  list_apps: "read",
  list_windows: "read",
  observe: "read",
  press: "mutation",
  set_value: "mutation",
});

export const COMPUTER_USE_MODEL_TO_METHOD = Object.freeze({
  list_apps: "list_apps",
  list_windows: "list_windows",
  get_app_state: "observe",
  screenshot: "observe",
  request_access: "permission_status",
  "computer.press": "press",
  "computer.set_value": "set_value",
});

export const COMPUTER_USE_BACKEND_SUPPORT = Object.freeze({
  provider_agent_runtime: true,
  "z.ai": true,
  azure_openai: true,
  command_code_openai_compatible: true,
  codex_execution_backend: false,
  claude_code_execution_backend: false,
});
export const COMPUTER_USE_CANONICAL_MODEL_PREFIX = "mcp__computer-use__";

export function canonicalComputerUseMcpName(modelVisibleToolName) {
  if (typeof modelVisibleToolName !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(modelVisibleToolName)) {
    throw new TypeError("Computer Use MCP tool name must be a normalized visible name");
  }
  return `${COMPUTER_USE_CANONICAL_MODEL_PREFIX}${modelVisibleToolName}`;
}

export const COMPUTER_USE_CLASSIFICATIONS = Object.freeze([
  "BACKGROUND_SAFE",
  "BEST_EFFORT_BACKGROUND",
  "REQUIRES_FOREGROUND",
  "UNSUPPORTED",
]);

export const COMPUTER_USE_EFFECTS = Object.freeze([
  "confirmed",
  "partial",
  "unknown",
  "refused",
  "failed",
]);
export const COMPUTER_USE_ROUTES = Object.freeze(["accessibility_action", "none"]);
export const COMPUTER_USE_ACTION_CLASSIFICATIONS = Object.freeze({
  press: "BEST_EFFORT_BACKGROUND",
  set_value: "BEST_EFFORT_BACKGROUND",
});

/** Availability derived only from a verified helper's permission_status response. */
export function resolveComputerUseCapabilities({ platform, helperVerified, accessibility }) {
  const unavailable = {
    permission_status: false,
    list_apps: false,
    list_windows: false,
    observe: false,
    screenshot: false,
    press: false,
    set_value: false,
  };
  if (platform !== "darwin" || helperVerified !== true) return unavailable;
  const axGranted = accessibility === "granted";
  return {
    permission_status: true,
    list_apps: true,
    list_windows: true,
    observe: axGranted,
    screenshot: "probe_required",
    press: axGranted,
    set_value: axGranted,
  };
}

export const COMPUTER_USE_MODEL_GUIDANCE =
  "Computer Use: check permission_status capabilities first and use only methods marked true; " +
  "observe before changing anything; pass the returned semantic_ref to press or set_value; " +
  "inspect the returned effect and evidence, then observe again when the result needs checking. " +
  "Never treat unknown as success. On stale_target, observe again and use a new semantic_ref. " +
  "Coordinate input is not available.";

/** Validate the Helper result at the shared AceVra boundary without promoting its effect. */
export function normalizeComputerUseResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (!COMPUTER_USE_EFFECTS.includes(value.effect)) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (!COMPUTER_USE_ROUTES.includes(value.route) || !Array.isArray(value.evidence)) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (
    value.classification !== undefined &&
    !COMPUTER_USE_CLASSIFICATIONS.includes(value.classification)
  ) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (
    (value.operation === "press" || value.operation === "set_value") &&
    value.classification !== COMPUTER_USE_ACTION_CLASSIFICATIONS[value.operation]
  ) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  return { ...value, evidence: [...value.evidence] };
}

export function validSemanticActionInput(method, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input).sort();
  if (method === "press") {
    return keys.length === 1 && keys[0] === "semantic_ref" && validSemanticRef(input.semantic_ref);
  }
  if (method === "set_value") {
    return (
      keys.length === 2 &&
      keys[0] === "semantic_ref" &&
      keys[1] === "value" &&
      validSemanticRef(input.semantic_ref) &&
      ((typeof input.value === "string" && input.value.length <= 4096) ||
        (typeof input.value === "number" && Number.isFinite(input.value)) ||
        typeof input.value === "boolean")
    );
  }
  return false;
}

export function resolveComputerUseMethod(modelToolName) {
  return Object.hasOwn(COMPUTER_USE_MODEL_TO_METHOD, modelToolName)
    ? COMPUTER_USE_MODEL_TO_METHOD[modelToolName]
    : undefined;
}

function validSemanticRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
