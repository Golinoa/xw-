import { describe, expect, it } from 'vitest';
import {
  OPS_INVITEE_USER,
  OPS_USER,
  OPS_VIEWER_USER,
  call,
  expectStatus,
  signToken,
} from './harness';

/**
 * 运营账号与角色的写侧，跑在**真实 PostgREST + 真实 RLS** 上。
 *
 * 这一段要证明的是「拒绝来自库里的行，不是来自替身」：403 由 `ops.has_permission`
 * 判定，409 由 `ops.update_operator` 的 LAST_ROLE / LAST_ADMIN 判定，500 不该出现。
 * 唯一被替换的是 GoTrue 的 `auth.admin`（本地没有 `/auth/v1`），它只负责回一个
 * auth 用户 id——**邀请之后的所有判定仍然是真跑的**。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const OPERATORS = '/api/v1/ops/operators';
const ROLES = '/api/v1/ops/roles';
const AUDIT = '/api/v1/ops/audit-events';

/** 邀请上游的替身：只做一件事——把一个已经存在的 auth 用户 id 交回来。 */
const inviteUpstream = {
  invite: async () => ({ kind: 'invited' as const, userId: OPS_INVITEE_USER }),
};

async function operatorByEmail(token: string, email: string) {
  const response = await call<{ items: Array<Record<string, unknown>> }>(OPERATORS, {
    token,
    query: { keyword: email },
  });
  expectStatus(response, 200);
  const found = response.body.items.find((item) => item.email === email);
  if (!found) throw new Error(`operator ${email} not found in the list`);
  return found;
}

describe('GET /api/v1/ops/operators', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(OPERATORS, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a tenant administrator with a perfectly valid token', async () => {
    // P11：租户管理员有 `member.manage`，但 `ops.operators` 里没有他的行。
    const response = await call(OPERATORS, { actor: 'admin' });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an operator account that lacks operator.read', async () => {
    const response = await call(OPERATORS, { token: viewerToken });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'operator.read' },
    });
  });

  it('leaves the audit trail readable for that same account', async () => {
    // 同一个人、同一个令牌：读账号 403，读审计 200。权限是按动作码判的，
    // 不是「是不是运营成员」。
    const response = await call(AUDIT, { token: viewerToken });
    expectStatus(response, 200);
    expect(Array.isArray((response.body as { items: unknown[] }).items)).toBe(true);
  });

  it('returns the optimistic-lock version and mfaRequired on every row (U-18)', async () => {
    const response = await call<{ items: Array<Record<string, unknown>> }>(OPERATORS, {
      token: opsToken,
    });
    expectStatus(response, 200);

    const viewer = response.body.items.find((item) => item.email === 'ops-viewer@integration.test');
    expect(viewer).toBeDefined();
    expect(viewer).toMatchObject({ status: 'active', version: 1, mfaRequired: false });
    expect(Array.isArray(viewer?.roles)).toBe(true);
  });
});

describe('POST /api/v1/ops/operators/invitations', () => {
  it('creates an invited account and writes the audit event', async () => {
    const response = await call<{ operator: { id: string; status: string } }>(
      `${OPERATORS}/invitations`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          email: 'ops-invitee@integration.test',
          roleCodes: ['ops_viewer'],
          reason: '集成测试邀请',
        },
        env: { OPS_INVITE_UPSTREAM: inviteUpstream },
      },
    );
    expectStatus(response, 201);
    expect(response.body.operator.status).toBe('invited');

    const invited = await operatorByEmail(opsToken, 'ops-invitee@integration.test');
    expect(invited).toMatchObject({
      status: 'invited',
      roles: [{ code: 'ops_viewer', name: '运营只读' }],
    });

    const audit = await call<{
      items: Array<{ actor: { displayName: string } | null; action: string }>;
    }>(AUDIT, { token: opsToken, query: { action: 'operator.invited' } });
    expectStatus(audit, 200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'operator.invited',
      actor: { displayName: 'Integration Ops' },
    });
  });

  it('refuses a second invitation for the same email', async () => {
    const response = await call(`${OPERATORS}/invitations`, {
      method: 'POST',
      token: opsToken,
      body: {
        email: 'ops-invitee@integration.test',
        roleCodes: ['ops_viewer'],
        reason: '重复邀请',
      },
      env: { OPS_INVITE_UPSTREAM: inviteUpstream },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses an invitation from an account without operator.manage', async () => {
    const response = await call(`${OPERATORS}/invitations`, {
      method: 'POST',
      token: viewerToken,
      body: { email: 'another@integration.test', roleCodes: ['ops_viewer'], reason: '越权邀请' },
      env: { OPS_INVITE_UPSTREAM: inviteUpstream },
    });
    expectStatus(response, 403);
  });
});

describe('PATCH /api/v1/ops/operators/{operatorId}', () => {
  it('refuses a stale version with a conflict, not a state conflict', async () => {
    const viewer = await operatorByEmail(opsToken, 'ops-viewer@integration.test');
    const response = await call(`${OPERATORS}/${String(viewer.id)}`, {
      method: 'PATCH',
      token: opsToken,
      body: { mfaRequired: true, reason: '版本过期', version: 99 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 1 } });
  });

  it('refuses to remove the last role of an account', async () => {
    const viewer = await operatorByEmail(opsToken, 'ops-viewer@integration.test');
    const response = await call(`${OPERATORS}/${String(viewer.id)}`, {
      method: 'PATCH',
      token: opsToken,
      body: { roleCodes: [], reason: '清空角色', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ROLE' },
    });
  });

  it('refuses to disable the last account holding operator.manage', async () => {
    const admin = await operatorByEmail(opsToken, 'ops-admin@integration.test');
    const response = await call(`${OPERATORS}/${String(admin.id)}`, {
      method: 'PATCH',
      token: opsToken,
      body: { status: 'disabled', reason: '把自己停用', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ADMIN' },
    });

    // 被拒之后账号必须还在启用状态——「返回 409」与「什么都没写」是两件事。
    const after = await operatorByEmail(opsToken, 'ops-admin@integration.test');
    expect(after).toMatchObject({ status: 'active', version: 1 });
  });

  it('applies a harmless update and bumps the version', async () => {
    const viewer = await operatorByEmail(opsToken, 'ops-viewer@integration.test');
    const response = await call<{
      operator: { version: number; mfaRequired: boolean };
      permissionsChanged: { added: string[]; removed: string[] };
    }>(`${OPERATORS}/${String(viewer.id)}`, {
      method: 'PATCH',
      token: opsToken,
      body: { mfaRequired: true, reason: '开启二次认证', version: 1 },
    });

    expectStatus(response, 200);
    expect(response.body.operator).toMatchObject({ version: 2, mfaRequired: true });
    // 只改策略位，角色没动，因此权限差集为空。
    expect(response.body.permissionsChanged).toEqual({ added: [], removed: [] });
  });
});

describe('roles', () => {
  it('creates a custom role with its permission set', async () => {
    const response = await call<{ role: { id: string; code: string; permissions: string[] } }>(
      ROLES,
      {
        method: 'POST',
        token: opsToken,
        body: {
          code: 'integration_reader',
          name: '集成只读',
          description: '集成测试建的角色',
          permissionCodes: ['audit.read', 'overview.read'],
          reason: '集成测试',
        },
      },
    );

    expectStatus(response, 201);
    expect(response.body.role).toMatchObject({
      code: 'integration_reader',
      isSystem: false,
      status: 'active',
      permissions: ['audit.read', 'overview.read'],
    });
  });

  it('refuses a duplicate role code', async () => {
    const response = await call(ROLES, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'integration_reader',
        name: '重复',
        permissionCodes: [],
        reason: '重复 code',
      },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses an unknown permission code and says which one', async () => {
    const response = await call(ROLES, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'integration_broken',
        name: '错的',
        permissionCodes: ['no.such.permission'],
        reason: '未知动作码',
      },
    });

    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { codes: ['no.such.permission'] },
    });
  });

  it('returns the permission sets before and after an edit', async () => {
    const list = await call<{ items: Array<{ id: string; code: string }> }>(ROLES, {
      token: opsToken,
    });
    expectStatus(list, 200);
    const role = list.body.items.find((item) => item.code === 'integration_reader');
    if (!role) throw new Error('integration_reader was not created');

    const response = await call<{ beforePermissions: string[]; afterPermissions: string[] }>(
      `${ROLES}/${role.id}`,
      {
        method: 'PATCH',
        token: opsToken,
        body: { permissionCodes: ['audit.read'], reason: '收紧权限' },
      },
    );

    expectStatus(response, 200);
    expect(response.body.beforePermissions).toEqual(['audit.read', 'overview.read']);
    expect(response.body.afterPermissions).toEqual(['audit.read']);
  });

  it('refuses to strip operator.manage from the only role that grants it', async () => {
    const list = await call<{ items: Array<{ id: string; code: string }> }>(ROLES, {
      token: opsToken,
    });
    const platformAdmin = list.body.items.find((item) => item.code === 'platform_admin');
    if (!platformAdmin) throw new Error('platform_admin role is missing');

    const response = await call(`${ROLES}/${platformAdmin.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { permissionCodes: ['customer.read'], reason: '削掉管理员权限' },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_ADMIN' },
    });
  });
});
