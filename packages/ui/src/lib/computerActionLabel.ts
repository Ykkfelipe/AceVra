// M3: product-owned Computer action labels.
//
// The transcript and the MiniComputerPanel must show the SAME deterministic label for a given
// Computer operation, derived from method + app locale — and it must NOT depend on the model's
// own reasoning-language `title`. This module is the single source: `computerActionMessageId`
// maps a normalized Computer method to an i18n id; `formatComputerActionLabel` renders it.
// Unknown methods fall back to a stable generic label rather than leaking model text.
//
// Labels are clean verb phrases (placeholder-free on purpose): the CUA card and the mini panel
// render the target/app NEXT to the verb as their existing chip, so we never interpolate into
// the string and never risk a dangling "{app}" when a value is missing.

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
  press: "chat.computerAction.press",
  perform_action: "chat.computerAction.press",
  set_value: "chat.computerAction.setValue",
  select_text: "chat.computerAction.setValue",
  activate_target: "chat.computerAction.openApp",
  open_application: "chat.computerAction.openApp",
  acquire_control: "chat.computerAction.acquireControl",
  release_control: "chat.computerAction.releaseControl",
  control_status: "chat.computerAction.checkStatus",
  key_press: "chat.computerAction.keyPress",
  key: "chat.computerAction.keyPress",
  hold_key: "chat.computerAction.holdKey",
  move_pointer: "chat.computerAction.movePointer",
  mouse_move: "chat.computerAction.movePointer",
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

/** Renders the product-owned label for a Computer method (a clean, localized verb phrase). */
export function formatComputerActionLabel(intl: ComputerActionIntl, method: string): string {
  return intl.formatMessage({ id: computerActionMessageId(method) });
}
