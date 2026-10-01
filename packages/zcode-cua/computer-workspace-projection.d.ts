import type { ZeroStealRecord } from "./computer-workspace-backend.js";

/** Lifecycle states of one workspace (projected from real backend events only). */
export type WorkspaceState = "idle" | "observing" | "acting" | "paused" | "failed" | "stale";

export interface WorkspaceTarget {
  pid: number;
  windowId: number | null;
  appName: string | null;
}

/** Frame contract consumed by the M3 mini Computer view. */
export interface WorkspaceFrame {
  /** Observation id from the signed Helper capture; the frame's unique identity. */
  frameId: string;
  workspaceId: string;
  /** Router identity: which backend produced this frame. */
  backendId: string;
  capturedAt: number;
  dimensions: { width: number; height: number } | null;
  /** fresh = post-observation; superseded = a mutation happened after it; stale = target lost. */
  freshness: "fresh" | "superseded" | "stale";
}

export interface WorkspaceCursor {
  x: number | null;
  y: number | null;
  target: WorkspaceTarget | null;
  updatedAt: number;
}

export interface WorkspaceAction {
  method: string;
  label: string;
  targetLabel: string | null;
  startedAt: number | null;
  completedAt: number | null;
  effect: string | null;
  code: string | null;
}

export interface WorkspaceProjectionSnapshot {
  workspaceId: string;
  backendId: string;
  sessionId: string | null;
  taskId: string | null;
  state: WorkspaceState;
  target: WorkspaceTarget | null;
  frame: WorkspaceFrame | null;
  cursor: WorkspaceCursor | null;
  action: WorkspaceAction | null;
  lastZeroSteal: ZeroStealRecord | Record<string, unknown> | null;
  framesCaptured: number;
  updatedAt: number;
}

export interface WorkspaceProjection {
  noteActionStart(input?: { method: string; target?: WorkspaceTarget | null; describe?: string | null }): void;
  noteObservation(input?: { target?: WorkspaceTarget | null; result?: unknown }): void;
  noteActionResult(input?: {
    method: string;
    target?: WorkspaceTarget | null;
    result?: unknown;
    cursor?: { x: number | null; y: number | null } | null;
  }): void;
  notePaused(paused: boolean): void;
  snapshot(): WorkspaceProjectionSnapshot;
}

export declare function createWorkspaceProjection(options: {
  workspaceId: string;
  backendId?: string;
  sessionId?: string | null;
  taskId?: string | null;
  now?: () => number;
}): WorkspaceProjection;
