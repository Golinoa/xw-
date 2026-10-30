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
 * The single place that decides whether an origin is allowed. Both the header
 * echo and the credentials decision read it, so the two cannot disagree.
 */
export function allowedOrigin(
  origin: string | undefined,
  allowedOrigins: string | undefined,
): string | null {
  if (!origin) return null;
  const requested = normaliseOrigin(origin);
  if (!requested) return null;
  return parseAllowedOrigins(allowedOrigins).includes(requested) ? requested : null;
}

/**
 * Cross-origin access for the separately hosted admin console.
 * Fails closed: with no ALLOWED_ORIGINS configured, no origin is permitted,
 * which keeps same-origin SPA traffic working without opening the API up.
 *
 * Credentials are granted per origin rather than globally. Hono's
 * `credentials: true` sets `Access-Control-Allow-Credentials: true` on every
 * response, including those from origins that failed the allowlist — so a
 * blocked origin would be told "yes, send cookies" and only the missing
 * `Access-Control-Allow-Origin` would stop it. The response should say one
 * thing, not two contradictory ones.
 *
 * The refresh cookie is why credentials are needed at all: it is `HttpOnly` and
 * scoped to `/api/v1/ops/auth`, so a cross-origin console cannot refresh a
 * session unless the browser is allowed to attach credentials.
 */
export function corsMiddleware(): MiddlewareHandler<ApiEnvironment> {
  const echo = cors({
    origin: (origin, context) => allowedOrigin(origin, context.env.ALLOWED_ORIGINS) ?? '',
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

  return async (context, next) => {
    // hono 的 cors 在 OPTIONS 上直接返回一个新 Response 而不调 next()。那个
    // Response 的头部是构造时拷贝的，之后再改 context.res 影响不到它，所以
    // 必须把返回值接住、改它自己的头部、再原样返回。
    const response: Response | void = await echo(context, next);
    const headers = response instanceof Response ? response.headers : context.res.headers;
    const origin = allowedOrigin(context.req.header('origin'), context.env.ALLOWED_ORIGINS);
    if (origin) headers.set('Access-Control-Allow-Credentials', 'true');
    return response;
  };
}
