import { describe, expect, it } from 'vitest';
import { createFixedWindowRateLimiter } from './rate-limit-store';

function clock(start = 10_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('createFixedWindowRateLimiter', () => {
  it('allows requests up to the limit and reports the remaining budget', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 3, windowMs: 1_000 });

    expect(limiter.check('ip-one')).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.check('ip-one')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check('ip-one')).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('blocks the request that exceeds the limit and asks for a positive wait', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 2, windowMs: 1_000 });

    limiter.check('ip-one');
    limiter.check('ip-one');
    const blocked = limiter.check('ip-one');

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets the budget once the window rolls over', () => {
    const time = clock();
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 1_000, now: time.now });

    expect(limiter.check('ip-one').allowed).toBe(true);
    expect(limiter.check('ip-one').allowed).toBe(false);

    time.advance(1_000);
    expect(limiter.check('ip-one').allowed).toBe(true);
  });

  it('keeps separate budgets per key', () => {
    const limiter = createFixedWindowRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.check('ip-one').allowed).toBe(true);
    expect(limiter.check('ip-one').allowed).toBe(false);
    expect(limiter.check('ip-two').allowed).toBe(true);
  });
});
