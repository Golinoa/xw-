import type { ApprovalFlow } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

/**
 * 审批流配置仓储：读写都走 RPC。
 *
 * 直接写表不行——`set_approval_flow` 里带了权限校验与「1–3 级」校验，
 * 绕过它就等于把审批链的正确性交给调用方。
 */
export interface ApprovalFlowRepository {
  get(organizationId: string): Promise<ApprovalFlow>;
  save(organizationId: string, flow: ApprovalFlow): Promise<void>;
}

/** 与 `public.default_approval_flow()` 一致：财务审批 → 管理员终审。 */
const DEFAULT_FLOW: ApprovalFlow = {
  steps: [
    { step: 1, permission: 'finance.approve' },
    { step: 2, permission: 'settings.manage' },
  ],
  allowSelfApproval: false,
  allowWithdraw: true,
};

export function approvalFlowRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): ApprovalFlowRepository {
  const client = createRestClient(environment, token);

  return {
    async get(organizationId) {
      // 这个函数返回单个 jsonb，PostgREST 给的是对象而不是数组。
      const payload = await client.rest<ApprovalFlow | ApprovalFlow[]>(
        'rpc/effective_approval_flow',
        {
          method: 'POST',
          organizationId,
          body: { target_organization_id: organizationId },
        },
      );
      const flow = Array.isArray(payload) ? payload[0] : payload;
      return flow ?? DEFAULT_FLOW;
    },

    async save(organizationId, flow) {
      await client.rest('rpc/set_approval_flow', {
        method: 'POST',
        organizationId,
        body: {
          requested_steps: flow.steps,
          requested_allow_self_approval: flow.allowSelfApproval,
          requested_allow_withdraw: flow.allowWithdraw,
        },
      });
    },
  };
}
