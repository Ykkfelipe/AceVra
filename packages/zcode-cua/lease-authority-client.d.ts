export interface LeaseRecord {
  leaseId: string;
  ownerSession: string;
  ownerTask: string;
  generation: number;
  state: "reserving" | "active" | "releasing" | "released" | "stopped";
  helperRequirement?: string;
}

export interface LeaseAuthorityClient {
  beginAcquire(owner: { session: string; task: string }): Promise<LeaseRecord>;
  commitAcquire(leaseId: string, helperRequirement: string): Promise<LeaseRecord>;
  release(leaseId: string, reason?: string): Promise<LeaseRecord>;
  stop(): Promise<{ status: "released" | "already_stopped"; record?: LeaseRecord }>;
}

export declare function createLeaseAuthorityClient(
  env?: Record<string, string | undefined>,
): LeaseAuthorityClient | undefined;
export declare function tokenMatches(presented: unknown, expected: unknown): boolean;
