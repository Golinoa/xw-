import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestMissingResourceError } from '../lib/rest-client';
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
app.get('/missing-dependency', () => {
  throw new RestMissingResourceError('rpc/convert_lead_to_order');
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

  it('names the missing dependency and logs it', async () => {
    // 缺 RPC/表（多半是迁移没应用）必须能一步定位，不能只说「服务暂时不可用」。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.request('/missing-dependency');
      expect(response.status).toBe(500);

      const body = (await response.json()) as {
        code: string;
        details?: { dependency?: string };
      };
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.details?.dependency).toBe('rpc/convert_lead_to_order');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('rpc/convert_lead_to_order'));
      expect(JSON.stringify(body)).not.toContain('Supabase resource missing');
    } finally {
      spy.mockRestore();
    }
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
