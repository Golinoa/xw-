import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ApiEnvironment } from './auth';
import { corsMiddleware, parseAllowedOrigins } from './cors';

const ALLOWED = 'https://ops.udone.example';
const BLOCKED = 'https://evil.example';

function buildApp() {
  const app = new Hono<ApiEnvironment>();
  app.use('*', corsMiddleware());
  app.get('/api/ping', (context) => context.json({ ok: true }));
  app.post('/api/ping', (context) => context.json({ ok: true }));
  return app;
}

function bindings(allowedOrigins?: string): ApiEnvironment['Bindings'] {
  return { ALLOWED_ORIGINS: allowedOrigins } as ApiEnvironment['Bindings'];
}

function get(origin: string, allowedOrigins?: string) {
  return buildApp().request('/api/ping', { headers: { Origin: origin } }, bindings(allowedOrigins));
}

function preflight(origin: string, allowedOrigins?: string) {
  return buildApp().request(
    '/api/ping',
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,x-organization-id',
      },
    },
    bindings(allowedOrigins),
  );
}

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops trailing slashes', () => {
    expect(parseAllowedOrigins(' https://a.example/ , https://b.example ,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('never allows a wildcard origin', () => {
    expect(parseAllowedOrigins('*')).toEqual([]);
    expect(parseAllowedOrigins('https://a.example,*')).toEqual(['https://a.example']);
  });

  it('treats missing input as an empty allowlist', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
  });
});

describe('corsMiddleware', () => {
  it('echoes an allowed origin instead of using a wildcard', async () => {
    const response = await get(ALLOWED, ALLOWED);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('omits CORS headers for an origin outside the allowlist', async () => {
    const response = await get(BLOCKED, ALLOWED);

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers preflight with the headers the SPA actually sends', async () => {
    const response = await preflight(ALLOWED, ALLOWED);
    const allowedHeaders = (
      response.headers.get('access-control-allow-headers') ?? ''
    ).toLowerCase();

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('x-organization-id');
    expect(allowedHeaders).toContain('idempotency-key');
  });

  it('grants credentials to an allowed origin, with Vary: Origin', async () => {
    const response = await get(ALLOWED, ALLOWED);

    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    // Without Vary a shared cache may hand this response to another origin,
    // which is how a credentials grant leaks.
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });

  it('never grants credentials to an origin outside the allowlist', async () => {
    // This is the assertion that matters most: hono's `credentials: true` sets
    // the header unconditionally, so a blocked origin would be told to send
    // cookies. The response must not claim what the browser will refuse.
    const response = await get(BLOCKED, ALLOWED);

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('ignores a wildcard allowlist entry instead of echoing any origin', async () => {
    for (const allowlist of ['*', `*,${ALLOWED}`]) {
      const response = await get(BLOCKED, allowlist);

      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('grants credentials on the preflight too', async () => {
    const response = await preflight(ALLOWED, ALLOWED);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary') ?? '').toContain('Origin');
  });

  it('grants nothing when no allowlist is configured', async () => {
    expect((await get(ALLOWED, undefined)).headers.get('access-control-allow-origin')).toBeNull();
    expect((await get(ALLOWED, '')).headers.get('access-control-allow-origin')).toBeNull();
    expect(
      (await preflight(ALLOWED, undefined)).headers.get('access-control-allow-origin'),
    ).toBeNull();
    expect(
      (await get(ALLOWED, undefined)).headers.get('access-control-allow-credentials'),
    ).toBeNull();
    expect((await get(ALLOWED, '')).headers.get('access-control-allow-credentials')).toBeNull();
  });
});
