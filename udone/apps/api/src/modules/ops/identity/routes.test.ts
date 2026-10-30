import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsIdentityRoutes } from './routes';

const TOKEN = 'operator-access-token';

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    operator_id: '00000000-0000-4000-8000-000000000101',
    operator_email: 'ops@example.test',
    operator_display_name: '平台管理员',
    operator_status: 'active',
    mfa_required: true,
    permission_version: 7,
    last_login_at: '2026-10-29T08:00:00.000Z',
    role_codes: ['finance_ops', 'platform_admin'],
    role_names: ['财务运营', '平台管理员'],
    permission_codes: ['operator.read', 'audit.read'],
    ...overrides,
  };
}

const PERMISSION_ROWS = [
  {
    code: 'audit.read',
    domain: 'identity-audit',
    description: '查询审计事件',
    is_high_risk: false,
  },
  {
    code: 'operator.read',
    domain: 'identity-audit',
    description: '查看运营账号',
    is_high_risk: false,
  },
];

function buildApp() {
  const app = new Hono<ApiEnvironment>();
  app.onError(errorHandler);
  app.use('*', async (context, next) => {
    context.set('requestId', 'test-request');
    await next();
  });
  app.route('/', opsIdentityRoutes);
  return app;
}

function bindings() {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  } as ApiEnvironment['Bindings'];
}

/** 第一跳是 RPC（requireOpsAuth），第二跳是查表；顺序固定，所以按序返回。 */
function stubStack(contextRows: unknown[], tableRows: unknown[] = PERMISSION_ROWS) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes('/rpc/') ? contextRows : tableRows;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function get(path: string) {
  return buildApp().request(path, { headers: { Authorization: `Bearer ${TOKEN}` } }, bindings());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/ops/session', () => {
  it('projects the operator context into the session shape', async () => {
    stubStack([contextRow()]);

    const response = await get('/api/v1/ops/session');
    const body = (await response.json()) as Record<string, never>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      operator: {
        id: '00000000-0000-4000-8000-000000000101',
        displayName: '平台管理员',
        email: 'ops@example.test',
        status: 'active',
        mfaRequired: true,
      },
      permissions: ['operator.read', 'audit.read'],
      permissionVersion: 7,
      lastLoginAt: '2026-10-29T08:00:00.000Z',
    });
  });

  it('pairs each role code with its name', async () => {
    stubStack([contextRow()]);

    const body = (await (await get('/api/v1/ops/session')).json()) as {
      roles: { code: string; name: string }[];
    };

    expect(body.roles).toEqual([
      { code: 'finance_ops', name: '财务运营' },
      { code: 'platform_admin', name: '平台管理员' },
    ]);
  });

  /**
   * 两个平行数组靠 order by 对齐，是脆的。真错位时至少要退化得可读：
   * 显示 code，而不是把某个角色的名字安到另一个角色头上。
   */
  it('falls back to the code when the two role arrays disagree in length', async () => {
    stubStack([
      contextRow({ role_codes: ['support_agent', 'ops_viewer'], role_names: ['售后支持'] }),
    ]);

    const body = (await (await get('/api/v1/ops/session')).json()) as {
      roles: { code: string; name: string }[];
    };

    expect(body.roles).toEqual([
      { code: 'support_agent', name: '售后支持' },
      { code: 'ops_viewer', name: 'ops_viewer' },
    ]);
  });

  it('answers 401 without a token', async () => {
    const fetchMock = stubStack([contextRow()]);

    const response = await buildApp().request('/api/v1/ops/session', {}, bindings());

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 403 when the caller is not an active operator', async () => {
    stubStack([]);

    const response = await get('/api/v1/ops/session');

    expect(response.status).toBe(403);
  });
});

describe('GET /api/v1/ops/permissions', () => {
  it('returns the catalogue with camelCase fields', async () => {
    stubStack([contextRow()]);

    const response = await get('/api/v1/ops/permissions');
    const body = (await response.json()) as { items: Record<string, unknown>[] };

    expect(response.status).toBe(200);
    expect(body.items[0]).toEqual({
      code: 'audit.read',
      domain: 'identity-audit',
      description: '查询审计事件',
      isHighRisk: false,
    });
  });

  it('asks PostgREST for the ops profile and orders by code', async () => {
    const fetchMock = stubStack([contextRow()]);

    await get('/api/v1/ops/permissions');

    const [url] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/permissions?select=');
    expect(url).toContain('order=code.asc');
  });

  /**
   * 没有 operator.read 时必须 403，而不是「查表得到空列表」。空列表会让前端
   * 以为目录没配好，而真正的原因是权限不足——两者要修的都不是同一个人。
   */
  it('answers 403 when the operator lacks operator.read', async () => {
    const fetchMock = stubStack([
      contextRow({
        permission_codes: ['ticket.read'],
        role_codes: ['support_agent'],
        role_names: ['售后支持'],
      }),
    ]);

    const response = await get('/api/v1/ops/permissions');

    expect(response.status).toBe(403);
    expect(((await response.json()) as { details?: { required?: string } }).details?.required).toBe(
      'operator.read',
    );
    // 一次 RPC 之外不应再查表：权限不足时连目录都不该碰。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
