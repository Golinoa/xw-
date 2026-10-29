import { describe, expect, it } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  describeTenantError,
  isTenantAccepted,
  isTenantRefreshRequired,
} from '#/api/ops/tenant/errors';

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
    requestId: 'req-tenant-1',
    retryable: false,
    status: options.status,
    userMessage: 'x',
  });
}

describe('409 冲突：两种 reason 必须区分', () => {
  it('租户绑定冲突（TENANT_MAPPING_CONFLICT）：提示不自动改绑，并要求刷新', () => {
    const view = describeTenantError(
      apiError({
        code: 'CONFLICT',
        reason: 'TENANT_MAPPING_CONFLICT',
        status: 409,
      }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('租户已绑定其他客户');
    expect(view.description).toContain('不会自动改绑');
    expect(view.shouldRefresh).toBe(true);
    expect(
      isTenantRefreshRequired(
        apiError({
          code: 'CONFLICT',
          reason: 'TENANT_MAPPING_CONFLICT',
          status: 409,
        }),
      ),
    ).toBe(true);
  });

  it('同步版本冲突（SYNC_VERSION_CONFLICT）：提示刷新后重试，并要求重新拉取', () => {
    const view = describeTenantError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'SYNC_VERSION_CONFLICT',
        status: 409,
      }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('数据已变化，请刷新后重试');
    expect(view.description).toContain('重新拉取映射详情');
    expect(view.shouldRefresh).toBe(true);
  });

  it('两种冲突的界面文案不同（不能被笼统的「冲突」吞掉）', () => {
    const mapping = describeTenantError(
      apiError({
        code: 'CONFLICT',
        reason: 'TENANT_MAPPING_CONFLICT',
        status: 409,
      }),
    );
    const version = describeTenantError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'SYNC_VERSION_CONFLICT',
        status: 409,
      }),
    );

    expect(mapping.title).not.toBe(version.title);
    expect(mapping.description).not.toBe(version.description);
  });
});

describe('永久性错误与审批前置', () => {
  it('永久性错误（PERMANENT_ERROR）：明确不可重试，且不要求刷新', () => {
    const view = describeTenantError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'PERMANENT_ERROR',
        status: 409,
      }),
    );

    expect(view.title).toBe('永久性错误不可重试');
    expect(view.description).toContain('重试不会改变结果');
    expect(view.shouldRefresh).toBe(false);
  });

  it('审批前置（APPROVAL_REQUIRED）：提示先完成审批', () => {
    const view = describeTenantError(
      apiError({
        code: 'STATE_CONFLICT',
        reason: 'APPROVAL_REQUIRED',
        status: 409,
      }),
    );

    expect(view.title).toBe('需要先完成审批');
  });
});

describe('502 上游不可达：是「已受理」而不是失败', () => {
  it('上游不可达（SYNC_TARGET_UNAVAILABLE）归为 accepted，且不当作错误渲染', () => {
    const error = apiError({ code: 'SYNC_TARGET_UNAVAILABLE', status: 502 });
    const view = describeTenantError(error);

    expect(view.kind).toBe('accepted');
    expect(view.accepted).toBe(true);
    expect(view.title).toBe('已受理，结果待确认');
    expect(isTenantAccepted(error)).toBe(true);
    expect(isTenantRefreshRequired(error)).toBe(true);
  });

  it('普通 500 不会被误判为已受理', () => {
    const view = describeTenantError(
      apiError({ code: 'INTERNAL_ERROR', status: 500 }),
    );

    expect(view.accepted).toBe(false);
    expect(view.canRetry).toBe(true);
  });
});

describe('其它状态码', () => {
  it('403 归为权限问题并保留 requestId', () => {
    const view = describeTenantError(
      apiError({ code: 'FORBIDDEN', status: 403 }),
    );

    expect(view.kind).toBe('permission');
    expect(view.requestId).toBe('req-tenant-1');
  });

  it('400 归为校验问题', () => {
    const view = describeTenantError(
      apiError({ code: 'VALIDATION_ERROR', status: 400 }),
    );

    expect(view.kind).toBe('validation');
  });

  it('网络类失败允许原样重试（复用幂等键不会重复开通）', () => {
    const view = describeTenantError(
      new OpsApiError({
        code: 'NETWORK_ERROR',
        kind: 'network',
        retryable: true,
        userMessage: 'x',
      }),
    );

    expect(view.kind).toBe('network');
    expect(view.canRetry).toBe(true);
    expect(view.description).toContain('幂等键');
  });
});
