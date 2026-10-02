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
    args: "{ pid: integer, window_id?: integer }",
    returns:
      "result.content[0].text is JSON: { pid, tree: { observation_id, elements: [{ index, role, label, value, semantic_ref, frame, actions }] }, foreground_geometry?: { observation_id, window_bounds } } — foreground_geometry.observation_id (lowercase, valid 3 s) is the ONLY id computer.acquire_control accepts, and the Helper issues it only when you pass window_id (from list_windows) for the app you are observing; with pid alone the field is absent and acquire_control will refuse without asking the user",
  },
  {
    name: "screenshot",
    kind: "read",
    args: "{ pid: integer, window_id?: integer }",
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
    name: "computer.workspace_confirm",
    kind: "background",
    args: "{ pid: integer, target_label?: string }",
    note: "press Enter inside the addressed text field via AXConfirm (background submit); use it after workspace_type_text when a field needs confirmation, e.g. Chrome's address bar. Verified by the window title changing",
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
    args: "{ observation_id: string /* foreground_geometry.observation_id, not tree.observation_id */ }",
    note: 'asks the user to Allow screen takeover (an Allow/Deny card appears in AceVra; waits up to 25 s, so give that js call timeout_ms of at least 40000). The id must come from a get_app_state taken with an explicit window_id (see get_app_state): without one the Helper issues no foreground_geometry and this call is refused with foreground_geometry_unavailable WITHOUT asking the user. If it had to wait for the user it returns takeover_allowed_reobserve: call get_app_state again and immediately repeat acquire_control with the new observation_id (no second card). On success it returns protectedForeground: "active" — there is no lease id to keep: AceVra holds the approval for this task and re-establishes the native control itself if its Helper restarts. Only when a step cannot be done in the background. While you hold it the user\'s screen glows; any real mouse/keyboard input, Esc or Stop ends it',
  },
  {
    name: "computer.control_status",
    kind: "read",
    args: "{}",
    returns: "protectedForeground: active | reacquiring | inactive",
  },
  { name: "computer.release_control", kind: "foreground", args: "{}" },
  {
    name: "computer.activate_target",
    kind: "foreground",
    args: "{ observation_id: string }",
  },
  {
    name: "computer.move_pointer",
    kind: "foreground",
    args: "{ observation_id, point: { x, y } }",
  },
  {
    name: "computer.click",
    kind: "foreground",
    args: "{ observation_id, point: { x, y } }",
  },
  {
    name: "computer.type_text",
    kind: "foreground",
    args: "{ observation_id, text: string (1–512 chars) }",
  },
  {
    name: "computer.key_press",
    kind: "foreground",
    args: "{ observation_id, key: return|tab|space|delete|escape|left|right|down|up|a-z|0-9, modifiers: (shift|control|option|command)[] }",
  },
  {
    name: "computer.scroll",
    kind: "foreground",
    args: "{ observation_id, point: { x, y }, delta_x, delta_y }",
  },
  {
    name: "computer.drag",
    kind: "foreground",
    args: "{ observation_id, start: { x, y }, end: { x, y } }",
  },
]);

/** Known limits the model must know before planning (stated once, not discovered by failure). */
export const COMPUTER_USE_LIMITS = Object.freeze([
  "Background actions cannot press arbitrary keys, but a FIELD CAN BE SUBMITTED: after workspace_type_text, call computer.workspace_confirm({ pid, target_label? }) to press Enter inside that field (AX confirm, then a Return key event posted to the app process; verified by the window title changing). Proven dead ends on Chrome — do not retry: the address bar does not navigate on value-set, and the new-tab page has no AXPressable submit control. Other keys or coordinate input need the user's screen: only when a step truly cannot be done in the background, call computer.acquire_control({ observation_id }) — the user must Allow screen takeover in AceVra. If they decline or do not answer, stop and tell them which step needs their hands; never retry in a loop.",
  "Every state-changing call uses a semantic_ref or pid from the LATEST get_app_state of that app; refs from older observations are refused as stale_target.",
  "Do not drive apps with osascript/AppleScript, shell `open`, or other scripting from Bash for a Computer Use task: it bypasses the background guarantees and can steal the user's foreground. If a step is unsupported in the background, ask for screen takeover with computer.acquire_control (the user approves it in AceVra) or say so and stop.",
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
        ? " (foreground: first `computer.acquire_control({ observation_id })`; no lease id is passed — AceVra keeps it)"
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
