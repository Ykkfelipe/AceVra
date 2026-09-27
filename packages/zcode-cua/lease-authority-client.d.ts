export interface LeaseRecord {
  leaseId: string;
  ownerSession: string;
  ownerTask: string;
  generation: number;
  state: "reserving" | "active" | "releasing" | "released" | "stopped";
  helperRequirement?: string;
}

export interface LeaseAuthorityAdmission {
  paused: boolean;
  pausedAt?: number;
}

export interface ComputerUseActivityReport {
  session: string;
  task: string;
  callId: string;
  phase: "started" | "completed";
  method: string;
  at: number;
  effect?: string;
  route?: string;
  code?: string;
  inputDelivery?: string;
  applicationEffect?: string;
  target?: { pid?: number; windowId?: number; app?: string; bundleId?: string; window?: string };
  observation?: {
    id: string;
    width?: number;
    height?: number;
    blank?: boolean;
    framePath?: string;
  };
}

export interface LeaseAuthorityClient {
  beginAcquire(owner: { session: string; task: string }): Promise<LeaseRecord>;
  commitAcquire(leaseId: string, helperRequirement: string): Promise<LeaseRecord>;
  release(leaseId: string, reason?: string): Promise<LeaseRecord>;
  stop(): Promise<{ status: "released" | "already_stopped"; record?: LeaseRecord }>;
  /** CUA-4: read-only desktop admission (pause gate). Bounded. */
  admission(): Promise<LeaseAuthorityAdmission>;
  /** CUA-4: best-effort activity projection. Bounded; never authorizes anything. */
  reportActivity(report: ComputerUseActivityReport): Promise<{ accepted: true }>;
}

export declare function createLeaseAuthorityClient(
  env?: Record<string, string | undefined>,
): LeaseAuthorityClient | undefined;
export declare function tokenMatches(presented: unknown, expected: unknown): boolean;
