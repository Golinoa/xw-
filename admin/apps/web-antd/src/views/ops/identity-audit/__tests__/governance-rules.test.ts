import type {
  OpsOperatorListItem,
  OpsPermissionItem,
  OpsRoleDetail,
} from '#/api/ops/identity';

import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 治理域页面规则（成员可编辑判定、权限分组与差异、角色并集预览）。
 *
 * 这些函数决定「能不能点提交」，是本页最容易出错的地方：
 * 把版本号判断写错 → 用旧数据覆盖别人的改动；
 * 把权限并集当授权依据 → 授权判断出现第二套口径。
 */
function operator(
  overrides: Partial<OpsOperatorListItem> = {},
): OpsOperatorListItem {
  return {
    displayName: '测试成员（虚构）',
    email: 'test.member@example.invalid',
    id: '00000000-0000-4000-8000-0000000000aa',
    lastLoginAt: null,
    roles: [{ code: 'ops_viewer', name: '运营只读' }],
    status: 'active',
    version: 3,
    ...overrides,
  };
}

function role(
  code: string,
  permissions: string[],
  overrides: Partial<OpsRoleDetail> = {},
): OpsRoleDetail {
  return {
    code,
    id: `role-${code}`,
    isSystem: false,
    name: code,
    permissions,
    status: 'active',
    ...overrides,
  };
}

describe('成员可编辑判定', () => {
  it('列表项没有 version → 禁止编辑并说明原因', async () => {
    const { operatorEditGuard } =
      await import('#/views/ops/identity-audit/governance');

    const guard = operatorEditGuard(operator({ version: undefined }));

    expect(guard.editable).toBe(false);
    expect(guard.hint).toContain('version');
  });

  it('有 version → 允许编辑', async () => {
    const { operatorEditGuard } =
      await import('#/views/ops/identity-audit/governance');

    expect(operatorEditGuard(operator()).editable).toBe(true);
  });

  it('mfa 当前值未返回时标记为不可信（不冒充「未开启」）', async () => {
    const { mfaValueTrusted } =
      await import('#/views/ops/identity-audit/governance');

    expect(mfaValueTrusted(operator({ mfaRequired: undefined }))).toBe(false);
    expect(mfaValueTrusted(operator({ mfaRequired: false }))).toBe(true);
  });
});

describe('权限目录分组', () => {
  it('按 domain 分组且保持首次出现顺序', async () => {
    const { groupPermissions } =
      await import('#/views/ops/identity-audit/governance');

    const items: OpsPermissionItem[] = [
      {
        code: 'audit.read',
        description: '',
        domain: 'audit',
        isHighRisk: false,
      },
      {
        code: 'operator.read',
        description: '',
        domain: 'identity',
        isHighRisk: false,
      },
      {
        code: 'operator.manage',
        description: '',
        domain: 'identity',
        isHighRisk: true,
      },
    ];

    const groups = groupPermissions(items);

    expect(groups.map((group) => group.domain)).toEqual(['audit', 'identity']);
    expect(groups[1]?.items).toHaveLength(2);
  });
});

describe('权限差异与并集', () => {
  it('差异排序稳定（同样输入得到同样输出，便于审计对比）', async () => {
    const { diffPermissions } =
      await import('#/views/ops/identity-audit/governance');

    const diff = diffPermissions(
      ['b.read', 'c.read'],
      ['a.read', 'c.read', 'd.read'],
    );

    expect(diff.added).toEqual(['a.read', 'd.read']);
    expect(diff.removed).toEqual(['b.read']);
  });

  it('无变化时摘要明确写「权限未变更」，不留空', async () => {
    const { summarizePermissionDiff } =
      await import('#/views/ops/identity-audit/governance');

    expect(summarizePermissionDiff({ added: [], removed: [] })).toBe(
      '权限未变更',
    );
  });

  it('并集去重且排序，未知角色码被忽略', async () => {
    const { permissionCodesOfRoles } =
      await import('#/views/ops/identity-audit/governance');

    const roles = [
      role('a', ['x.read', 'y.read']),
      role('b', ['y.read', 'z.read']),
    ];

    expect(permissionCodesOfRoles(roles, ['a', 'b', 'missing'])).toEqual([
      'x.read',
      'y.read',
      'z.read',
    ]);
  });
});

describe('表单必填校验', () => {
  it('角色为空 → 提示至少保留一个', async () => {
    const { validateRoleSelection } =
      await import('#/views/ops/identity-audit/governance');

    expect(validateRoleSelection([])).toBe('至少保留一个角色');
    expect(validateRoleSelection(['ops_viewer'])).toBeNull();
  });

  it('原因只有空白 → 视为未填写', async () => {
    const { validateReason } =
      await import('#/views/ops/identity-audit/governance');

    expect(validateReason('   ')).toBe('请填写变更原因（会写入审计）');
    expect(validateReason('岗位调整')).toBeNull();
  });
});
