import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from './auth';
import { errorHandler } from './error-handler';
import { requestId } from './request-id';
import { app as apiApp } from '../index';

const app = new Hono<ApiEnvironment>();
app.use('*', requestId());
app.onError(errorHandler);
app.get('/failure', () => {
  throw new Error('internal detail must not leak');
});

describe('errorHandler', () => {
  it('returns a standard internal error without exposing exception details', async () => {
    const response = await app.request('/failure');
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(body).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: response.headers.get('X-Request-Id'),
    });
    expect(JSON.stringify(body)).not.toContain('internal detail');
  });
});

describe('API health route', () => {
  beforeEach(() =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('includes a supplied request ID on a successful health response', async () => {
    const response = await apiApp.request(
      '/api/health',
      {
        headers: { 'X-Request-Id': 'health-request-7' },
      },
      {
        APP_VERSION: 'test-version',
        SUPABASE_URL: 'https://fixture.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe('health-request-7');
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      version: 'test-version',
      requestId: 'health-request-7',
      dependencies: { supabase: 'available' },
    });
  });
});
