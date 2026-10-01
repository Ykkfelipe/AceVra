// M3: mini Computer workspace projection contract. Split from `contract.ts` so the lease
// authority's own public surface stays capped; only the session view consumes the reader.
//
// 读只读快照（mini Computer 视图数据）。由 authority 用与 bar 相同的活动上报维护；
// 读取是纯操作，绝不触发捕获。
export interface ComputerUseWorkspaceSnapshot {
  readonly workspaceId: string;
  readonly backendId: string;
  readonly state: "idle" | "observing" | "acting" | "paused" | "failed" | "stale";
  readonly target?: {
    readonly pid: number;
    readonly windowId?: number | null;
    readonly appName?: string | null;
  };
  readonly frame?: {
    readonly frameId: string;
    readonly capturedAt: number;
    readonly dimensions?: { readonly width: number; readonly height: number } | null;
    readonly freshness: "fresh" | "superseded" | "stale";
  };
  readonly cursor?: {
    readonly x: number | null;
    readonly y: number | null;
    readonly updatedAt: number;
  };
  readonly action?: {
    readonly method: string;
    readonly label: string;
    readonly targetLabel?: string | null;
    readonly startedAt?: number | null;
    readonly completedAt?: number | null;
    readonly effect?: string | null;
    readonly code?: string | null;
  };
  readonly framesCaptured: number;
  readonly updatedAt: number;
}

/**
 * M3: pure read access to a session's mini Computer projection. Deliberately NOT part of
 * `LeaseAuthority` (whose public surface is capped): the authority implements it structurally
 * and only the session view consumes it.
 */
export interface WorkspaceProjectionReader {
  getWorkspace(sessionId: string): ComputerUseWorkspaceSnapshot | undefined;
}
