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

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 登录链路上的三条 RPC 共用全局 fetch（成员判定、激活、写 last_login 都必须
 * 真打到 PostgREST 形态的端点），所以替身按 URL 里的函数名分发，并按调用顺序
 * 记下来——「先判定、再激活、再写时间」这个顺序本身也要被断言，不只是结果。
 */
interface DirectoryReplies {
  state?: string;
  /**
   * 第二次及以后 `login_member_state` 的回答。
   *
   * 只有「激活没生效」那条分支会问第二次（激活返回 `unchanged` 时要区分
   * 「并发登录已经激活了」与「被停用了」），而这两者的差别全在这个字段上。
   */
  stateAfter?: string;
  activation?: string;
  lastLogin?: string;
  activationStatus?: number;
}

function stubDirectory(replies: DirectoryReplies = {}) {
  const calls: string[] = [];
  let stateReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const name = url.split('/rpc/')[1] ?? '';
    calls.push(name);
    if (name === 'login_member_state') {
      const answer =
        stateReads === 0
          ? (replies.state ?? 'active')
          : (replies.stateAfter ?? replies.state ?? 'active');
      stateReads += 1;
      return json(answer);
    }
    if (name === 'activate_invited_member') {
      return json(replies.activation ?? 'activated', replies.activationStatus ?? 200);
    }
    if (name === 'touch_last_login') return json(replies.lastLogin ?? 'ok');
    if (name === 'record_access_audit') return json({ status: 'ok', eventId: 'audit-1' });
    throw new Error(`unexpected rpc: ${name}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
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
    const calls = stubDirectory({ state: 'active' });
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

    // 已经是 active 的账号不该被「激活」一次：那会白涨一格乐观锁版本。
    expect(calls).toEqual(['login_member_state', 'touch_last_login', 'record_access_audit']);
  });

  it('never echoes the refresh token in the body', async () => {
    stubDirectory({ state: 'active' });
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
    const calls = stubDirectory({ state: 'active' });
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
    expect(calls).toEqual([]);
  });

  it('answers 403 OPS_MEMBER_MISSING and withholds the cookie', async () => {
    stubDirectory({ state: 'missing' });
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
    stubDirectory({ state: 'disabled' });
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
   * D-01：受邀者第一次登录就转 active，不再 403。
   *
   * 顺序也要断言：判定 → 激活 → 写 last_login。把激活放在写 last_login 之后，
   * 那个函数会看到 invited 行并返回 missing（它只写 active 行），于是「最近登录」
   * 对新账号永远是空——功能在，但只对老账号生效。
   */
  it('activates an invited operator on first sign-in and issues the cookie (D-01)', async () => {
    const calls = stubDirectory({ state: 'invited', activation: 'activated' });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accessToken: 'access-token' });
    expect(response.headers.get('set-cookie')).toContain('ops_refresh=refresh-token');
    expect(calls).toEqual([
      'login_member_state',
      'activate_invited_member',
      'touch_last_login',
      'record_access_audit',
    ]);
  });

  /**
   * 激活返回 `unchanged` 有两种含义，处置相反，所以要看第二次读到的状态：
   *
   *   - 已经 `active`：另一次并发的登录刚把它激活了。这是成功——把它当 503，
   *     用户会看到「第二次点击失败」，而账号其实已经开通。
   *   - 已经 `disabled`：判定与激活之间被停用了。这才是失败。
   */
  it('treats unchanged-then-active as a concurrent activation, not a failure', async () => {
    const calls = stubDirectory({
      state: 'invited',
      stateAfter: 'active',
      activation: 'unchanged',
    });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('ops_refresh=refresh-token');
    expect(calls).toEqual([
      'login_member_state',
      'activate_invited_member',
      'login_member_state',
      'touch_last_login',
      'record_access_audit',
    ]);
  });

  /**
   * 激活没成立就不发 cookie：发出去的令牌会被 `get_current_ops_context()` 的
   * `status = 'active'` 挡回 403，用户看到「登录成功但进不去」，且每次刷新重演。
   */
  it('answers 403 INACTIVE when the account was disabled between the check and the activation', async () => {
    const calls = stubDirectory({
      state: 'invited',
      stateAfter: 'disabled',
      activation: 'unchanged',
    });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'OPS_MEMBER_INACTIVE' },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    // 激活没成立就不该去写 last_login：那会把「还没进来」的人记成「刚登录过」。
    expect(calls).toEqual(['login_member_state', 'activate_invited_member', 'login_member_state']);
  });

  it('answers 503 without a cookie when the row is still invited after activation', async () => {
    const calls = stubDirectory({
      state: 'invited',
      stateAfter: 'invited',
      activation: 'unchanged',
    });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(calls).toEqual(['login_member_state', 'activate_invited_member', 'login_member_state']);
  });

  it('answers 503 without a cookie when the activation RPC itself fails', async () => {
    stubDirectory({ state: 'invited', activation: 'activated', activationStatus: 500 });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'invited@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  /**
   * 与上一条相反：`last_login_at` 只是展示字段，写失败不该让登录失败。
   * 它不参与任何鉴权判定，把它变成登录可用性的单点没有收益。
   */
  it('still signs in when writing last_login fails, and logs the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubDirectory({ state: 'active', lastLogin: 'unexpected-word' });
    const app = buildApp();

    const response = await login(
      app,
      { email: 'ops@example.test', password: 'pw' },
      bindings(fakeUpstream()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('ops_refresh=refresh-token');
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .some((line) => line.includes('ops_last_login_write_failed')),
    ).toBe(true);
    error.mockRestore();
  });

  it('answers 400 for a body that is not an email and a password', async () => {
    stubDirectory({ state: 'active' });
    const app = buildApp();

    const response = await login(app, { email: '', password: '' }, bindings(fakeUpstream()));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('answers 429 with Retry-After once one account is tried too often', async () => {
    const upstream = fakeUpstream({
      signInWithPassword: vi.fn(async () => ({ kind: 'rejected' }) as OpsTokenGrant),
    });
    stubDirectory({ state: 'active' });
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
