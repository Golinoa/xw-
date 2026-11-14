import { describe, expect, it, vi } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  describeTicketError,
  isTicketRefreshRequired,
} from '#/api/ops/support/errors';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 409 冲突是工单域的真实常态（两个运营同时处理同一单，后提交者 version 过期）。
 *
 * 口径：必须提示「数据已变化，请刷新后重试」+ 要求重新拉取，并带上服务端返回的
 * 当前可用动作——这就是「他人已流转」的可读证据。绝不本地覆盖或静默重试。
 */
function httpError(options: {
  code: string;
  details?: Record<string, unknown>;
  reason?: string;
  status: number;
}): OpsApiError {
  return new OpsApiError({
    code: options.code,
    details: options.details,
    kind: 'http',
    raw: undefined,
    reason: options.reason,
    requestId: 'req-ticket-1',
    retryable: false,
    status: options.status,
    userMessage: 'The request failed',
  });
}

describe('工单错误映射', () => {
  it('409 CONFLICT（版本冲突）→ 数据已变化，请刷新后重试', () => {
    const view = describeTicketError(
      httpError({ code: 'CONFLICT', status: 409 }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.description).toContain('数据已变化，请刷新后重试');
    expect(view.shouldRefresh).toBe(true);
    expect(view.canRetry).toBe(false);
    expect(
      isTicketRefreshRequired(httpError({ code: 'CONFLICT', status: 409 })),
    ).toBe(true);
  }, 20_000);

  it('409 STATE_CONFLICT → 展示服务端当前可用动作（他人已流转）', () => {
    const error = httpError({
      code: 'STATE_CONFLICT',
      details: { allowedActions: ['reopen'], reason: undefined },
      status: 409,
    });
    const view = describeTicketError(error);

    expect(view.title).toBe('工单状态已变化');
    expect(view.allowedActions).toEqual(['reopen']);
    expect(view.description).toContain('reopen');
    expect(view.shouldRefresh).toBe(true);
  }, 20_000);

  it('403 明确指向权限，且不可重试', () => {
    const view = describeTicketError(
      httpError({ code: 'FORBIDDEN', status: 403 }),
    );

    expect(view.kind).toBe('permission');
    expect(view.canRetry).toBe(false);
    expect(view.shouldRefresh).toBe(false);
    expect(view.description).toContain('动作码');
  }, 20_000);

  it('400 REFERENCE_CUSTOMER_MISMATCH 说明引用不属于该客户', () => {
    const view = describeTicketError(
      httpError({
        code: 'VALIDATION_ERROR',
        reason: 'REFERENCE_CUSTOMER_MISMATCH',
        status: 400,
      }),
    );

    expect(view.kind).toBe('validation');
    expect(view.description).toContain('不属于该工单客户');
  }, 20_000);

  it('网络失败：结果未知，先刷新确认再重试', () => {
    const error = new OpsApiError({
      code: 'NETWORK_ERROR',
      kind: 'network',
      raw: undefined,
      retryable: true,
      userMessage: 'network',
    });
    const view = describeTicketError(error);

    expect(view.kind).toBe('network');
    expect(view.canRetry).toBe(true);
    expect(view.description).toContain('刷新');
  }, 20_000);
});
