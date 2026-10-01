import type { ComputerInputEvent } from "@zcode/shared";

/** Minimal socket surface (the `ws` package in production, a fake in tests). */
export interface ViewSocket {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}
export type OpenViewSocket = (url: string, headers: Record<string, string>) => ViewSocket;

const OPEN = 1;

export interface ViewFrameMeta {
  seq: number;
  /** Producer capture timestamp (epoch ms) — absent on older workers. */
  capturedAt?: number;
  width: number;
  height: number;
  sw: number;
  sh: number;
  cx: number;
  cy: number;
}

export interface ViewCursorUpdate {
  seq: number;
  x: number;
  y: number;
}

export interface ViewStreamProfile {
  fps: number;
  maxWidth: number;
  quality: number;
}

export const WATCH_PROFILE: ViewStreamProfile = { fps: 5, maxWidth: 960, quality: 60 };
export const CONTROL_PROFILE: ViewStreamProfile = { fps: 15, maxWidth: 1366, quality: 65 };

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function parseFrameMeta(value: Record<string, unknown>): ViewFrameMeta | null {
  const seq = num(value.seq);
  const width = num(value.width);
  const height = num(value.height);
  const sw = num(value.sw);
  const sh = num(value.sh);
  if (seq === null || !width || !height || !sw || !sh) return null;
  const capturedAt = num(value.captured_at);
  return {
    seq,
    ...(capturedAt !== null ? { capturedAt } : {}),
    width,
    height,
    sw,
    sh,
    cx: num(value.cx) ?? -1,
    cy: num(value.cy) ?? -1,
  };
}

/**
 * One `/ws/view` socket: frames (meta text + one binary JPEG) and human input. Opened only while
 * the Computer tab is visible (ref-counted by the service) and closed when the last viewer leaves,
 * so the worker's capture thread runs only while someone watches.
 */
export function createComputerViewStream(deps: {
  url: string;
  token: string;
  open: OpenViewSocket;
  profile: ViewStreamProfile;
  onFrame: (meta: ViewFrameMeta, jpeg: Buffer) => void;
  onCursor?: (cursor: ViewCursorUpdate) => void;
  onState?: (job: Record<string, unknown> | null) => void;
  onInputError?: (code: string, reason: string | null) => void;
  onClose: () => void;
}) {
  let profile = deps.profile;
  let pendingMeta: ViewFrameMeta | null = null;
  let closed = false;
  const socket = deps.open(deps.url, { "x-acevra-token": deps.token });

  const sendJson = (value: unknown) => {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(value));
  };
  const sendProfile = () =>
    sendJson({
      t: "view",
      fps: profile.fps,
      max_width: profile.maxWidth,
      quality: profile.quality,
    });

  socket.on("open", sendProfile);
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      if (pendingMeta) deps.onFrame(pendingMeta, data);
      pendingMeta = null;
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.t === "frame") pendingMeta = parseFrameMeta(message);
    else if (message.t === "cursor") {
      const seq = num(message.seq);
      const x = num(message.x);
      const y = num(message.y);
      if (seq !== null && x !== null && y !== null) deps.onCursor?.({ seq, x, y });
    } else if (message.t === "state")
      deps.onState?.((message.job as Record<string, unknown> | null) ?? null);
    else if (message.t === "error")
      deps.onInputError?.(
        typeof message.code === "string" ? message.code : "error",
        typeof message.reason === "string" ? message.reason : null,
      );
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    deps.onClose();
  });

  return {
    setProfile(next: ViewStreamProfile) {
      if (next.fps === profile.fps && next.maxWidth === profile.maxWidth) return;
      profile = next;
      sendProfile();
    },
    sendInput(jobId: string, events: ComputerInputEvent[]) {
      for (const ev of events) sendJson({ t: "input", job_id: jobId, ev });
    },
    isOpen: () => socket.readyState === OPEN,
    close() {
      closed = true;
      socket.close();
    },
  };
}
export type ComputerViewStream = ReturnType<typeof createComputerViewStream>;

const BUTTONS = new Set(["left", "right", "middle"]);
const KEY_NAME = /^[a-z0-9]{1,24}$/;
// 与 renderer computerInput.isSafeKeyName 相同的显式标点集合（跨包不复用 UI 内部模块）；
// worker 端最终用 pyautogui.KEYBOARD_KEYS 校验，单字符键名合法。
const PUNCTUATION = new Set(["-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "`"]);
const isSafeKeyName = (name: string) =>
  KEY_NAME.test(name) || (name.length === 1 && PUNCTUATION.has(name));
const coord = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 16_384;

/** Validates renderer input before it reaches the socket; anything unexpected is dropped. */
export function sanitizeInputEvent(raw: unknown): ComputerInputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as Record<string, unknown>;
  switch (ev.kind) {
    case "move":
      return coord(ev.x) && coord(ev.y)
        ? { kind: "move", x: ev.x as number, y: ev.y as number }
        : null;
    case "down":
    case "up":
      return coord(ev.x) && coord(ev.y) && BUTTONS.has(ev.button as string)
        ? {
            kind: ev.kind,
            x: ev.x as number,
            y: ev.y as number,
            button: ev.button as "left" | "right" | "middle",
          }
        : null;
    case "dblclick":
      return coord(ev.x) && coord(ev.y)
        ? { kind: "dblclick", x: ev.x as number, y: ev.y as number, button: "left" }
        : null;
    case "scroll":
      return coord(ev.x) &&
        coord(ev.y) &&
        Number.isInteger(ev.dy) &&
        Math.abs(ev.dy as number) <= 50
        ? { kind: "scroll", x: ev.x as number, y: ev.y as number, dy: ev.dy as number }
        : null;
    case "keydown":
    case "keyup":
      return typeof ev.key === "string" && isSafeKeyName(ev.key)
        ? { kind: ev.kind, key: ev.key }
        : null;
    case "text":
      return typeof ev.text === "string" && ev.text.length > 0 && ev.text.length <= 200
        ? { kind: "text", text: ev.text }
        : null;
    case "release":
      return { kind: "release" };
    default:
      return null;
  }
}
