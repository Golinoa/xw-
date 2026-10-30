import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_CONTRACT_VERSION, OPS_SALES_MODES, OPS_SUPPORTED_CURRENCIES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsMetaRoutes } from './routes';

const TOKEN = 'operator-access-token';

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    operator_id: '00000000-0000-4000-8000-000000000101',
    operator_email: 'ops@example.test',
    operator_display_name: '平台管理员',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: ['overview.read'],
    ...overrides,
  };
}

function buildApp() {
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', async (context, next) => {
    context.set('requestId', 'test-request');
    await next();
  });
  app.route('/', opsMetaRoutes);
  return app;
}

function bindings() {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  } as ApiEnvironment['Bindings'];
}

/** RPC 返回的行是数据库列名（snake_case），中间件负责映射成契约形状。 */
function stubRpc(rows: unknown[] | { status: number }) {
  const fetchMock = vi.fn(async () => {
    if (!Array.isArray(rows)) {
      return new Response(JSON.stringify({ message: 'nope' }), { status: rows.status });
    }
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function get(options: { token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? TOKEN}`;
  return buildApp().request('/api/v1/ops/meta', { headers }, bindings());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/ops/meta', () => {
  it('describes the contract for an active operator', async () => {
    stubRpc([contextRow()]);

    const response = await get();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.contractVersion).toBe('1.0.0');
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(body.supportedSalesModes).toEqual(['saas', 'private']);
    expect(body.supportedCurrencies).toEqual(['CNY']);
  });

  /**
   * 前端据 contractVersion 做不兼容快速失败；带 `v` 前缀或日期串会被判成
   * MALFORMED，表现是全站停在拒绝页。所以形状本身要有断言。
   */
  it('reports a semver contract version without a prefix', () => {
    expect(OPS_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reports serverTime as RFC3339 UTC with a trailing Z', async () => {
    stubRpc([contextRow()]);

    const body = (await (await get()).json()) as { serverTime: string };

    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });

  it('sends the token to the ops RPC with the ops schema profile', async () => {
    // profile 头抄错的表现是 404 PGRST106，与「函数不存在」看起来一样，
    // 所以把这两个头钉死在断言里，而不是靠记得。
    const fetchMock = stubRpc([contextRow()]);

    await get();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://supabase.test/rest/v1/rpc/get_current_ops_context');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Accept-Profile']).toBe('ops');
    expect(headers['Content-Profile']).toBe('ops');
    expect(init.method).toBe('POST');
  });

  it('answers 401 when no token is sent, without asking PostgREST', async () => {
    const fetchMock = stubRpc([contextRow()]);

    const response = await get({ token: null });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 401 when PostgREST rejects the token', async () => {
    stubRpc({ status: 401 });

    const response = await get();

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
  });

  it('answers 403 for a valid token that is not an active operator', async () => {
    // RPC 零行 = 令牌有效但没有 active 的运营账号。这条与上一条的区别正是
    // 「登录了但不是运营」和「没登录」，混成一个码会让前端不知道该弹哪个页。
    stubRpc([]);

    const response = await get();

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('fails closed when the RPC returns an unexpected shape', async () => {
    // 列改名之类的事故必须 503，不能降级成「没权限」：后者会让所有运营账号
    // 突然都没权限，而排查方向会先落到权限配置上。
    stubRpc([{ operator_id: 'x' }]);

    const response = await get();

    expect(response.status).toBe(503);
  });

  it('keeps the two whitelists identical to the contract constants', () => {
    expect(OPS_SALES_MODES).toEqual(['saas', 'private']);
    expect(OPS_SUPPORTED_CURRENCIES).toEqual(['CNY']);
  });
});
