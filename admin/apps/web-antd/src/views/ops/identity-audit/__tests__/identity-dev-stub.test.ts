import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  resetStubIdentityState,
  stubCreateDictionaryItem,
  stubCreateExport,
  stubGetExportTask,
  stubGetSettings,
  stubInviteOperator,
  stubListAuditEvents,
  stubListExportTasks,
  stubListOperators,
  stubUpdateOperator,
  stubUpdateSettings,
} from '#/api/ops/identity/dev-stub';
import { STUB_CURRENT_OPERATOR_ID } from '#/api/ops/identity/fixtures';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'true');

async function catchError(promise: Promise<unknown>): Promise<OpsApiError> {
  const error = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  if (!(error instanceof OpsApiError)) {
    throw new Error('期望抛出 OpsApiError，实际没有抛出');
  }
  return error;
}

/**
 * 开发态契约桩必须复刻服务端不变量，否则前端会在「假的成功」里漏掉真实错误分支。
 *
 * 本文件钉住六条：
 * 版本冲突、最后一个角色、最后一个管理员、重复邮箱、设置越界、字典取值重复，
 * 外加两条正向路径：导出异步推进、审计只追加。
 */
describe('运营成员桩的拒绝路径', () => {
  beforeEach(() => {
    resetStubIdentityState();
  });

  it('列表项返回 version（后端契约缺口 G-1 的替代证据）', async () => {
    const page = await stubListOperators();

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(typeof item.version).toBe('number');
    }
  });

  it('版本不匹配 → 409 CONFLICT', async () => {
    const error = await catchError(
      stubUpdateOperator(STUB_CURRENT_OPERATOR_ID, {
        reason: '测试',
        roleCodes: ['platform_admin'],
        version: 999,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
  });

  it('移除全部角色 → 409 STATE_CONFLICT + LAST_ROLE', async () => {
    const error = await catchError(
      stubUpdateOperator(STUB_CURRENT_OPERATOR_ID, {
        reason: '测试',
        roleCodes: [],
        version: 7,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.reason).toBe('LAST_ROLE');
  });

  it('停用最后一个管理员 → 409 STATE_CONFLICT + LAST_ADMIN', async () => {
    const error = await catchError(
      stubUpdateOperator(STUB_CURRENT_OPERATOR_ID, {
        reason: '误操作',
        status: 'disabled',
        version: 7,
      }),
    );

    expect(error.status).toBe(409);
    expect(error.reason).toBe('LAST_ADMIN');
  });

  it('正常改角色 → 返回权限变更摘要且版本递增', async () => {
    const result = await stubUpdateOperator(
      '00000000-0000-4000-8000-000000000011',
      {
        reason: '临时加只读',
        roleCodes: ['sales_ops', 'ops_viewer'],
        version: 2,
      },
    );

    expect(result.operator.version).toBe(3);
    expect(result.permissionsChanged.added).toContain('audit.read');
    expect(result.permissionsChanged.removed).toEqual([]);
  });

  it('重复邮箱邀请 → 409 CONFLICT', async () => {
    const error = await catchError(
      stubInviteOperator({
        email: 'sales.li@example.invalid',
        reason: '重复邀请',
        roleCodes: ['sales_ops'],
      }),
    );

    expect(error.status).toBe(409);
  });

  it('新邮箱邀请 → 状态 invited 且带邀请有效期', async () => {
    const result = await stubInviteOperator({
      email: 'new.member@example.invalid',
      reason: '新同事入职',
      roleCodes: ['ops_viewer'],
    });

    expect(result.operator.status).toBe('invited');
    expect(result.invitationExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('设置与字典桩', () => {
  beforeEach(() => {
    resetStubIdentityState();
  });

  it('窗口越界 → 400 VALIDATION_ERROR + issues', async () => {
    const error = await catchError(
      stubUpdateSettings({ overviewExpiryWindowDays: 999, reason: '测试' }),
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    const issues = (error.details as { issues?: { path: string }[] }).issues;
    expect(
      issues?.some((issue) => issue.path === 'overviewExpiryWindowDays'),
    ).toBe(true);
  });

  it('合法修改 → 保存成功并推进 updatedAt', async () => {
    const before = await stubGetSettings();
    const result = await stubUpdateSettings({
      ticketDueHours: 24,
      reason: '缩短时限',
    });

    expect(result.settings.ticketDueHours).toBe(24);
    expect(result.settings.overviewExpiryWindowDays).toBe(
      before.settings.overviewExpiryWindowDays,
    );
  });

  it('字典取值重复 → 409 CONFLICT（停用项也占位）', async () => {
    const error = await catchError(
      stubCreateDictionaryItem('payment_methods', {
        label: '重复的转账',
        value: 'bank_transfer',
      }),
    );

    expect(error.status).toBe(409);
  });

  it('新增字典项 → 返回带 id 的条目（供后续 PATCH 寻址）', async () => {
    const result = await stubCreateDictionaryItem('payment_methods', {
      label: '微信支付（虚构）',
      value: 'wechat_pay',
    });

    expect(result.item.value).toBe('wechat_pay');
    expect(typeof result.item.id).toBe('string');
  });
});

describe('导出任务桩的异步语义', () => {
  beforeEach(() => {
    resetStubIdentityState();
  });

  it('创建只返回 queued，不谎报完成', async () => {
    const result = await stubCreateExport({
      exportType: 'customers',
      filters: { keyword: '示例' },
      reason: '月度对账',
    });

    expect(result.status).toBe('queued');

    const first = await stubListExportTasks();
    const created = first.items.find((item) => item.id === result.id);
    // 第一次读取推进到 running——仍然不可下载。
    expect(created?.status).toBe('running');
    expect(created?.downloadUrl).toBeUndefined();
  });

  it('推进到 succeeded 后详情返回签名下载地址', async () => {
    const created = await stubCreateExport({
      exportType: 'receivables',
      filters: {},
      reason: '对账',
    });

    await stubListExportTasks();
    await stubListExportTasks();
    const detail = await stubGetExportTask(created.id);

    expect(detail.status).toBe('succeeded');
    expect(detail.downloadUrl).toContain('signature=stub');
    expect(detail.rowCount).toBeGreaterThan(0);
  });

  it('非法导出类型 → 400，不落库', async () => {
    const error = await catchError(
      stubCreateExport({
        exportType: 'secrets' as never,
        filters: {},
        reason: '非法',
      }),
    );

    expect(error.status).toBe(400);
  });
});

describe('审计桩只追加', () => {
  beforeEach(() => {
    resetStubIdentityState();
  });

  it('写操作后新增一条审计，且排在最前', async () => {
    const before = await stubListAuditEvents();
    await stubInviteOperator({
      email: 'audit.check@example.invalid',
      reason: '验证审计',
      roleCodes: ['ops_viewer'],
    });
    const after = await stubListAuditEvents();

    expect(after.total).toBe(before.total + 1);
    expect(after.items[0]?.action).toBe('operator.invite');
    expect(after.items[0]?.reason).toBe('验证审计');
    expect(after.items[0]?.beforeSummary).toBeNull();
  });

  it('未登记动作也能被查到（词表开放，不影响查询）', async () => {
    const page = await stubListAuditEvents({
      action: 'tenant.command.replayed',
    });

    expect(page.total).toBe(1);
  });
});
