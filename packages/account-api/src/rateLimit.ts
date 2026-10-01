/** Fixed-window in-memory limiter. Single-instance alpha; swap the store for multi-instance. */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Seconds until allowed again if already over the limit, without counting a hit. */
    peek(key: string): number | null {
      const entry = hits.get(key);
      const t = now();
      return entry && entry.resetAt > t && entry.count >= options.limit
        ? Math.ceil((entry.resetAt - t) / 1000)
        : null;
    },
    /** Returns null when allowed, or seconds to wait. */
    check(key: string): number | null {
      const t = now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        hits.set(key, { count: 1, resetAt: t + options.windowMs });
        return null;
      }
      entry.count += 1;
      return entry.count > options.limit ? Math.ceil((entry.resetAt - t) / 1000) : null;
    },
  };
}
