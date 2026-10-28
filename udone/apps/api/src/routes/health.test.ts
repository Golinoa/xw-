import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import type { ApiEnvironment, AuthVerifier } from '../middleware/auth';

const verifier: AuthVerifier = {
  verify: async () => null,
  hasPermission: async () => false,
};

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns version, request ID, and configured dependency status without secret values', async () => {
    const env: ApiEnvironment['Bindings'] & { APP_VERSION: string } = {
      AUTH_VERIFIER: verifier,
      APP_VERSION: 'test-version',
      SUPABASE_URL: 'https://fixture.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-server-secret',
    };
    const response = await app.request(
      '/api/health',
      {
        headers: { 'X-Request-Id': 'health-request-7' },
      },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      version: 'test-version',
      requestId: 'health-request-7',
      dependencies: { supabase: 'available' },
    });
    expect(JSON.stringify(body)).not.toContain('fixture-server-secret');
    expect(fetch).toHaveBeenCalledWith(
      'https://fixture.supabase.co/auth/v1/health',
      expect.objectContaining({
        headers: { apikey: 'fixture-publishable-key' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('reports missing dependencies as degraded without exposing configuration values', async () => {
    const response = await app.request('/api/health', undefined, { AUTH_VERIFIER: verifier });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      dependencies: { supabase: 'missing_configuration' },
    });
  });

  it('reports dependency failures without returning upstream details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private upstream detail', { status: 503 })),
    );
    const env: ApiEnvironment['Bindings'] = {
      SUPABASE_URL: 'https://fixture.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
    };
    const response = await app.request('/api/health', undefined, env);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      dependencies: { supabase: 'unavailable' },
    });
    expect(JSON.stringify(body)).not.toContain('private');
  });
});
