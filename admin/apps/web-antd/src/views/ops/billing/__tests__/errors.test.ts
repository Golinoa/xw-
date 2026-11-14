import { describe, expect, it } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  describeBillingError,
  isRefreshRequired,
} from '#/api/ops/billing/errors';

function apiError(options: {
  code: string;
  reason?: string;
  status: number;
}): OpsApiError {
  return new OpsApiError({
    code: options.code,
    details: options.reason ? { reason: options.reason } : undefined,
    kind: 'http',
    reason: options.reason,
    retryable: false,
    status: options.status,
    userMessage: 'server message (frontend must not display this)',
  });
}

/**
 * 409 冲突映射：金融页面必须让运营知道"余额已变化，请刷新后重试"，
 * 而不是把英文后端 message 或一句"操作失败"扔给用户。
 */
describe('冲突（409）错误映射', () => {
  it('应收余额被并发改动 → 提示余额已变化并要求刷新', () => {
    const view = describeBillingError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'RECEIVABLE_EXCEEDED',
        status: 409,
      }),
    );
    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('余额已变化');
    expect(view.description).toContain('刷新');
    expect(view.description).toContain('应收余额');
    expect(view.shouldRefresh).toBe(true);
    expect(
      isRefreshRequired(
        apiError({
          code: 'STATE_CONFLICT',
          reason: 'RECEIVABLE_EXCEEDED',
          status: 409,
        }),
      ),
    ).toBe(true);
  });

  it('收款可分配额被并发改动同样要求刷新', () => {
    const view = describeBillingError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'RECEIPT_EXCEEDED',
        status: 409,
      }),
    );
    expect(view.title).toBe('余额已变化');
    expect(view.shouldRefresh).toBe(true);
  });

  it('仍有有效核销时冲正 → 提示先撤销核销', () => {
    const view = describeBillingError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'HAS_ALLOCATIONS',
        status: 409,
      }),
    );
    expect(view.description).toContain('撤销核销');
    expect(view.shouldRefresh).toBe(true);
  });

  it('幂等冲突 → 明确说明"未重复执行"', () => {
    const view = describeBillingError(
      apiError({ code: 'IDEMPOTENCY_CONFLICT', status: 409 }),
    );
    expect(view.title).toBe('重复提交被拒绝');
    expect(view.description).toContain('未重复执行');
    expect(view.shouldRefresh).toBe(true);
  });

  it('乐观锁冲突 → 提示版本冲突并刷新', () => {
    const view = describeBillingError(
      apiError({ code: 'CONFLICT', status: 409 }),
    );
    expect(view.title).toBe('数据已变更');
    expect(view.shouldRefresh).toBe(true);
  });
});

describe('其它错误映射', () => {
  it('登记人自审（403 + SEGREGATION_OF_DUTY）指向职责分离', () => {
    const view = describeBillingError(
      apiError({
        code: 'FORBIDDEN',
        reason: 'SEGREGATION_OF_DUTY',
        status: 403,
      }),
    );
    expect(view.kind).toBe('permission');
    expect(view.title).toBe('职责分离限制');
    expect(view.description).toContain('登记人');
    expect(view.shouldRefresh).toBe(false);
  });

  it('400 校验失败不做"可重试"暗示，且不展示后端英文文案', () => {
    const view = describeBillingError(
      apiError({
        code: 'VALIDATION_ERROR',
        reason: 'PLAN_TOTAL_MISMATCH',
        status: 400,
      }),
    );
    expect(view.kind).toBe('validation');
    expect(view.description).toBe('应收计划合计与合同金额不一致');
    expect(view.canRetry).toBe(false);
    expect(view.description).not.toContain('server message');
  });

  it('5xx 不确认是否生效，提示先刷新确认再重试', () => {
    const view = describeBillingError(
      apiError({ code: 'INTERNAL_ERROR', status: 500 }),
    );
    expect(view.canRetry).toBe(true);
    expect(view.description).toContain('刷新');
  });

  it('requestId 透传到展示层，便于对账', () => {
    const error = new OpsApiError({
      code: 'STATE_CONFLICT',
      kind: 'http',
      reason: 'RECEIVABLE_EXCEEDED',
      requestId: '2b1c9f5e-1a4d-4b1e-9f2c-0a1b2c3d4e5f',
      retryable: false,
      status: 409,
      userMessage: 'x',
    });
    expect(describeBillingError(error).requestId).toBe(
      '2b1c9f5e-1a4d-4b1e-9f2c-0a1b2c3d4e5f',
    );
  });

  it('未知异常不允许兜底成成功形状', () => {
    const view = describeBillingError(new Error('boom'));
    expect(view.kind).toBe('unknown');
    expect(view.title).toBe('操作失败');
    expect(view.shouldRefresh).toBe(false);
  });
});
