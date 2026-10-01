// CUA lease authority contract. The service owns admission, generation, and terminal state.
export type LeaseState = "reserving" | "active" | "releasing" | "released" | "stopped";
export const ZCODE_CUA_LEASE_AUTHORITY_SOCKET_ENV = "ZCODE_CUA_LEASE_AUTHORITY_SOCKET";

export interface LeaseRecord {
  readonly leaseId: string;
  readonly ownerSession: string;
  readonly ownerTask: string;
  readonly generation: number;
  readonly state: LeaseState;
  readonly helperLeaseId?: string;
  readonly helperRequirement?: string;
}

/** Why the most recent lease ended (CUA-4). Kept beside the record so its shape stays stable. */
export interface LeaseTermination {
  readonly leaseId: string;
  readonly reason: string;
  readonly at: number;
}

/** Desktop-level Computer Use admission. Only the owning UI may pause or resume. */
export interface LeaseAdmission {
  readonly paused: boolean;
  readonly pausedAt?: number;
}

/** Target identity the runtime positively resolved from Helper list/observe results. */
export interface ComputerUseTargetReport {
  readonly pid?: number;
  readonly windowId?: number;
  readonly app?: string;
  readonly bundleId?: string;
  readonly window?: string;
}

export interface ComputerUseObservationReport {
  readonly id: string;
  readonly width?: number;
  readonly height?: number;
  readonly blank?: boolean;
  /** Host-internal Helper frame path; never leaves services except as confined frame bytes. */
  readonly framePath?: string;
}

/** Best-effort runtime activity report over the authenticated sideband. */
export interface ComputerUseActivityReport {
  readonly session: string;
  readonly task: string;
  readonly callId: string;
  readonly phase: "started" | "completed";
  readonly method: string;
  readonly at: number;
  readonly effect?: string;
  readonly route?: string;
  readonly code?: string;
  readonly inputDelivery?: string;
  readonly applicationEffect?: string;
  readonly target?: ComputerUseTargetReport;
  readonly observation?: ComputerUseObservationReport;
  /**
   * M3: where a workspace click addressed, in the target window's own coordinate space
   * (explicit point or the Helper-resolved element center). Display-only; never the
   * physical macOS cursor.
   */
  readonly workspaceCursor?: { readonly x?: number; readonly y?: number };
}

export interface ComputerUseActivityRecord {
  readonly callId: string;
  readonly task: string;
  readonly method: string;
  readonly phase: "started" | "completed";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly effect?: string;
  readonly route?: string;
  readonly code?: string;
  readonly inputDelivery?: string;
  readonly applicationEffect?: string;
}

export interface ComputerUseObservationRecord {
  readonly id: string;
  readonly capturedAt: number;
  readonly width?: number;
  readonly height?: number;
  readonly blank?: boolean;
  readonly target?: ComputerUseTargetReport;
  readonly framePath?: string;
}

/** Latest activity and observation for one owner session; never shared across sessions. */
export interface ComputerUseSessionRecord {
  readonly sessionId: string;
  readonly activity?: ComputerUseActivityRecord;
  readonly observation?: ComputerUseObservationRecord;
}

export interface LeaseAuthority {
  beginAcquire(owner: { session: string; task: string }): Promise<LeaseRecord>;
  commitAcquire(
    leaseId: string,
    helperLeaseId: string,
    helperRequirement: string,
  ): Promise<LeaseRecord>;
  release(leaseId: string, reason?: string): Promise<LeaseRecord>;
  stop(): Promise<{ status: "released" | "already_stopped"; record?: LeaseRecord }>;
  /** Gate new Computer Use work and release an active lease through the Helper. */
  pause(): Promise<{ status: "paused" | "already_paused"; released: boolean }>;
  /** Lift the gate only; foreground work must acquire again through normal admission. */
  resume(): Promise<{ status: "resumed" | "not_paused" }>;
  getAdmission(): LeaseAdmission;
  getLastTermination(): LeaseTermination | undefined;
  reportActivity(report: ComputerUseActivityReport): void;
  getSession(sessionId: string): ComputerUseSessionRecord | undefined;
  getStatus(): LeaseRecord | undefined;
  close(): Promise<void>;
}
