import type { MiddlewareHandler } from 'hono';
import { ERROR_CODES } from '@erp/contracts';
import { createFixedWindowRateLimiter, type RateLimiter } from '../lib/rate-limit-store';
import type { ApiEnvironment } from './auth';
import { ApiHttpError } from './error-handler';

const DEFAULT_LIMIT = 60;
const WINDOW_MS = 60_000;

const limiters = new Map<number, RateLimiter>();

function limiterFor(rawLimit: string | undefined): RateLimiter {
  const parsed = Number.parseInt(rawLimit ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
  const cached = limiters.get(limit);
  if (cached) return cached;
  const created = createFixedWindowRateLimiter({ limit, windowMs: WINDOW_MS });
  limiters.set(limit, created);
  return created;
}

export function clientKey(context: Parameters<MiddlewareHandler<ApiEnvironment>>[0]): string {
  const direct = context.req.header('cf-connecting-ip');
  if (direct) return direct;
  const forwarded = context.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || 'unknown';
}

export interface RateLimitOptions {
  limiter?: RateLimiter;
}

/**
 * Global per-client ceiling. Only Cloudflare's connecting-IP header is trusted;
 * the forwarded header is a development fallback because a client can set it.
 */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const limiter = options.limiter ?? limiterFor(context.env.RATE_LIMIT_PER_MINUTE);
    const decision = limiter.check(clientKey(context));

    if (!decision.allowed) {
      context.header('Retry-After', String(decision.retryAfterSeconds));
      throw new ApiHttpError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests');
    }

    await next();
  };
}
