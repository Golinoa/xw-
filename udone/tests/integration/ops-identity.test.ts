import { describe, expect, it } from 'vitest';
import { call, OPS_USER, signToken, USERS } from './harness';

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
