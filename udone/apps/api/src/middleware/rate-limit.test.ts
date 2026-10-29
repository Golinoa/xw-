import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ApiEnvironment } from './auth';
import { errorHandler } from './error-handler';
import { rateLimit } from './rate-limit';
import { createFixedWindowRateLimiter } from '../lib/rate-limit-store';

function buildApp(limit = 2) {
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', rateLimit({ limiter: createFixedWindowRateLimiter({ limit, windowMs: 60_000 }) }));
  app.get('/api/ping', (context) => context.json({ ok: true }));
  return app;
}

function call(app: Hono<ApiEnvironment>, ip: string) {
  return app.request('/api/ping', { headers: { 'cf-connecting-ip': ip } });
}

describe('rate limit middleware', () => {
  it('answers 429 with a retry hint once the budget is spent', async () => {
    const app = buildApp(2);

    expect((await call(app, '203.0.113.10')).status).toBe(200);
    expect((await call(app, '203.0.113.10')).status).toBe(200);

    const blocked = await call(app, '203.0.113.10');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns a contract-shaped error body', async () => {
    const app = buildApp(1);
    await call(app, '203.0.113.11');

    const body = (await (await call(app, '203.0.113.11')).json()) as {
      code: string;
      requestId: string;
    };

    expect(body.code).toBe('RATE_LIMITED');
    expect(body.requestId).toBeTruthy();
  });

  it('tracks each client address separately', async () => {
    const app = buildApp(1);

    expect((await call(app, '203.0.113.20')).status).toBe(200);
    expect((await call(app, '203.0.113.20')).status).toBe(429);
    expect((await call(app, '203.0.113.21')).status).toBe(200);
  });

  it('falls back to the forwarded address when the Cloudflare header is absent', async () => {
    const app = buildApp(1);

    const first = await app.request('/api/ping', {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    });
    const second = await app.request('/api/ping', {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('shares one bucket for callers with no address at all', async () => {
    const app = buildApp(1);

    expect((await app.request('/api/ping')).status).toBe(200);
    expect((await app.request('/api/ping')).status).toBe(429);
  });
});
