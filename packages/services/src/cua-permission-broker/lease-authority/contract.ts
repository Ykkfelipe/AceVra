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

export interface LeaseAuthority {
  beginAcquire(owner: { session: string; task: string }): Promise<LeaseRecord>;
  commitAcquire(
    leaseId: string,
    helperLeaseId: string,
    helperRequirement: string,
  ): Promise<LeaseRecord>;
  release(leaseId: string, reason?: string): Promise<LeaseRecord>;
  stop(): Promise<{ status: "released" | "already_stopped"; record?: LeaseRecord }>;
  getStatus(): LeaseRecord | undefined;
  close(): Promise<void>;
}
