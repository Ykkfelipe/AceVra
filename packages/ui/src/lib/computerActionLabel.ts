// M3: product-owned Computer action labels.
//
// The transcript and the MiniComputerPanel must show the SAME deterministic label for a given
// Computer operation, derived from method + app locale — and it must NOT depend on the model's
// own reasoning-language `title`. This module is the single source: `computerActionMessageId`
// maps a normalized Computer method to an i18n id; `formatComputerActionLabel` renders it.
// Unknown methods fall back to a stable generic label rather than leaking model text.
//
// Base labels are placeholder-free verb phrases. When the caller has a TRUSTED app name (the
// host-recorded app identity or the workspace projection target — never model text), the
// `chat.computerAction.app.*` variant interpolates it ("Looking at Notes"); without one the base
// label is used, so a dangling "{app}" can never render.

export interface ComputerActionIntl {
  formatMessage(input: { id: string }, values?: Record<string, string>): string;
}

/**
 * Normalized Computer method → i18n id. Covers old `computer_use__<action>` names and the
 * alpha `computer.<action>` facade names; the visible label is product-owned either way.
 */
export const COMPUTER_ACTION_LABEL_IDS: Readonly<Record<string, string>> = Object.freeze({
  list_apps: "chat.computerAction.listApps",
  list_windows: "chat.computerAction.listWindows",
  get_app_state: "chat.computerAction.observe",
  observe: "chat.computerAction.observe",
  screenshot: "chat.computerAction.screenshot",
  request_access: "chat.computerAction.requestAccess",
  permission_status: "chat.computerAction.requestAccess",
  workspace_click: "chat.computerAction.click",
  click: "chat.computerAction.click",
  left_click: "chat.computerAction.click",
  double_click: "chat.computerAction.click",
  doubleclick: "chat.computerAction.click",
  triple_click: "chat.computerAction.click",
  right_click: "chat.computerAction.click",
  workspace_type_text: "chat.computerAction.typeText",
  type_text: "chat.computerAction.typeText",
  type: "chat.computerAction.typeText",
  scroll: "chat.computerAction.scroll",
  workspace_scroll: "chat.computerAction.scroll",
  press: "chat.computerAction.press",
  perform_action: "chat.computerAction.press",
  set_value: "chat.computerAction.setValue",
  select_text: "chat.computerAction.setValue",
  activate_target: "chat.computerAction.openApp",
  open_application: "chat.computerAction.openApp",
  open: "chat.computerAction.openApp",
  acquire_control: "chat.computerAction.acquireControl",
  release_control: "chat.computerAction.releaseControl",
  control_status: "chat.computerAction.checkStatus",
  key_press: "chat.computerAction.keyPress",
  key: "chat.computerAction.keyPress",
  hold_key: "chat.computerAction.holdKey",
  move_pointer: "chat.computerAction.movePointer",
  mouse_move: "chat.computerAction.movePointer",
  move: "chat.computerAction.movePointer",
  drag: "chat.computerAction.drag",
  left_click_drag: "chat.computerAction.drag",
  read_clipboard: "chat.computerAction.readClipboard",
  write_clipboard: "chat.computerAction.writeClipboard",
  wait: "chat.computerAction.wait",
  zoom: "chat.computerAction.zoom",
});

/** The i18n id for a normalized Computer method; unknown → stable generic label. */
export function computerActionMessageId(method: string): string {
  const id = COMPUTER_ACTION_LABEL_IDS[method];
  return id ?? "chat.computerAction.default";
}

/** Base label id → app-interpolated variant ("Looking at {app}"). */
const COMPUTER_ACTION_APP_LABEL_IDS: Readonly<Record<string, string>> = Object.freeze({
  "chat.computerAction.observe": "chat.computerAction.app.observe",
  "chat.computerAction.screenshot": "chat.computerAction.app.screenshot",
  "chat.computerAction.listWindows": "chat.computerAction.app.listWindows",
  "chat.computerAction.click": "chat.computerAction.app.click",
  "chat.computerAction.typeText": "chat.computerAction.app.typeText",
  "chat.computerAction.setValue": "chat.computerAction.app.setValue",
  "chat.computerAction.scroll": "chat.computerAction.app.scroll",
  "chat.computerAction.press": "chat.computerAction.app.press",
  "chat.computerAction.keyPress": "chat.computerAction.app.keyPress",
  "chat.computerAction.openApp": "chat.computerAction.app.openApp",
  "chat.computerAction.default": "chat.computerAction.app.default",
});

/** Whether the label for `method` already names the app (so callers drop a separate app chip). */
export function computerActionLabelIncludesApp(method: string, app?: string | null): boolean {
  return (
    Boolean(app?.trim()) &&
    Object.hasOwn(COMPUTER_ACTION_APP_LABEL_IDS, computerActionMessageId(method))
  );
}

/**
 * Renders the product-owned label for a Computer method (a localized verb phrase). `app` must
 * be a trusted display name; it is interpolated only for methods with an app variant.
 */
export function formatComputerActionLabel(
  intl: ComputerActionIntl,
  method: string,
  options: { app?: string | null } = {},
): string {
  const id = computerActionMessageId(method);
  const app = options.app?.trim();
  const appId = app ? COMPUTER_ACTION_APP_LABEL_IDS[id] : undefined;
  return appId && app ? intl.formatMessage({ id: appId }, { app }) : intl.formatMessage({ id });
}

const COMPUTER_OPERATION_ACTION_PATTERN = /^[a-z0-9_]+$/u;

/**
 * 把一次执行结果里报出的 Computer operation 名字归一化成 `COMPUTER_ACTION_LABEL_IDS`
 * 的 key；不是已知 Computer 操作时返回 undefined。
 *
 * 这是「js cell 是不是一次 Computer Use 动作」的唯一判据。Computer Use 以
 * `mcp__node_repl__js` cell 执行，结果里带回操作名，而 cell 的 input 还带着模型自述的
 * `title`（可能是中文或英文思考文本）。已知操作必须让产品标签胜出；未知的 js cell
 * （用户脚本、自定义 MCP）不在这张表里，继续按普通 cell 展示它的模型标题。
 *
 * 接受三种写法，权威名字表在 `packages/zcode-cua/capability-contract.js`
 * (`COMPUTER_USE_MODEL_TO_METHOD` 的 `computer.<method>` 键与 `computer_use__<action>` 前缀)：
 * 裸方法名、`computer.<method>` facade 名、带 MCP/命名空间前缀的 `…computer_use__<action>`。
 */
export function computerActionMethodFromOperation(operation: string): string | undefined {
  const normalized = operation.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  // 尾部段即动作名：`click` / `computer.click` / `mcp__computer_use__left_click` /
  // `mcp__computer-use__type` / `mcp__plugin_zcode_cua_computer_use__type` 都归到这里。
  const segments = normalized.split("__");
  const last = segments[segments.length - 1] ?? "";
  const action = last.startsWith("computer.") ? last.slice("computer.".length) : last;
  if (!COMPUTER_OPERATION_ACTION_PATTERN.test(action)) {
    return undefined;
  }
  return Object.hasOwn(COMPUTER_ACTION_LABEL_IDS, action) ? action : undefined;
}
