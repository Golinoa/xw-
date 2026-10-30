import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsAuthRoutes } from './routes';
import type { OpsAuthUpstream, OpsTokenGrant } from './upstream';

function buildApp() {
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', async (context, next) => {
    context.set('requestId', 'test-request');
    await next();
  });
  app.route('/', opsAuthRoutes);
  return app;
}

function granted(accessToken = 'access-token', refreshToken = 'refresh-token'): OpsTokenGrant {
  return { kind: 'granted', accessToken, refreshToken };
}

/** 替身只实现三个方法；`rejected` 是最常用的分支，所以默认给成功、按需覆盖。 */
function fakeUpstream(overrides: Partial<OpsAuthUpstream> = {}): OpsAuthUpstream {
  return {
    signInWithPassword: vi.fn(async () => granted()),
    refresh: vi.fn(async () => granted('new-access', 'new-refresh')),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

function bindings(upstream: OpsAuthUpstream) {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    OPS_AUTH_UPSTREAM: upstream,
  } as ApiEnvironment['Bindings'];
}

/** `resolveMemberState` 走的是全局 fetch（成员判定必须真打到 PostgREST）。 */
function stubMemberState(state: string) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(state), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function login(app: Hono<ApiEnvironment>, body: unknown, env: ApiEnvironment['Bindings']) {
  return app.request(
    '/api/v1/ops/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify(body),
    },
    env,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/v1/ops/auth/login', () => {
  it('issues an access token and an HttpOnly refresh cookie for an active operator', async () => {
    const upstream = fakeUpstream();
    stubMemberState('active');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'ops@example.test', password: 'correct-horse' },
      bindings(upstream),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accessToken: 'access-token' });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ops_refresh=refresh-token');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/ops/auth');
  });

  it('never echoes the refresh token in the body', async () => {
    stubMemberState('active');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'ops@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body)).toEqual(['accessToken']);
  });

  it('answers 401 without touching the operator directory when the password is wrong', async () => {
    const upstream = fakeUpstream({
      signInWithPassword: vi.fn(async () => ({ kind: 'rejected' }) as OpsTokenGrant),
    });
    const fetchMock = stubMemberState('active');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'ops@example.test', password: 'wrong' },
      bindings(upstream),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(response.headers.get('set-cookie')).toBeNull();
    // 先验密码再查名单：反过来的话，未验证身份的人就能拿这个端点探测运营邮箱。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 403 OPS_MEMBER_MISSING and withholds the cookie', async () => {
    stubMemberState('missing');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'tenant@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'OPS_MEMBER_MISSING' },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers 403 OPS_MEMBER_INACTIVE for a disabled operator', async () => {
    stubMemberState('disabled');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'disabled@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      details: { reason: 'OPS_MEMBER_INACTIVE' },
    });
  });

  /**
   * 契约只有两个 reason，`invited` 必须映射到其中一个。归到 INACTIVE 而不是
   * MISSING：账号是存在的，说「还没被加入」会让人去重复开户。
   */
  it('folds an invited operator into OPS_MEMBER_INACTIVE', async () => {
    stubMemberState('invited');
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      details: { reason: 'OPS_MEMBER_INACTIVE' },
    });
  });

  it('answers 400 for a body that is not an email and a password', async () => {
    stubMemberState('active');
    const app = buildApp();

    const response = await login(app, { email: '', password: '' }, bindings(fakeUpstream()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('answers 429 with Retry-After once one account is tried too often', async () => {
    const upstream = fakeUpstream({
      signInWithPassword: vi.fn(async () => ({ kind: 'rejected' }) as OpsTokenGrant),
    });
    stubMemberState('active');
    const app = buildApp();
    const env = bindings(upstream);
    const attempt = () => login(app, { email: 'spray@example.test', password: 'guess' }, env);

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('POST /api/v1/ops/auth/refresh', () => {
  it('rotates the cookie and returns a fresh access token', async () => {
    const upstream = fakeUpstream();
    const app = buildApp();

    const response = await app.request(
      '/api/v1/ops/auth/refresh',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'ops_refresh=old-refresh' },
      },
      bindings(upstream),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accessToken: 'new-access' });
    expect(upstream.refresh).toHaveBeenCalledWith('old-refresh');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ops_refresh=new-refresh');
    expect(cookie).toContain('Path=/api/v1/ops/auth');
  });

  it('answers 401 without a cookie', async () => {
    const app = buildApp();

    const response = await app.request(
      '/api/v1/ops/auth/refresh',
      { method: 'POST' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  /**
   * 上游拒了就要把死 cookie 清掉。留着它，浏览器每次打开页面都会先发一次
   * 注定失败的刷新，然后才走登录——多一次往返，多一条误导人的 401。
   */
  it('clears the cookie when the upstream rejects the refresh token', async () => {
    const upstream = fakeUpstream({
      refresh: vi.fn(async () => ({ kind: 'rejected' }) as OpsTokenGrant),
    });
    const app = buildApp();

    const response = await app.request(
      '/api/v1/ops/auth/refresh',
      { method: 'POST', headers: { Cookie: 'ops_refresh=stale' } },
      bindings(upstream),
    );

    expect(response.status).toBe(401);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ops_refresh=');
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('POST /api/v1/ops/auth/logout', () => {
  it('answers 204 and clears the cookie', async () => {
    const upstream = fakeUpstream();
    const app = buildApp();

    const response = await app.request(
      '/api/v1/ops/auth/logout',
      { method: 'POST', headers: { Cookie: 'ops_refresh=live-refresh' } },
      bindings(upstream),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(upstream.revoke).toHaveBeenCalledWith('live-refresh');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/api/v1/ops/auth');
  });

  it('stays 204 without a cookie, and does not call the upstream', async () => {
    const upstream = fakeUpstream();
    const app = buildApp();

    const response = await app.request(
      '/api/v1/ops/auth/logout',
      { method: 'POST' },
      bindings(upstream),
    );

    expect(response.status).toBe(204);
    expect(upstream.revoke).not.toHaveBeenCalled();
  });
});
