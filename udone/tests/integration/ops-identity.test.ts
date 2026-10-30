import { describe, expect, it } from 'vitest';
import type { OpsAuthUpstream } from '../../apps/api/src/modules/ops/auth/upstream';
import { OPS_INVITED_USER, OPS_USER, call, expectStatus, signToken, USERS } from './harness';

/**
 * `/session` 与 `/permissions` 的真实链路验收。
 *
 * 这两条比 `/meta` 多走一跳：`/permissions` 在鉴权之后还要以用户令牌查
 * `ops.permissions` 表，RLS 再次判定。所以它证明的是**同一条令牌在 RPC 与
 * 表两条路径上得到同一个结论**——两层授权最容易出问题的地方正是这里。
 */

const OPS_TOKEN = signToken(OPS_USER);

describe('GET /api/v1/ops/session', () => {
  it('describes the signed-in operator over the real stack', async () => {
    const response = await call<{
      operator: { id: string; email: string; status: string; mfaRequired: boolean };
      roles: { code: string; name: string }[];
      permissions: string[];
      permissionVersion: number;
    }>('/api/v1/ops/session', { token: OPS_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body.operator.id).toBe('a2000000-0000-4000-8000-000000000001');
    expect(response.body.operator.email).toBe('ops-admin@integration.test');
    expect(response.body.operator.status).toBe('active');
    expect(response.body.roles).toEqual([{ code: 'platform_admin', name: '平台管理员' }]);
    expect(response.body.permissions).toHaveLength(39);
    expect(response.body.permissionVersion).toBe(1);
  });

  it('answers 403 for a tenant member', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/session', {
      token: signToken(USERS.admin),
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/v1/ops/permissions', () => {
  it('lists the 39 seeded action codes with their risk level', async () => {
    const response = await call<{ items: { code: string; domain: string; isHighRisk: boolean }[] }>(
      '/api/v1/ops/permissions',
      { token: OPS_TOKEN },
    );

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(39);
    expect(response.body.items[0]?.code).toBe('audit.read');
    expect(response.body.items.filter((item) => item.isHighRisk)).toHaveLength(14);
  });

  it('answers 403 for a tenant member', async () => {
    const response = await call<{ code: string }>('/api/v1/ops/permissions', {
      token: signToken(USERS.admin),
    });

    expect(response.status).toBe(403);
  });
});

/**
 * D-01 + D-05 的真实链路。
 *
 * 密码校验仍是替身（本地没有 GoTrue），但从「拿到令牌」开始全部是真的：
 * `login_member_state()`、`activate_invited_member()`、`touch_last_login()` 都打到
 * 真实 PostgREST，`ops.operators` 的读写都穿过真实策略。
 *
 * 这条用例的价值在于它把三件事串成一条：登录成功、库里那一行真的变了、
 * 发出去的令牌能立刻用（`get_current_ops_context()` 的 `status = 'active'` 是
 * 最后一个判官，它说不行就是「登录成功但进不去」）。
 */
describe('POST /api/v1/ops/auth/login → ops.operators', () => {
  function upstreamReturning(userId: string): OpsAuthUpstream {
    return {
      async signInWithPassword() {
        return {
          kind: 'granted',
          accessToken: signToken(userId),
          refreshToken: `refresh-${userId}`,
        };
      },
      async refresh() {
        return {
          kind: 'granted',
          accessToken: signToken(userId),
          refreshToken: `rotated-${userId}`,
        };
      },
      async revoke() {},
    };
  }

  it('activates an invited account, writes last_login_at and returns a usable token', async () => {
    const login = await call<{ accessToken: string }>('/api/v1/ops/auth/login', {
      method: 'POST',
      token: '',
      body: { email: 'ops-invited@integration.test', password: 'any-password' },
      env: { OPS_AUTH_UPSTREAM: upstreamReturning(OPS_INVITED_USER) },
    });

    expectStatus(login, 200);
    expect(login.headers.get('set-cookie')).toContain('ops_refresh=');

    // 令牌是这一跳的产物，直接拿它打下一个端点：若激活没落库，这里的
    // `get_current_ops_context()` 返回零行，下面这条会红。
    const session = await call<{
      operator: { email: string; status: string };
      lastLoginAt: string | null;
    }>('/api/v1/ops/session', { token: login.body.accessToken });

    expectStatus(session, 200);
    expect(session.body.operator.email).toBe('ops-invited@integration.test');
    expect(session.body.operator.status).toBe('active');
    expect(session.body.lastLoginAt).not.toBeNull();

    // 换管理员视角再读一次列表：`/session` 走的是 RPC，列表走的是 RLS + 表，
    // 两条路径都该看到同一个 status。只断言前者，等于没验证行真的改了。
    const list = await call<{
      items: Array<{ email: string; status: string; lastLoginAt: string | null }>;
    }>('/api/v1/ops/operators', {
      token: OPS_TOKEN,
      query: { keyword: 'ops-invited@integration.test' },
    });

    expectStatus(list, 200);
    const row = list.body.items.find((item) => item.email === 'ops-invited@integration.test');
    expect(row).toMatchObject({ status: 'active' });
    expect(row?.lastLoginAt).not.toBeNull();
  });
});
