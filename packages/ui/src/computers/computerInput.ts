import type { ComputerInputEvent } from "@zcode/shared";

/**
 * Pure mapping for the Computer tab's "Take control" (acevra-agent-computer.md §3.3).
 * The frame is drawn with `object-fit: contain`; pointer coordinates are mapped back to remote
 * screen pixels and points inside the letterbox bars are dropped.
 */
export interface ViewRect {
  width: number;
  height: number;
}

export interface RemoteSize {
  width: number;
  height: number;
}

export function letterbox(view: ViewRect, remote: RemoteSize) {
  const scale = Math.min(view.width / remote.width, view.height / remote.height);
  const drawnWidth = remote.width * scale;
  const drawnHeight = remote.height * scale;
  return {
    scale,
    offsetX: (view.width - drawnWidth) / 2,
    offsetY: (view.height - drawnHeight) / 2,
    drawnWidth,
    drawnHeight,
  };
}

/** View-local point → remote pixel, or null when it falls in the letterbox bars. */
export function mapPointToRemote(
  point: { x: number; y: number },
  view: ViewRect,
  remote: RemoteSize,
): { x: number; y: number } | null {
  if (view.width <= 0 || view.height <= 0 || remote.width <= 0 || remote.height <= 0) return null;
  const box = letterbox(view, remote);
  const localX = point.x - box.offsetX;
  const localY = point.y - box.offsetY;
  if (localX < 0 || localY < 0 || localX > box.drawnWidth || localY > box.drawnHeight) return null;
  return {
    x: Math.min(remote.width - 1, Math.max(0, Math.round(localX / box.scale))),
    y: Math.min(remote.height - 1, Math.max(0, Math.round(localY / box.scale))),
  };
}

/** Remote pixel → view-local point (for drawing the remote cursor on the frame). */
export function mapRemoteToView(
  point: { x: number; y: number },
  view: ViewRect,
  remote: RemoteSize,
): { x: number; y: number } | null {
  if (point.x < 0 || point.y < 0 || remote.width <= 0 || remote.height <= 0) return null;
  const box = letterbox(view, remote);
  return { x: box.offsetX + point.x * box.scale, y: box.offsetY + point.y * box.scale };
}

export function mouseButtonName(button: number): "left" | "right" | "middle" | null {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;
}

/** Mac modifier keys → Windows (pyautogui) names: Cmd → ctrl, Option → alt. */
const MODIFIER_BY_CODE: Record<string, string> = {
  MetaLeft: "ctrl",
  MetaRight: "ctrl",
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  AltLeft: "alt",
  AltRight: "alt",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

const NAMED_KEYS: Record<string, string> = {
  Enter: "enter",
  NumpadEnter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "esc",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Space: "space",
  CapsLock: "capslock",
};

export interface KeyLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

/** `Ctrl+Option+Esc` gives control back (never forwarded). */
export function isGiveBackChord(event: KeyLike): boolean {
  return event.code === "Escape" && event.ctrlKey && event.altKey;
}

function keyNameFromCode(code: string): string | null {
  if (NAMED_KEYS[code]) return NAMED_KEYS[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  const punctuation: Record<string, string> = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };
  return punctuation[code] ?? null;
}

const SAFE_KEY_NAME = /^[a-z0-9]{1,24}$/;
// 组合键里的标点（如 Ctrl+Shift+;）：pyautogui 接受单字符键名，worker 端用 KEYBOARD_KEYS 校验；
// 这里只放行显式列出的可打印 ASCII 符号，其余仍丢弃（spec §3.3）。
const SAFE_PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);

/** True when a mapped key name may be forwarded to the worker (letters/digits/named/punctuation). */
export function isSafeKeyName(name: string): boolean {
  return SAFE_KEY_NAME.test(name) || (name.length === 1 && SAFE_PUNCTUATION.has(name));
}

/**
 * One keyboard event → worker input events. Printable characters without Cmd/Control/Option are
 * sent as `text` (layout-correct); modifiers mirror down/up; other keys become down/up with
 * pyautogui names. Returns [] for keys that cannot be mapped (they are still swallowed).
 */
export function mapKeyEvent(event: KeyLike, phase: "down" | "up"): ComputerInputEvent[] {
  const modifier = MODIFIER_BY_CODE[event.code];
  if (modifier) return [{ kind: phase === "down" ? "keydown" : "keyup", key: modifier }];
  const chorded = event.metaKey || event.ctrlKey || event.altKey;
  const printable = event.key.length === 1;
  if (printable && !chorded) {
    return phase === "down" ? [{ kind: "text", text: event.key }] : [];
  }
  const name = keyNameFromCode(event.code);
  // 无法映射的键仍然吞掉；标点现在按单字符键名转发（与 worker 的 KEYBOARD_KEYS 一致）。
  if (!name || !isSafeKeyName(name)) return [];
  return [{ kind: phase === "down" ? "keydown" : "keyup", key: name }];
}

/** Latest-wins move throttle (≤ hz); buttons/keys are never throttled. */
export function createMoveThrottle(
  hz: number,
  send: (event: ComputerInputEvent) => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  now: () => number = () => Date.now(),
) {
  const interval = 1000 / hz;
  let last = 0;
  let pending: { x: number; y: number } | null = null;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!pending) return;
    last = now();
    send({ kind: "move", ...pending });
    pending = null;
  };
  return {
    move(point: { x: number; y: number }) {
      pending = point;
      const wait = interval - (now() - last);
      if (wait <= 0) flush();
      else if (!scheduled) {
        scheduled = true;
        schedule(flush, wait);
      }
    },
    /** Sends any pending move first so a click lands where the pointer is. */
    flush,
    cancel() {
      pending = null;
    },
  };
}

/** Wheel deltaY (pixels or lines) → wheel clicks, positive = down. */
export function wheelClicks(deltaY: number, deltaMode: number): number {
  const lines = deltaMode === 1 ? deltaY : deltaY / 40;
  const clicks = Math.round(lines / 3);
  if (clicks === 0 && Math.abs(deltaY) > 0) return deltaY > 0 ? 1 : -1;
  return Math.max(-10, Math.min(10, clicks));
}
