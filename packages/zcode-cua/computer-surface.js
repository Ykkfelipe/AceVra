// Canonical model-visible Computer Use surface (specs/computer-workspace.md "Model-visible API
// surface"). Pure data + discovery; no node builtins, no Helper access.

/**
 * Canonical model-visible Computer Use surface: the exact `agent.computerUse[name](args)` names,
 * argument shapes and kinds. One table feeds the facade's enumerable keys, `describe()`, and the
 * runtime's refusal hints, so the model never has to guess names or shapes.
 * kind: "read" (no state change), "background" (never takes the user's foreground; may act while
 * the user keeps working), "foreground" (needs the local desktop lease from computer.acquire_control).
 */
export const COMPUTER_USE_SURFACE = Object.freeze([
  {
    name: "list_apps",
    kind: "read",
    args: "{}",
    returns: "running apps with pid, bundle_id, name",
  },
  {
    name: "list_windows",
    kind: "read",
    args: "{}",
    returns: "windows with window_id, pid, owner, title",
  },
  {
    name: "get_app_state",
    kind: "read",
    args: "{ pid: integer }",
    returns:
      "result.content[0].text is JSON: { pid, tree: { observation_id, elements: [{ index, role, label, value, semantic_ref, frame, actions }] } }",
  },
  {
    name: "screenshot",
    kind: "read",
    args: "{ pid: integer }",
    returns: "same as get_app_state, with an image",
  },
  { name: "request_access", kind: "read", args: "{}", returns: "permission and capability status" },
  {
    name: "computer.press",
    kind: "background",
    args: "{ semantic_ref: string }",
    note: "AXPress an observed control (button, tab, menu item); semantic_ref from the latest get_app_state",
  },
  {
    name: "computer.set_value",
    kind: "background",
    args: "{ semantic_ref: string, value: string | number | boolean }",
    note: "replace the value of an observed writable field (text field, search field)",
  },
  {
    name: "computer.workspace_click",
    kind: "background",
    args: "{ pid: integer, target_role: string, target_label: string }",
    note: "AXPress the unique element with that role and label in the app's window",
  },
  {
    name: "computer.workspace_type_text",
    kind: "background",
    args: "{ pid: integer, text: string, target_label?: string }",
    note: "type into the focused (or labelled) text field without activating the app",
  },
  {
    name: "computer.workspace_scroll",
    kind: "background",
    args: "{ pid: integer, delta: number }",
    note: "scrollbar fraction from -1 to 1, positive down; needs a unique writable scrollbar",
  },
  {
    name: "computer.open_app",
    kind: "background",
    args: "{ bundle_id: string }",
    returns: "pid, usable_windows count, foreground settle evidence",
    note: "launch an app in the background, or recreate a window for an app that is running windowless (e.g. Chrome after the red X keeps the process alive). Call this BEFORE observing when list_apps shows the app but list_windows shows no usable window for it, or when the app is not running at all",
  },
  {
    name: "computer.acquire_control",
    kind: "foreground",
    args: "{ observation_id: string }",
    note: "returns lease_id; takes the user's foreground",
  },
  { name: "computer.control_status", kind: "read", args: "{ lease_id: string }" },
  { name: "computer.release_control", kind: "foreground", args: "{ lease_id: string }" },
  {
    name: "computer.activate_target",
    kind: "foreground",
    args: "{ lease_id: string, observation_id: string }",
  },
  {
    name: "computer.move_pointer",
    kind: "foreground",
    args: "{ lease_id, observation_id, point: { x, y } }",
  },
  {
    name: "computer.click",
    kind: "foreground",
    args: "{ lease_id, observation_id, point: { x, y } }",
  },
  {
    name: "computer.type_text",
    kind: "foreground",
    args: "{ lease_id, observation_id, text: string (1–512 chars) }",
  },
  {
    name: "computer.key_press",
    kind: "foreground",
    args: "{ lease_id, observation_id, key: return|tab|space|delete|escape|left|right|down|up, modifiers: (shift|control|option|command)[] }",
  },
  {
    name: "computer.scroll",
    kind: "foreground",
    args: "{ lease_id, observation_id, point: { x, y }, delta_x, delta_y }",
  },
  {
    name: "computer.drag",
    kind: "foreground",
    args: "{ lease_id, observation_id, start: { x, y }, end: { x, y } }",
  },
]);

/** Known limits the model must know before planning (stated once, not discovered by failure). */
export const COMPUTER_USE_LIMITS = Object.freeze([
  "Background actions cannot press keys: there is no background Enter/Tab/shortcut. To submit a field in the background, press an observed submit/search control, or set a full value that does not need Enter. Keys need foreground control (computer.acquire_control → lease_id → computer.key_press).",
  "Every state-changing call uses a semantic_ref or pid from the LATEST get_app_state of that app; refs from older observations are refused as stale_target.",
  "Do not drive apps with osascript/AppleScript, shell `open`, or other scripting from Bash for a Computer Use task: it bypasses the background guarantees and can steal the user's foreground. If a step is unsupported in the background, say so and ask whether to use foreground control.",
]);

/** Unambiguous historical spellings accepted for the two semantic actions. */
export const COMPUTER_USE_COMPAT_ALIASES = Object.freeze({
  press: "computer.press",
  set_value: "computer.set_value",
});

/** Maps a compatibility alias to its canonical model-visible name (identity otherwise). */
export function canonicalComputerUseName(modelToolName) {
  return Object.hasOwn(COMPUTER_USE_COMPAT_ALIASES, modelToolName)
    ? COMPUTER_USE_COMPAT_ALIASES[modelToolName]
    : modelToolName;
}

/** The argument shape the canonical surface documents for a model-visible name. */
export function computerUseArgsHint(modelToolName) {
  const name = canonicalComputerUseName(modelToolName);
  return COMPUTER_USE_SURFACE.find((entry) => entry.name === name)?.args;
}

/**
 * Canonical discovery payload for `await agent.computerUse.describe()`: the exact surface, this
 * session's real availability and the known limits.
 *
 * `mcp_tool` 修复依据（preview-ux-946d1e2 实测）：模型同时看到两种拼写——技能文档里的
 * 点号名（computer.open_app）与 MCP 工具的合法名字（点号被 sanitize 成下划线）。找不到
 * 对应关系时模型会去 grep 运行时源码找"raw bridge"，把整个回合耗在猜调用方式上。这里在
 * describe() 里直接给出每个方法对应的 MCP 工具名，消除第二次猜名。
 */
export function describeComputerUseSurface({ platform, foregroundAvailable }) {
  const surface = {
    call: 'await agent.computerUse["<name>"](args)  // e.g. agent.computerUse["computer.press"]({ semantic_ref })',
    platform,
    available: platform === "darwin",
    foregroundAvailable,
    methods: COMPUTER_USE_SURFACE.map((entry) => ({
      ...entry,
      mcp_tool: `mcp__computer-use__${entry.name.replace(/[^a-zA-Z0-9_-]/gu, "_")}`,
      available: platform === "darwin" && (entry.kind !== "foreground" || foregroundAvailable),
    })),
    limits: COMPUTER_USE_LIMITS,
  };
  return { content: [{ type: "text", text: JSON.stringify(surface) }], structuredContent: surface };
}

export const MODEL_TOOL_HINT = `supported tools: ${COMPUTER_USE_SURFACE.map((entry) => entry.name).join(", ")}. Call \`await agent.computerUse.describe()\` for each tool's exact arguments.`;

/** Refusal text that names the expected shape, so a bad call is fixed in one step, not guessed. */
export function argsRefusal(toolName, method) {
  const hint = computerUseArgsHint(toolName);
  const extra =
    method === "press" || method === "set_value"
      ? " with a semantic_ref from the latest get_app_state"
      : method !== "acquire_control"
        ? " (foreground: first `computer.acquire_control({ observation_id })` returns the lease_id)"
        : "";
  return `${toolName || method} expects ${hint ?? "different arguments"}${extra}. See \`await agent.computerUse.describe()\`.`;
}

/**
 * Foreground Computer Use is available only in a local main desktop-continuous task whose host
 * owns the foreground capability (the same predicate gates calls and `describe()`).
 */
export function foregroundComputerUseAvailable(context, allowForegroundControl) {
  return (
    typeof allowForegroundControl === "function" &&
    allowForegroundControl() === true &&
    context?.runtimeScope === "main" &&
    context?.clientMode === "desktop-continuous" &&
    context?.deliveryKind === "desktop-continuous" &&
    !context?.remoteSessionId
  );
}
