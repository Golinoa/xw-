import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { RouteResponse } from '@erp/contracts';
import { respond } from '../lib/contract';
import type { ApiEnvironment } from '../middleware/auth';
import { errorHandler } from '../middleware/error-handler';

function buildApp(handler: (context: Parameters<typeof respond>[0]) => Response) {
  const app = new Hono<ApiEnvironment>();
  app.use('*', async (context, next) => {
    context.set('requestId', 'request-fixture');
    await next();
  });
  app.get('/api/me', handler);
  app.onError(errorHandler);
  return app;
}

describe('outbound response guard', () => {
  it('returns the validated payload and strips fields outside the contract', async () => {
    const app = buildApp((context) =>
      respond(context, 'me', {
        userId: 'user-1',
        memberships: [],
        leakedInternalField: 'should-not-leak',
      } as unknown as RouteResponse<'me'>),
    );

    const response = await app.request('/api/me');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ userId: 'user-1', memberships: [] });
    expect(body).not.toHaveProperty('leakedInternalField');
  });

  it('fails closed when the handler omits a contract field', async () => {
    const app = buildApp((context) =>
      respond(context, 'me', { userId: 'user-1' } as unknown as RouteResponse<'me'>),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.request('/api/me');
    const body = (await response.json()) as {
      code: string;
      message: string;
      details: { issues: { path: string }[] };
    };

    expect(response.status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.details.issues[0]?.path).toBe('memberships');
    expect(JSON.stringify(body)).not.toContain('should-not-leak');
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it('rejects a wrong field type instead of letting it reach the client', async () => {
    const app = buildApp((context) =>
      respond(context, 'me', {
        userId: 42,
        memberships: [],
      } as unknown as RouteResponse<'me'>),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.request('/api/me');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERNAL_ERROR' });
    log.mockRestore();
  });
});
