import { describe, expect, it } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  describeEntitlementError,
  isEntitlementRefreshRequired,
} from '#/api/ops/entitlement/errors';

/** 契约 §6：前端不解析后端 message，只按 code + details.reason 映射中文。 */
function httpError(options: {
  code: string;
  reason?: string;
  requestId?: string;
  status: number;
}): OpsApiError {
  return new OpsApiError({
    code: options.code,
    details: options.reason ? { reason: options.reason } : undefined,
    kind: 'http',
    reason: options.reason,
    requestId: options.requestId ?? 'req-1',
    retryable: false,
    status: options.status,
    userMessage: 'The request failed', // 英文内部文案，不允许出现在界面上
  });
}

describe('权益错误文案映射', () => {
  it('409 CONFLICT（版本冲突）→ 数据已变化，请刷新后重试', () => {
    const view = describeEntitlementError(
      httpError({ code: 'CONFLICT', status: 409 }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('数据已变化');
    expect(view.description).toContain('数据已变化');
    expect(view.description).toContain('刷新');
    expect(view.shouldRefresh).toBe(true);
    expect(
      isEntitlementRefreshRequired(
        httpError({ code: 'CONFLICT', status: 409 }),
      ),
    ).toBe(true);
  });

  it('409 STATE_CONFLICT + APPROVAL_REQUIRED → 需要先完成审批', () => {
    const view = describeEntitlementError(
      httpError({
        code: 'STATE_CONFLICT',
        reason: 'APPROVAL_REQUIRED',
        status: 409,
      }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('需要先完成审批');
    expect(view.description).toContain('entitlement.approve');
    expect(view.reason).toBe('APPROVAL_REQUIRED');
    expect(view.shouldRefresh).toBe(true);
  });

  it('409 STATE_CONFLICT + PERMANENT_ERROR → 明确「不可重试」', () => {
    const view = describeEntitlementError(
      httpError({
        code: 'STATE_CONFLICT',
        reason: 'PERMANENT_ERROR',
        status: 409,
      }),
    );

    expect(view.title).toBe('不可重试的失败');
    expect(view.description).toContain('不能重复重试');
    expect(view.canRetry).toBe(false);
  });

  it('403 SEGREGATION_OF_DUTY → 职责分离，而不是笼统的「无权限」', () => {
    const view = describeEntitlementError(
      httpError({
        code: 'FORBIDDEN',
        reason: 'SEGREGATION_OF_DUTY',
        status: 403,
      }),
    );

    expect(view.kind).toBe('permission');
    expect(view.title).toBe('职责分离限制');
    expect(view.description).toContain('申请人不能审批');
    expect(view.requestId).toBe('req-1');
  });

  it('400 VALIDATION_ERROR → 校验提示，不带后端英文 message', () => {
    const view = describeEntitlementError(
      httpError({ code: 'VALIDATION_ERROR', status: 400 }),
    );

    expect(view.kind).toBe('validation');
    expect(view.title).toBe('提交内容有误');
    expect(view.description).not.toContain('The request failed');
  });

  it('409 IDEMPOTENCY_CONFLICT → 重复提交被拒绝且要求刷新', () => {
    const view = describeEntitlementError(
      httpError({ code: 'IDEMPOTENCY_CONFLICT', status: 409 }),
    );

    expect(view.title).toBe('重复提交被拒绝');
    expect(view.shouldRefresh).toBe(true);
  });

  it('网络失败 → 可重试但要求先确认结果（可能已生成命令）', () => {
    const view = describeEntitlementError(
      new OpsApiError({
        code: 'REQUEST_TIMEOUT',
        kind: 'timeout',
        retryable: true,
        userMessage: '超时',
      }),
    );

    expect(view.kind).toBe('network');
    expect(view.canRetry).toBe(true);
    expect(view.description).toContain('租户命令');
  });

  it('5xx → 结果未知，不能当作成功', () => {
    const view = describeEntitlementError(
      httpError({ code: 'INTERNAL_ERROR', status: 500 }),
    );

    expect(view.kind).toBe('unknown');
    expect(view.canRetry).toBe(true);
    expect(view.description).toContain('刷新');
  });
});
