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

  it('allows nothing when no allowlist is configured', async () => {
    expect((await get(ALLOWED, undefined)).headers.get('access-control-allow-origin')).toBeNull();
    expect((await get(ALLOWED, '')).headers.get('access-control-allow-origin')).toBeNull();
    expect(
      (await preflight(ALLOWED, undefined)).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('does not grant credentials, since auth travels as a bearer token', async () => {
    const response = await get(ALLOWED, ALLOWED);

    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
