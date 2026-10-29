import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { ApiEnvironment } from './auth';

/**
 * Normalises a comma-separated allowlist. Origin matching is exact, so a trailing
 * slash or a stray wildcard would silently widen access; both are stripped here.
 * A wildcard is never allowed because the API is called with bearer tokens.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value.length > 0 && value !== '*');
}

function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * Cross-origin access for the separately hosted admin console.
 * Fails closed: with no ALLOWED_ORIGINS configured, no origin is permitted,
 * which keeps same-origin SPA traffic working without opening the API up.
 */
export function corsMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return cors({
    origin: (origin, context) => {
      if (!origin) return '';
      const requested = normaliseOrigin(origin);
      const allowed = parseAllowedOrigins(context.env.ALLOWED_ORIGINS);
      return allowed.includes(requested) ? requested : '';
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'X-Organization-ID',
      'Idempotency-Key',
      'X-Request-ID',
    ],
    exposeHeaders: ['X-Request-ID', 'Retry-After'],
    maxAge: 600,
    credentials: false,
  });
}
