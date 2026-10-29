import { beforeEach, describe, expect, it } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  resetStubEntitlementState,
  stubTransitionChangeRequest,
} from '#/api/ops/entitlement/dev-stub';
import { describeEntitlementError } from '#/api/ops/entitlement/errors';
import { STUB_PENDING_CHANGE_REQUEST_ID } from '#/api/ops/entitlement/fixtures';
import {
  canExecuteChangeRequest,
  canRetryChangeRequest,
} from '#/api/ops/entitlement/rules';

/**
 * 未审批即执行：前端先拦（规则），服务端再拦（409 `APPROVAL_REQUIRED`），
 * 两条路都必须给出可读提示——这是契约 §3.5 / §6.4 的硬性验收点。
 */
const PENDING_ID = STUB_PENDING_CHANGE_REQUEST_ID;

describe('未审批不能执行', () => {
  beforeEach(() => {
    resetStubEntitlementState();
  });

  it('前端规则：pending_approval 执行被拒绝，原因码为 approval_required', () => {
    const decision = canExecuteChangeRequest({
      changeRequest: { status: 'pending_approval' },
      hasExecutePermission: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('approval_required');
    expect(decision.message).toContain('审批');
  });

  it('前端规则：缺少 entitlement.execute 时也拒绝', () => {
    const decision = canExecuteChangeRequest({
      changeRequest: { status: 'approved' },
      hasExecutePermission: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('permission');
  });

  it('前端规则：只有 failed 才能重试，且需要 tenant.retry', () => {
    expect(
      canRetryChangeRequest({
        changeRequest: { status: 'approved' },
        hasExecutePermission: true,
        hasTenantRetryPermission: true,
      }).code,
    ).toBe('state');
    expect(
      canRetryChangeRequest({
        changeRequest: { status: 'failed' },
        hasExecutePermission: true,
        hasTenantRetryPermission: false,
      }).code,
    ).toBe('permission');
    expect(
      canRetryChangeRequest({
        changeRequest: { status: 'failed' },
        hasExecutePermission: true,
        hasTenantRetryPermission: true,
      }).allowed,
    ).toBe(true);
  });

  it('桩复刻服务端不变量：未审批执行 → 409 STATE_CONFLICT / APPROVAL_REQUIRED', async () => {
    await expect(
      stubTransitionChangeRequest(PENDING_ID, {
        action: 'execute',
        reason: '客户催促，直接执行',
        version: 2,
      }),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      reason: 'APPROVAL_REQUIRED',
      status: 409,
    });
  });

  it('409 APPROVAL_REQUIRED 的错误文案明确要求先审批', () => {
    const view = describeEntitlementError(
      new OpsApiError({
        code: 'STATE_CONFLICT',
        details: { reason: 'APPROVAL_REQUIRED' },
        kind: 'http',
        reason: 'APPROVAL_REQUIRED',
        requestId: 'req-approval-1',
        retryable: false,
        status: 409,
        userMessage: 'x',
      }),
    );

    expect(view.kind).toBe('conflict');
    expect(view.title).toBe('需要先完成审批');
    expect(view.description).toContain('审批');
    expect(view.shouldRefresh).toBe(true);
    expect(view.requestId).toBe('req-approval-1');
  });

  it('版本冲突 → 提示刷新后重试，并标记需要重新拉取', () => {
    const view = describeEntitlementError(
      new OpsApiError({
        code: 'CONFLICT',
        kind: 'http',
        retryable: false,
        status: 409,
        userMessage: 'x',
      }),
    );

    expect(view.title).toBe('数据已变化');
    expect(view.description).toContain('刷新');
    expect(view.shouldRefresh).toBe(true);
    // 冲突不是「原样重试」：必须刷新后重走流程
    expect(view.canRetry).toBe(false);
  });
});
