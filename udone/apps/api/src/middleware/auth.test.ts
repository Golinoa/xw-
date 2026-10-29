import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS, type AuthContext, type ApiErrorBody } from '@erp/contracts';
import { requireAuth, requirePermission, type ApiEnvironment } from './auth';
import { errorHandler } from './error-handler';
import { requestId } from './request-id';

const identity: AuthContext = {
  userId: 'user-test-1',
  organizationId: 'org-test-1',
  role: 'operator',
  sessionId: 'session-test-1',
  permissions: ['organization.read'],
  dataScope: 'own',
};

function createApp() {
  const app = new Hono<ApiEnvironment>();
  app.use('*', requestId());
  app.onError(errorHandler);
  app.get('/protected', requireAuth(), (context) =>
    context.json({ userId: context.get('auth').userId }),
  );
  app.get('/members', requireAuth(), requirePermission(PERMISSIONS.MEMBER_MANAGE), (context) =>
    context.json({ organizationId: context.get('auth').organizationId }),
  );
  return app;
}

describe('requireAuth', () => {
  it('rejects a missing bearer token with the standard AUTH_REQUIRED response', async () => {
    const response = await createApp().request(
      '/protected',
      {},
      {
        AUTH_VERIFIER: { verify: vi.fn(), hasPermission: vi.fn().mockResolvedValue(false) },
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      code: 'AUTH_REQUIRED',
      requestId: response.headers.get('X-Request-Id'),
    });
  });

  it('rejects an invalid bearer token with AUTH_REQUIRED', async () => {
    const response = await createApp().request(
      '/protected',
      {
        headers: { Authorization: 'Bearer invalid-token' },
      },
      {
        AUTH_VERIFIER: {
          verify: vi.fn().mockResolvedValue(null),
          hasPermission: vi.fn().mockResolvedValue(false),
        },
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it.each(['Basic not-a-bearer-token', 'Bearer', 'Bearer test-token extra'])(
    'rejects a malformed Authorization header (%s) without calling the verifier',
    async (authorization) => {
      const verify = vi.fn();
      const response = await createApp().request(
        '/protected',
        {
          headers: { Authorization: authorization },
        },
        { AUTH_VERIFIER: { verify, hasPermission: vi.fn().mockResolvedValue(false) } },
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('X-Request-Id')).toBeTruthy();
      await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('accepts a valid verified bearer token and preserves request ID', async () => {
    const verify = vi.fn().mockResolvedValue(identity);
    const response = await createApp().request(
      '/protected',
      {
        headers: {
          Authorization: 'Bearer test-token',
          'X-Request-Id': 'request-success-42',
        },
      },
      { AUTH_VERIFIER: { verify, hasPermission: vi.fn().mockResolvedValue(false) } },
    );

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('test-token');
    await expect(response.json()).resolves.toEqual({ userId: identity.userId });
    expect(response.headers.get('X-Request-Id')).toBe('request-success-42');
  });

  it('passes the selected organization to membership verification', async () => {
    const verify = vi.fn().mockResolvedValue(identity);
    const response = await createApp().request(
      '/protected',
      {
        headers: {
          Authorization: 'Bearer test-token',
          'X-Organization-ID': 'org-test-2',
        },
      },
      { AUTH_VERIFIER: { verify, hasPermission: vi.fn().mockResolvedValue(false) } },
    );

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledWith('test-token', 'org-test-2');
  });

  it('preserves a supplied request ID in response headers and errors', async () => {
    const response = await createApp().request(
      '/protected',
      {
        headers: { 'X-Request-Id': 'request-test-42' },
      },
      { AUTH_VERIFIER: { verify: vi.fn(), hasPermission: vi.fn().mockResolvedValue(false) } },
    );

    expect(response.headers.get('X-Request-Id')).toBe('request-test-42');
    const body = (await response.json()) as ApiErrorBody;
    expect(body.requestId).toBe('request-test-42');
  });
});

describe('requirePermission', () => {
  it('rejects a verified user without the required permission', async () => {
    const response = await createApp().request(
      '/members',
      {
        headers: { Authorization: 'Bearer test-token' },
      },
      {
        AUTH_VERIFIER: {
          verify: vi.fn().mockResolvedValue(identity),
          hasPermission: vi.fn().mockResolvedValue(false),
        },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'FORBIDDEN' });
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
  });
});
