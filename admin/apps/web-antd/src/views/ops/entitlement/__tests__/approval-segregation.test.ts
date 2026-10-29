import type { EntitlementChangeRequest } from '#/api/ops/entitlement/types';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetStubEntitlementState,
  stubCreateSubscriptionChangeRequest,
  stubTransitionChangeRequest,
} from '#/api/ops/entitlement/dev-stub';
import {
  STUB_ACTIVE_SUBSCRIPTION_ID,
  STUB_CHANGE_REQUESTS,
  STUB_OPERATORS,
  STUB_PENDING_CHANGE_REQUEST_ID,
} from '#/api/ops/entitlement/fixtures';
import { canApproveChangeRequest } from '#/api/ops/entitlement/rules';
import { OPS_PERMISSION } from '#/constants/permissions';

/**
 * 审批人 ≠ 申请人（契约 §3.5 CHECK `approved_by <> requested_by`）。
 *
 * 三层都要一致：规则判定 → 按钮禁用 + 说明 → 服务端 403 SEGREGATION_OF_DUTY。
 */
const REQUESTER = STUB_OPERATORS.requester.id;
const APPROVER = STUB_OPERATORS.approver.id;

function pendingRequest(requestedBy: string): EntitlementChangeRequest {
  return {
    changeType: 'quota_change',
    id: 'cr-test-1',
    reason: '客户新增门店',
    requestedBy: { displayName: '商务运营·周（虚构）', id: requestedBy },
    status: 'pending_approval',
    subjectId: 's-1',
    subjectType: 'subscription',
    version: 2,
  };
}

async function mountActions(input: {
  currentOperatorId: string;
  requestedBy: string;
}) {
  const { mount } = await import('@vue/test-utils');
  const { default: ChangeRequestActions } =
    await import('../components/change-request-actions.vue');
  return mount(ChangeRequestActions, {
    props: {
      changeRequest: pendingRequest(input.requestedBy),
      currentOperatorId: input.currentOperatorId,
      grantedCodes: [
        OPS_PERMISSION.ENTITLEMENT_REQUEST,
        OPS_PERMISSION.ENTITLEMENT_APPROVE,
        OPS_PERMISSION.ENTITLEMENT_EXECUTE,
        OPS_PERMISSION.TENANT_RETRY,
      ],
    },
  });
}

describe('审批人 ≠ 申请人', () => {
  beforeEach(() => {
    resetStubEntitlementState();
  });

  it('规则：申请人自批被拒绝，原因码 segregation_of_duty', () => {
    const decision = canApproveChangeRequest({
      changeRequest: pendingRequest(REQUESTER),
      currentOperatorId: REQUESTER,
      hasApprovePermission: true,
      hasExecutePermission: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('segregation_of_duty');
    expect(decision.message).toContain('提交人');
  }, 20_000);

  it('规则：其他有审批权限的人可以审批', () => {
    const decision = canApproveChangeRequest({
      changeRequest: pendingRequest(REQUESTER),
      currentOperatorId: APPROVER,
      hasApprovePermission: true,
      hasExecutePermission: true,
    });
    expect(decision.allowed).toBe(true);
  }, 20_000);

  it('规则：没有身份信息时拒绝（不允许猜测操作人）', () => {
    const decision = canApproveChangeRequest({
      changeRequest: pendingRequest(REQUESTER),
      currentOperatorId: null,
      hasApprovePermission: true,
      hasExecutePermission: true,
    });
    expect(decision.code).toBe('identity_unknown');
  }, 20_000);

  it('组件：本人提交时审批按钮禁用并说明原因', async () => {
    const wrapper = await mountActions({
      currentOperatorId: REQUESTER,
      requestedBy: REQUESTER,
    });

    const approve = wrapper.find<HTMLButtonElement>(
      '[data-testid="change-request-approve"]',
    );
    const reject = wrapper.find<HTMLButtonElement>(
      '[data-testid="change-request-reject"]',
    );

    expect(approve.exists()).toBe(true);
    expect(approve.element.disabled).toBe(true);
    expect(reject.element.disabled).toBe(true);

    const note = wrapper.find(
      '[data-testid="change-request-approval-blocked"]',
    );
    expect(note.exists()).toBe(true);
    expect(note.text()).toContain('提交人');
    // 不允许出现「执行」按钮（未审批）
    expect(
      wrapper.find('[data-testid="change-request-execute"]').exists(),
    ).toBe(false);
  }, 20_000);

  it('组件：换人审批时按钮可用且不显示职责分离提示', async () => {
    const wrapper = await mountActions({
      currentOperatorId: APPROVER,
      requestedBy: REQUESTER,
    });

    const approve = wrapper.find<HTMLButtonElement>(
      '[data-testid="change-request-approve"]',
    );
    expect(approve.element.disabled).toBe(false);
    expect(
      wrapper.find('[data-testid="change-request-approval-blocked"]').exists(),
    ).toBe(false);
  }, 20_000);

  it('桩复刻服务端：申请人自批返回 403 SEGREGATION_OF_DUTY', async () => {
    const created = await stubCreateSubscriptionChangeRequest(
      STUB_ACTIVE_SUBSCRIPTION_ID,
      {
        changeType: 'quota_change',
        proposedFeatures: [
          {
            enabled: true,
            featureKey: 'travel.guide',
            quota: 60,
            termMonths: 12,
          },
        ],
        reason: '客户新增门店，额度调整',
      },
    );

    await expect(
      stubTransitionChangeRequest(created.changeRequest.id, {
        action: 'approve',
        reason: '自己批一下',
        version: created.changeRequest.version ?? 1,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reason: 'SEGREGATION_OF_DUTY',
      status: 403,
    });
  }, 20_000);

  it('桩：待审批的样例申请由他人审批成功，状态推进为 approved', async () => {
    const pending = STUB_CHANGE_REQUESTS.find(
      (row) => row.id === STUB_PENDING_CHANGE_REQUEST_ID,
    );
    if (!pending) {
      throw new Error('夹具缺少待审批样例');
    }
    const result = await stubTransitionChangeRequest(pending.id, {
      action: 'approve',
      reason: '额度与合同补充协议一致',
      version: pending.version,
    });

    expect(result.changeRequest.status).toBe('approved');
    expect(result.changeRequest.version).toBe(pending.version + 1);
  }, 20_000);
});
