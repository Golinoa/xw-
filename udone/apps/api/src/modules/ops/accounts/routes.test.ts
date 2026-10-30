import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsAccountRoutes } from './routes';
import type { OpsInviteUpstream } from './invite-upstream';

/**
 * 这一层测的是**翻译**：RPC 的信封 → 契约的错误码/状态码，以及列名 → 字段名。
 *
 * 它不测「规则是否成立」——LAST_ADMIN、乐观锁、审计摘要都由 pgTAP 在真实库上
 * 断言过。同一条规则在两个地方各测一遍，只会得到一个错觉：以为改了库还安全，
 * 因为这里是绿的。
 */

const ALL_PERMISSIONS = [
  'operator.read',
  'operator.manage',
  'role.manage',
  'audit.read',
  'customer.read',
];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: '00000000-0000-4000-8000-000000000001',
    operator_email: 'admin@example.test',
    operator_display_name: '管理员',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 3,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: permissions,
  };
}

function operatorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    email: 'member@example.test',
    display_name: '成员',
    status: 'active',
    mfa_required: false,
    version: 2,
    last_login_at: null,
    roles: [{ code: 'finance_ops', name: '财务运营' }],
    ...overrides,
  };
}

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    code: 'auditor',
    name: '审计员',
    description: '只读审计',
    is_system: false,
    status: 'active',
    permissions: ['audit.read'],
    ...overrides,
  };
}

interface StubOptions {
  permissions?: string[];
  /** `rpc/<name>` → 响应体。没给的名字一律当作「不该被调用」。 */
  rpc?: Record<string, unknown>;
  rpcStatus?: Record<string, number>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 每次 RPC 调用的请求体。契约字段（如 `p_display_name`）是否真的透传下去，
 * 只能从请求体看出来——响应正确但参数被吞掉，是最容易漏的一类回归。
 *
 * 它是模块级的而不是某一次 `stubFetch` 的返回值：同一个用例里会换几套响应
 * （一次传 displayName、一次不传），而请求体要跨这些替换累积下来。
 */
const rpcBodies: Array<{ name: string; body: Record<string, unknown> }> = [];

function stubFetch(options: StubOptions = {}) {
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const called: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rpcName = url.split('/rpc/')[1]?.split('?')[0];

    if (rpcName === 'get_current_ops_context') return json([opsContextRow(permissions)]);
    if (!rpcName) throw new Error(`unexpected request: ${url}`);

    called.push(rpcName);
    rpcBodies.push({
      name: rpcName,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (!(rpcName in (options.rpc ?? {}))) {
      throw new Error(`rpc ${rpcName} was not expected`);
    }
    const status = options.rpcStatus?.[rpcName] ?? 200;
    return json(options.rpc?.[rpcName], status);
  });

  vi.stubGlobal('fetch', fetchMock);
  return called;
}

const app = new Hono<ApiEnvironment>();
app.onError(errorHandler);
app.route('/', opsAccountRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  upstream?: OpsInviteUpstream;
  bindings?: Partial<ApiEnvironment['Bindings']>;
}

async function call(path: string, options: CallOptions = {}) {
  const url = new URL(path, 'http://ops.test');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await app.request(
    url.toString(),
    {
      method: options.method ?? 'GET',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    {
      ...env,
      ...(options.upstream ? { OPS_INVITE_UPSTREAM: options.upstream } : {}),
      ...options.bindings,
    },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

afterEach(() => {
  vi.unstubAllGlobals();
  rpcBodies.length = 0;
});

describe('GET /api/v1/ops/operators', () => {
  it('maps snake_case rows to the contract shape and echoes the page window', async () => {
    stubFetch({ rpc: { list_operators: { items: [operatorRow()], total: 41 } } });

    const response = await call('/api/v1/ops/operators', { query: { page: '2', pageSize: '20' } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          email: 'member@example.test',
          displayName: '成员',
          status: 'active',
          mfaRequired: false,
          version: 2,
          roles: [{ code: 'finance_ops', name: '财务运营' }],
          lastLoginAt: null,
        },
      ],
      total: 41,
      page: 2,
      pageSize: 20,
    });
  });

  it('translates the contract sort key to the column the SQL ladder matches', async () => {
    const called = stubFetch({ rpc: { list_operators: { items: [], total: 0 } } });
    let captured: unknown;
    const baseFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rpc/list_operators')) captured = JSON.parse(String(init?.body));
      return baseFetch(input, init);
    });

    await call('/api/v1/ops/operators', { query: { sort: 'createdAt', order: 'desc' } });

    expect(called).toEqual(['list_operators']);
    // 传 `createdAt` 下去会让 SQL 的 CASE 阶梯全部落空，静默退化成按邮箱排序。
    expect(captured).toMatchObject({ p_sort: 'created_at', p_order: 'desc' });
  });

  it('refuses a reader without operator.read before touching the directory', async () => {
    const called = stubFetch({ permissions: ['customer.read'], rpc: {} });

    const response = await call('/api/v1/ops/operators');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'operator.read' },
    });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/operators/invitations', () => {
  /**
   * `deletion` 是补偿删除（D-04）的替身行为：默认成功，`false` 是「上游没删掉」，
   * `'throws'` 是「替身违反了不抛异常的契约」。
   */
  function upstream(
    outcome: 'invited' | 'email_taken' | 'unavailable',
    deletion: boolean | 'throws' = true,
  ): OpsInviteUpstream {
    return {
      invite: async () =>
        outcome === 'invited'
          ? { kind: 'invited', userId: '00000000-0000-4000-8000-000000000030' }
          : outcome === 'email_taken'
            ? { kind: 'email_taken' }
            : { kind: 'unavailable' },
      deleteUser: vi.fn(async () => {
        if (deletion === 'throws') throw new Error('delete blew up');
        return deletion;
      }),
    };
  }

  it('returns 201 with only the id and status when the invitation succeeds', async () => {
    const called = stubFetch({
      rpc: {
        invite_operator: {
          status: 'ok',
          operator: operatorRow({ status: 'invited', version: 1, roles: [] }),
          invitation_expires_at: '2026-10-31T11:00:00+00:00',
        },
      },
    });

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['finance_ops'], reason: '入职' },
      upstream: upstream('invited'),
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      operator: { id: '00000000-0000-4000-8000-000000000010', status: 'invited' },
      invitationExpiresAt: '2026-10-31T11:00:00+00:00',
    });
    expect(called).toEqual(['invite_operator']);
  });

  it('passes displayName through, and sends null when it is omitted (D-02)', async () => {
    const rpc = {
      invite_operator: {
        status: 'ok',
        operator: operatorRow({ status: 'invited', version: 1, roles: [] }),
        invitation_expires_at: '2026-10-31T11:00:00+00:00',
      },
    };

    stubFetch({ rpc });
    await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: {
        email: 'member@example.test',
        displayName: '张三',
        roleCodes: ['finance_ops'],
        reason: '入职',
      },
      upstream: upstream('invited'),
    });

    stubFetch({ rpc });
    await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['finance_ops'], reason: '入职' },
      upstream: upstream('invited'),
    });

    const bodies = rpcBodies
      .filter((entry) => entry.name === 'invite_operator')
      .map((entry) => entry.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ p_display_name: '张三' });
    // 不传就是 null：库里的「不改/不填」哨兵统一用 NULL，不用 undefined 区分。
    expect(bodies[1]).toMatchObject({ p_display_name: null });
  });

  it('does not reach the database when GoTrue already knows the email', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['finance_ops'], reason: '入职' },
      upstream: upstream('email_taken'),
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
    expect(called).toEqual([]);
  });

  /**
   * D-04：写成员行失败时先补偿删除刚建的 auth 用户。管理员看到的错误码不变——
   * 补偿是收尾，不是另一种结果。
   */
  it('deletes the just-created auth user and keeps the business error (D-04)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ rpc: { invite_operator: { status: 'unknown_role', codes: ['ghost'] } } });
    const fake = upstream('invited');

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['ghost'], reason: '入职' },
      upstream: fake,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { codes: ['ghost'] },
    });
    expect(fake.deleteUser).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000030');

    const lines = error.mock.calls.map(([line]) => String(line));
    const compensated = lines.find((line) => line.includes('ops_invitation_compensated'));
    expect(compensated).toBeDefined();
    expect(compensated).toContain('00000000-0000-4000-8000-000000000030');
    // 删掉了就不该再打孤儿日志：那会让运维去后台找一个已经不存在的账号。
    expect(lines.some((line) => line.includes('ops_invitation_orphan_user'))).toBe(false);
    error.mockRestore();
  });

  it('keeps the orphan log when the compensation itself fails (D-04)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ rpc: { invite_operator: { status: 'email_exists' } } });

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['finance_ops'], reason: '入职' },
      upstream: upstream('invited', false),
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });

    const orphan = error.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('ops_invitation_orphan_user'));
    expect(orphan).toBeDefined();
    expect(orphan).toContain('"compensation":"failed"');
    error.mockRestore();
  });

  /** 替身抛异常也必须回原错误码：补偿失败不该把 400 变成 500。 */
  it('still answers the business error when the compensation throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ rpc: { invite_operator: { status: 'roles_required' } } });

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: [], reason: '入职' },
      upstream: upstream('invited', 'throws'),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    error.mockRestore();
  });

  it('rejects an invitation without a reason at the contract layer', async () => {
    stubFetch({ rpc: {} });

    const response = await call('/api/v1/ops/operators/invitations', {
      method: 'POST',
      body: { email: 'member@example.test', roleCodes: ['finance_ops'], reason: '   ' },
      upstream: upstream('invited'),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('PATCH /api/v1/ops/operators/{operatorId}', () => {
  const path = '/api/v1/ops/operators/00000000-0000-4000-8000-000000000010';
  const body = { status: 'disabled', reason: '离职', version: 2 };

  it('reports a stale version as 409 CONFLICT with the current value', async () => {
    stubFetch({ rpc: { update_operator: { status: 'version_mismatch', current_version: 5 } } });

    const response = await call(path, { method: 'PATCH', body });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { currentVersion: 5 },
    });
  });

  it('separates the two self-lock refusals by reason', async () => {
    stubFetch({ rpc: { update_operator: { status: 'last_admin' } } });
    const lastAdmin = await call(path, { method: 'PATCH', body });

    stubFetch({ rpc: { update_operator: { status: 'last_role' } } });
    const lastRole = await call(path, { method: 'PATCH', body });

    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ADMIN' },
    });
    expect(lastRole.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ROLE' },
    });
  });

  it('returns the permission delta computed by the database', async () => {
    stubFetch({
      rpc: {
        update_operator: {
          status: 'ok',
          operator: operatorRow({ version: 3 }),
          permissions_changed: { added: ['receipt.approve'], removed: ['ticket.read'] },
        },
      },
    });

    const response = await call(path, { method: 'PATCH', body });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operator: { version: 3 },
      permissionsChanged: { added: ['receipt.approve'], removed: ['ticket.read'] },
    });
  });

  it('passes displayName through on PATCH and keeps the null sentinel when omitted (D-02)', async () => {
    const rpc = {
      update_operator: {
        status: 'ok',
        operator: operatorRow({ display_name: '李四', version: 3 }),
        permissions_changed: { added: [], removed: [] },
      },
    };

    stubFetch({ rpc });
    await call(path, { method: 'PATCH', body: { ...body, displayName: '李四' } });

    stubFetch({ rpc });
    await call(path, { method: 'PATCH', body });

    // 空串是「清空」，不是「没传」：schema 的 trim 会让它保持空串，路由原样下传，
    // 库里再按「空串 → NULL」处理。这一条盯的正是「没被 ?? null 吃掉」。
    stubFetch({ rpc });
    await call(path, { method: 'PATCH', body: { ...body, displayName: '' } });

    const bodies = rpcBodies
      .filter((entry) => entry.name === 'update_operator')
      .map((entry) => entry.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ p_display_name: '李四' });
    expect(bodies[1]).toMatchObject({ p_display_name: null });
    expect(bodies[2]).toMatchObject({ p_display_name: '' });
  });

  it('fails closed when the RPC returns a shape outside the contract', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ rpc: { update_operator: { status: 'ok' } } });

    const response = await call(path, { method: 'PATCH', body });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .some((line) => line.includes('ops_rpc_shape_invalid')),
    ).toBe(true);
    error.mockRestore();
  });

  it('translates a 42501 from the database into 403', async () => {
    stubFetch({
      rpc: { update_operator: { message: 'denied' } },
      rpcStatus: { update_operator: 403 },
    });

    const response = await call(path, { method: 'PATCH', body });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('roles and audit', () => {
  it('maps a role row including the description that U-22 requires', async () => {
    stubFetch({ rpc: { list_roles: { items: [roleRow()] } } });

    const response = await call('/api/v1/ops/roles');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [
        {
          code: 'auditor',
          description: '只读审计',
          isSystem: false,
          status: 'active',
          permissions: ['audit.read'],
        },
      ],
    });
  });

  it('keeps an audit event whose actor is null', async () => {
    stubFetch({
      rpc: {
        list_audit_events: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000040',
              actor: null,
              action: 'system.cleanup',
              entity_type: 'system',
              entity_id: null,
              reason: null,
              before_summary: null,
              after_summary: null,
              request_id: null,
              created_at: '2026-10-30T10:00:00+00:00',
            },
          ],
          total: 1,
        },
      },
    });

    const response = await call('/api/v1/ops/audit-events');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [{ actor: null, action: 'system.cleanup', entityType: 'system' }],
      total: 1,
    });
  });
});
