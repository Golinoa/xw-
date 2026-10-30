import { describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * identity-audit 域的错误呈现与展示映射。
 *
 * 两个必须成立的语义：
 * 1. **版本冲突要刷新，规则拒绝不要刷新**。前者刷新后重试通常能成；后者
 *    （`LAST_ROLE` / `LAST_ADMIN`）重试仍会被同一规则拒绝，让人反复刷新是误导。
 * 2. **未知枚举/未登记动作原样降级**，不渲染空白，也不猜中文名。
 */
function makeError(options: {
  code: string;
  details?: Record<string, unknown>;
  kind?: 'http' | 'network' | 'timeout' | 'unknown';
  reason?: string;
  status?: number;
}): OpsApiError {
  return new OpsApiError({
    code: options.code,
    details: options.details,
    kind: options.kind ?? 'http',
    reason: options.reason,
    requestId: 'req-test-1',
    retryable: false,
    status: options.status,
    userMessage: '原始文案',
  });
}

describe('错误归类', () => {
  it('409 无 reason → 版本冲突，要求刷新且不可原样重试', async () => {
    const { describeIdentityError } = await import('#/api/ops/identity/errors');

    const view = describeIdentityError(
      makeError({ code: 'CONFLICT', status: 409 }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.shouldRefresh).toBe(true);
    expect(view.canRetry).toBe(false);
  });

  it('409 + LAST_ADMIN → 冲突但不需要刷新（刷新也没用）', async () => {
    const { describeIdentityError } = await import('#/api/ops/identity/errors');

    const view = describeIdentityError(
      makeError({
        code: 'STATE_CONFLICT',
        reason: 'LAST_ADMIN',
        status: 409,
      }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.shouldRefresh).toBe(false);
    expect(view.description).toContain('最后一个');
  });

  it('400 的 details.issues 被解析成字段级提示', async () => {
    const { describeIdentityError, issueFor } =
      await import('#/api/ops/identity/errors');

    const view = describeIdentityError(
      makeError({
        code: 'VALIDATION_ERROR',
        details: {
          issues: [{ message: '超出范围', path: 'ticketDueHours' }],
        },
        status: 400,
      }),
    );

    expect(view.kind).toBe('validation');
    expect(issueFor(view, 'ticketDueHours')).toBe('超出范围');
    expect(issueFor(view, 'unknownField')).toBeUndefined();
  });

  it('403 → 权限类，且不提供重试', async () => {
    const { describeIdentityError } = await import('#/api/ops/identity/errors');

    const view = describeIdentityError(
      makeError({ code: 'FORBIDDEN', status: 403 }),
    );

    expect(view.kind).toBe('permission');
    expect(view.canRetry).toBe(false);
  });

  it('网络失败 → 可重试', async () => {
    const { describeIdentityError } = await import('#/api/ops/identity/errors');

    const view = describeIdentityError(
      makeError({ code: 'NETWORK_ERROR', kind: 'network' }),
    );

    expect(view.kind).toBe('network');
    expect(view.canRetry).toBe(true);
  });
});

describe('展示映射', () => {
  it('未知成员状态降级为「未知(原值)」而不是空白', async () => {
    const { operatorStatusView } = await import('#/api/ops/identity/format');

    const view = operatorStatusView('suspended');

    expect(view.known).toBe(false);
    expect(view.label).toBe('未知(suspended)');
  });

  it('导出状态与类型有中文名', async () => {
    const { exportStatusView, exportTypeView } =
      await import('#/api/ops/identity/format');

    expect(exportStatusView('succeeded').label).toBe('已完成');
    expect(exportTypeView('receivables').label).toBe('应收');
  });

  it('未登记的审计动作原样显示，并标出未登记', async () => {
    const { auditActionLabel, isKnownAuditAction } =
      await import('#/api/ops/identity/format');

    expect(auditActionLabel('export.create')).toBe('发起数据导出');
    expect(auditActionLabel('tenant.command.replayed')).toBe(
      'tenant.command.replayed',
    );
    expect(isKnownAuditAction('tenant.command.replayed')).toBe(false);
  });

  it('行为主体三种形态都能显示（字符串 / 对象 / 缺失）', async () => {
    const { actorLabel } = await import('#/api/ops/identity/format');

    expect(actorLabel('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(actorLabel({ displayName: '陈（虚构）', id: 'x' })).toBe(
      '陈（虚构）',
    );
    expect(actorLabel({ displayName: '', id: 'x' })).toBe('x');
    expect(actorLabel(null)).toBe('—');
  });

  it('非有限数显示占位符，不隐式当 0', async () => {
    const { formatCount } = await import('#/api/ops/identity/format');

    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
    expect(formatCount(1234)).toBe('1,234');
  });

  it('非法时间显示占位符', async () => {
    const { formatDateTime } = await import('#/api/ops/identity/format');

    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatDateTime('2026-10-30T00:00:00Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });
});
