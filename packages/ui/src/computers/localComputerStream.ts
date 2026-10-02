/**
 * LocalComputerPreview stream source (computer-workspace.md "Stream contract and source identity").
 *
 * Pure reducer over `getComputerWorkspaceStream` reads. The Helper's window-scoped SCStream is
 * the only pixel source; the screen-scoped observation projection is never shown here. Rules:
 * - source identity = `generation:pid:windowId`; any identity change or unavailable read drops
 *   the current frame and cursor, so a previous target (Chrome) can never flash after the new
 *   one (Notes) became authoritative;
 * - latest-frame admission by strictly increasing `seq` within one identity (shared contract);
 * - the logical agent cursor comes from the workspace projection (global AX points) and is
 *   positioned against the stream's own window geometry from the SAME read; it is accepted only
 *   with non-decreasing `updatedAt` and hidden when outside the captured window.
 */
import type { CuaWorkspaceStreamResult, CuaWorkspaceView } from "@zcode/services";
import { acceptFrame, createFrameStreamState, type StreamState } from "./computerFrameStream.js";

export interface LocalStreamFrame {
  seq: number;
  capturedAt?: number;
  url: string;
}

export interface LocalStreamCursor {
  /** Percent of the captured window, 0–100. */
  left: number;
  top: number;
  updatedAt: number;
}

export type LocalStreamStatus = "live" | "waiting" | "unavailable";

export interface LocalStreamState {
  identity: string;
  stream: StreamState<LocalStreamFrame>;
  cursor: LocalStreamCursor | null;
  status: LocalStreamStatus;
  reason: string | null;
  workspace: CuaWorkspaceView | null;
  /** Captured window width / height (points), for aligning the cursor over a letterboxed frame. */
  aspectRatio: number | null;
}

export function createLocalStreamState(): LocalStreamState {
  return {
    identity: "",
    stream: createFrameStreamState<LocalStreamFrame>(),
    cursor: null,
    status: "waiting",
    reason: null,
    workspace: null,
    aspectRatio: null,
  };
}

/** Reasons that mean "a target exists, the first fresh frame is on its way". */
const WAITING_REASONS = new Set(["waiting_for_screen", "read_pending"]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Logical cursor (global points) → percent inside the captured window, or null if outside. */
export function localCursorPercent(
  cursor: { x: number | null; y: number | null } | undefined,
  geometry: { originX?: number; originY?: number; pointWidth?: number; pointHeight?: number },
): { left: number; top: number } | null {
  if (!cursor || cursor.x === null || cursor.y === null) return null;
  const { originX, originY, pointWidth, pointHeight } = geometry;
  if (!finite(originX) || !finite(originY) || !finite(pointWidth) || !finite(pointHeight))
    return null;
  if (pointWidth <= 0 || pointHeight <= 0) return null;
  const x = cursor.x - originX;
  const y = cursor.y - originY;
  // 窗口外的坐标不夹到边上：那会把光标画在一个 agent 并未操作的位置。
  if (x < 0 || y < 0 || x > pointWidth || y > pointHeight) return null;
  return { left: (x / pointWidth) * 100, top: (y / pointHeight) * 100 };
}

/** `read_pending` is a coalesced duplicate read: it carries no new facts, keep the state. */
export function reduceLocalStream(
  state: LocalStreamState,
  next: CuaWorkspaceStreamResult,
  now: number = Date.now(),
): LocalStreamState {
  if (next.reason === "read_pending" || next.reason === "superseded") return state;
  const workspace = next.workspace ?? null;
  const identity =
    next.status === "available" && next.generation && finite(next.pid)
      ? `${next.generation}:${next.pid}:${next.windowId ?? 0}`
      : "";
  if (!identity) {
    return {
      ...createLocalStreamState(),
      status:
        workspace?.target && WAITING_REASONS.has(next.reason ?? "waiting_for_screen")
          ? "waiting"
          : workspace?.target
            ? "unavailable"
            : "waiting",
      reason: next.reason ?? null,
      workspace,
    };
  }
  const sameSource = identity === state.identity;
  let stream = sameSource ? state.stream : createFrameStreamState<LocalStreamFrame>();
  if (typeof next.jpeg === "string" && next.jpeg && finite(next.seq)) {
    stream = acceptFrame(
      stream,
      {
        seq: next.seq,
        ...(finite(next.capturedAt) ? { capturedAt: next.capturedAt } : {}),
        url: `data:image/jpeg;base64,${next.jpeg}`,
      },
      now,
    );
  }
  const previousCursor = sameSource ? state.cursor : null;
  const projected = workspace?.cursor;
  let cursor = previousCursor;
  if (projected && (!previousCursor || projected.updatedAt >= previousCursor.updatedAt)) {
    const position = localCursorPercent(projected, next);
    cursor = position ? { ...position, updatedAt: projected.updatedAt } : null;
  } else if (!projected) {
    // 投影在切换 target 时清空光标；这里同步清掉，避免旧目标的光标留在新窗口上。
    cursor = null;
  }
  const aspectRatio =
    finite(next.pointWidth) &&
    finite(next.pointHeight) &&
    next.pointWidth > 0 &&
    next.pointHeight > 0
      ? next.pointWidth / next.pointHeight
      : sameSource
        ? state.aspectRatio
        : null;
  return {
    identity,
    stream,
    cursor,
    status: stream.frame ? "live" : "waiting",
    reason: next.reason ?? null,
    workspace,
    aspectRatio,
  };
}
