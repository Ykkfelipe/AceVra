/** The single model-independent Computer Use capability vocabulary. */
export const COMPUTER_USE_METHODS = Object.freeze({
  permission_status: "read",
  list_apps: "read",
  list_windows: "read",
  observe: "read",
  control_status: "read",
  press: "mutation",
  set_value: "mutation",
  acquire_control: "control",
  release_control: "control",
  activate_target: "foreground",
  move_pointer: "foreground",
  click: "foreground",
  type_text: "foreground",
  key_press: "foreground",
  scroll: "foreground",
  drag: "foreground",
});

export const COMPUTER_USE_MODEL_TO_METHOD = Object.freeze({
  list_apps: "list_apps",
  list_windows: "list_windows",
  get_app_state: "observe",
  screenshot: "observe",
  request_access: "permission_status",
  "computer.press": "press",
  "computer.set_value": "set_value",
  "computer.control_status": "control_status",
  "computer.acquire_control": "acquire_control",
  "computer.release_control": "release_control",
  "computer.activate_target": "activate_target",
  "computer.move_pointer": "move_pointer",
  "computer.click": "click",
  "computer.type_text": "type_text",
  "computer.key_press": "key_press",
  "computer.scroll": "scroll",
  "computer.drag": "drag",
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
export const COMPUTER_USE_ROUTES = Object.freeze(["accessibility_action", "quartz_input", "none"]);
export const COMPUTER_USE_ACTION_CLASSIFICATIONS = Object.freeze({
  press: "BEST_EFFORT_BACKGROUND",
  set_value: "BEST_EFFORT_BACKGROUND",
  acquire_control: "REQUIRES_FOREGROUND",
  release_control: "REQUIRES_FOREGROUND",
  activate_target: "REQUIRES_FOREGROUND",
  move_pointer: "REQUIRES_FOREGROUND",
  click: "REQUIRES_FOREGROUND",
  type_text: "REQUIRES_FOREGROUND",
  key_press: "REQUIRES_FOREGROUND",
  scroll: "REQUIRES_FOREGROUND",
  drag: "REQUIRES_FOREGROUND",
});

export const COMPUTER_USE_FOREGROUND_METHODS = Object.freeze([
  "acquire_control",
  "release_control",
  "activate_target",
  "move_pointer",
  "click",
  "type_text",
  "key_press",
  "scroll",
  "drag",
]);

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
    control_status: false,
    ...Object.fromEntries(COMPUTER_USE_FOREGROUND_METHODS.map((method) => [method, false])),
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
    control_status: axGranted,
    ...Object.fromEntries(
      COMPUTER_USE_FOREGROUND_METHODS.map((method) => [
        method,
        axGranted ? "probe_required" : false,
      ]),
    ),
  };
}

export const COMPUTER_USE_MODEL_GUIDANCE =
  "Computer Use: check permission_status capabilities first and use only methods marked true; " +
  "observe before changing anything; pass the returned semantic_ref to press or set_value; " +
  "inspect the returned effect and evidence, then observe again when the result needs checking. " +
  "Never treat unknown as success. On stale_target, observe again and use a new semantic_ref. " +
  "Prefer semantic press/set_value. Foreground input requires explicit exclusive acquisition " +
  "in a local desktop task; observe immediately before coordinate actions and refresh stale geometry. " +
  "A probe_required foreground capability must be checked by acquisition. Unknown application " +
  "effect is not success. On user interruption stop and release ownership; never fight the user.";

/** Validate the Helper result at the shared AceVra boundary without promoting its effect. */
export function normalizeComputerUseResult(value, expectedMethod) {
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
    Object.hasOwn(COMPUTER_USE_ACTION_CLASSIFICATIONS, value.operation) &&
    value.classification !== COMPUTER_USE_ACTION_CLASSIFICATIONS[value.operation]
  ) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (expectedMethod && value.effect !== "refused" && value.operation !== expectedMethod) {
    return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
  }
  if (COMPUTER_USE_FOREGROUND_METHODS.includes(expectedMethod ?? value.operation)) {
    if (value.classification !== "REQUIRES_FOREGROUND") {
      return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
    }
    if (
      !["quartz_input", "none"].includes(value.route) ||
      !["confirmed", "unknown", "none"].includes(value.input_delivery) ||
      !["confirmed", "unknown"].includes(value.application_effect) ||
      value.mode !== "EXCLUSIVE_FOREGROUND"
    ) {
      return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
    }
    if (
      ["click", "type_text", "key_press", "scroll", "drag"].includes(
        expectedMethod ?? value.operation,
      ) &&
      value.effect === "confirmed" &&
      value.application_effect !== "confirmed"
    ) {
      return { effect: "failed", route: "none", evidence: [], code: "invalid_result" };
    }
  }
  return { ...value, evidence: [...value.evidence] };
}

export function validForegroundInput(method, input) {
  if (
    !COMPUTER_USE_FOREGROUND_METHODS.includes(method) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return false;
  const common =
    method === "acquire_control"
      ? ["observation_id"]
      : method === "release_control"
        ? ["lease_id"]
        : ["lease_id", "observation_id"];
  const extras =
    method === "move_pointer" || method === "click"
      ? ["point"]
      : method === "type_text"
        ? ["text"]
        : method === "key_press"
          ? ["key", "modifiers"]
          : method === "scroll"
            ? ["point", "delta_x", "delta_y"]
            : method === "drag"
              ? ["start", "end"]
              : [];
  const wanted = [...common, ...extras].sort();
  const actual = Object.keys(input).sort();
  if (wanted.length !== actual.length || wanted.some((key, index) => key !== actual[index]))
    return false;
  const id = (key) => typeof input[key] === "string" && /^[0-9a-f-]{36}$/u.test(input[key]);
  if (common.some((key) => !id(key))) return false;
  const point = (value) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "x,y" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y);
  if (
    (extras.includes("point") && !point(input.point)) ||
    (extras.includes("start") && (!point(input.start) || !point(input.end)))
  )
    return false;
  if (
    method === "type_text" &&
    (typeof input.text !== "string" ||
      input.text.length === 0 ||
      input.text.length > 512 ||
      input.text.includes("\0"))
  )
    return false;
  if (
    method === "key_press" &&
    (!["return", "tab", "space", "delete", "escape", "left", "right", "down", "up"].includes(
      input.key,
    ) ||
      !Array.isArray(input.modifiers) ||
      input.modifiers.length > 4 ||
      new Set(input.modifiers).size !== input.modifiers.length ||
      !input.modifiers.every((modifier) =>
        ["shift", "control", "option", "command"].includes(modifier),
      ))
  )
    return false;
  if (
    method === "scroll" &&
    (!Number.isFinite(input.delta_x) ||
      !Number.isFinite(input.delta_y) ||
      Math.abs(input.delta_x) > 600 ||
      Math.abs(input.delta_y) > 600 ||
      (input.delta_x === 0 && input.delta_y === 0))
  )
    return false;
  if (
    method === "drag" &&
    Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y) > 1200
  )
    return false;
  return true;
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
