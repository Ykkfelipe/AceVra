import type { LeaseAuthority } from "./contract.js";

export type { LeaseAuthority } from "./contract.js";
export { createLeaseAuthority } from "./authority.js";

export const CUA_LEASE_AUTHORITY_CONTRACT_VERSION = "cua-lease-authority/v1" as const;

export function isLeaseAuthority(value: unknown): value is LeaseAuthority {
  return Boolean(
    value &&
    typeof value === "object" &&
    "beginAcquire" in value &&
    "commitAcquire" in value &&
    "release" in value &&
    "stop" in value,
  );
}
