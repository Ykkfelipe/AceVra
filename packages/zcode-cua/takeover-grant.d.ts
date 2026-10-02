export declare const TAKEOVER_WAIT_MS: number;
export declare function requireTakeoverGrant(
  leaseAuthority:
    | {
        requestTakeover?(owner: { session: string; task: string }): Promise<{ state?: string }>;
        takeoverStatus?(owner: { session: string; task: string }): Promise<{ state?: string }>;
      }
    | undefined,
  owner: { session: string; task: string },
  options?: { waitMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<void>;
