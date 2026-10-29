export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
}

export interface FixedWindowOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Guards against unbounded growth from spoofed client addresses. */
  maxKeys?: number;
}

/**
 * Fixed-window per-key counter.
 *
 * Scope: one Worker isolate, same caveat as the idempotency store. It stops a
 * single abusive client, not a distributed attack; move to a shared store when
 * the deployment runs enough isolates for the difference to matter.
 */
export function createFixedWindowRateLimiter(options: FixedWindowOptions): RateLimiter {
  const limit = Math.max(1, Math.floor(options.limit));
  const windowMs = Math.max(1, options.windowMs);
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key) {
      const current = now();
      const existing = windows.get(key);

      if (!existing || existing.resetAt <= current) {
        if (windows.size >= maxKeys) prune(windows, current, maxKeys);
        windows.set(key, { count: 1, resetAt: current + windowMs });
        return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
      }

      if (existing.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - current) / 1000)),
        };
      }

      existing.count += 1;
      return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
    },
  };
}

function prune(
  windows: Map<string, { count: number; resetAt: number }>,
  current: number,
  maxKeys: number,
) {
  for (const [key, window] of windows) {
    if (window.resetAt <= current) windows.delete(key);
  }
  // Still full means the limit is under sustained load; drop the oldest inserts.
  if (windows.size >= maxKeys) {
    for (const key of windows.keys()) {
      windows.delete(key);
      if (windows.size <= Math.floor(maxKeys / 2)) break;
    }
  }
}
