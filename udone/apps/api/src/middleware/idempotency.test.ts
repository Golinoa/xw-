import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryIdempotencyStore } from '../lib/idempotency-store';
import type { ApiEnvironment } from './auth';
import { errorHandler } from './error-handler';
import { idempotency } from './idempotency';

function buildApp(handler: (body: unknown) => Response | Promise<Response>) {
  const calls = vi.fn();
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', idempotency({ store: createMemoryIdempotencyStore() }));
  app.post('/api/invitations', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    calls(body);
    return handler(body);
  });
  app.get('/api/invitations', (context) => {
    calls({ read: true });
    return context.json({ read: true });
  });
  return { app, calls };
}

const VALID_KEY = 'idem-key-0001';

describe('idempotency middleware', () => {
  it('replays the first response instead of running the handler twice', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));

    const first = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Idempotency-Key': VALID_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    const second = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Idempotency-Key': VALID_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });

    expect(calls).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual({ id: 'invitation-1' });
    expect(await second.json()).toEqual({ id: 'invitation-1' });
    expect(second.headers.get('idempotent-replay')).toBe('true');
  });

  it('runs the handler again when the key differs', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(() => Response.json({ id: `invitation-${++sequence}` }));

    await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Idempotency-Key': VALID_KEY },
    });
    await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'idem-key-0002' },
    });

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed key before the handler runs', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    const response = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'short' },
    });

    expect(response.status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });

  it('does not cache a failing response', async () => {
    let sequence = 0;
    const { app, calls } = buildApp(
      () => new Response(JSON.stringify({ message: 'nope' }), { status: 409 }),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      sequence += 1;
      await app.request('/api/invitations', {
        method: 'POST',
        headers: { 'Idempotency-Key': VALID_KEY },
      });
    }

    expect(sequence).toBe(2);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('ignores the key on safe methods', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    await app.request('/api/invitations', { headers: { 'Idempotency-Key': VALID_KEY } });
    await app.request('/api/invitations', { headers: { 'Idempotency-Key': VALID_KEY } });

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('passes through when no key is supplied', async () => {
    const { app, calls } = buildApp(() => Response.json({ ok: true }));

    await app.request('/api/invitations', { method: 'POST' });
    await app.request('/api/invitations', { method: 'POST' });

    expect(calls).toHaveBeenCalledTimes(2);
  });
});
