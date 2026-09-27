/** Positively identified Helper target data for one observation (CUA-4). */
export interface ComputerUseTargetIdentity {
  pid: number;
  windowId?: number;
  app?: string;
  bundleId?: string;
  window?: string;
}

/**
 * Per-runtime-session target identity bookkeeping. Only pids/windows the Helper actually listed
 * in this runtime session are remembered; an unlisted target is reported by pid only.
 */
export interface SessionIdentityRegistry {
  remember(sessionId: string, method: string, raw: unknown): void;
  target(
    sessionId: string,
    args: { pid?: unknown; window_id?: unknown } | undefined,
  ): ComputerUseTargetIdentity | undefined;
  forget(sessionId: string): void;
}

export declare function createSessionIdentityRegistry(): SessionIdentityRegistry;
