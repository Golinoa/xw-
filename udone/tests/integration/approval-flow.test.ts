import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface ApprovalFlowBody {
  steps: { step: number; permission: string }[];
  allowSelfApproval: boolean;
  allowWithdraw: boolean;
}

const DEFAULT_STEPS = [
  { step: 1, permission: 'finance.approve' },
  { step: 2, permission: 'settings.manage' },
];

describe('审批流配置走真实 PostgREST', () => {
  it('未配置时读到的就是默认两级', async () => {
    const response = await call<ApprovalFlowBody>('/api/approvals/flow', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body.steps).toEqual(DEFAULT_STEPS);
    expect(response.body.allowSelfApproval).toBe(false);
  });

  it('管理员保存后回读到新配置', async () => {
    const saved = await call<ApprovalFlowBody>('/api/approvals/flow', {
      method: 'PATCH',
      actor: 'admin',
      body: {
        steps: [{ step: 1, permission: 'settings.manage' }],
        allowSelfApproval: false,
        allowWithdraw: false,
      },
    });
    expectStatus(saved, 200);
    expect(saved.body.steps).toEqual([{ step: 1, permission: 'settings.manage' }]);
    expect(saved.body.allowWithdraw).toBe(false);

    const reread = await call<ApprovalFlowBody>('/api/approvals/flow', { actor: 'admin' });
    expectStatus(reread, 200);
    expect(reread.body.steps).toEqual([{ step: 1, permission: 'settings.manage' }]);
    expect(reread.body.allowWithdraw).toBe(false);

    // 恢复默认，避免污染后续用例（审批级次会影响申请能走几步）。
    const restored = await call<ApprovalFlowBody>('/api/approvals/flow', {
      method: 'PATCH',
      actor: 'admin',
      body: { steps: DEFAULT_STEPS, allowSelfApproval: false, allowWithdraw: true },
    });
    expectStatus(restored, 200);
  });

  it('普通成员能读但不能改', async () => {
    const readable = await call<ApprovalFlowBody>('/api/approvals/flow', { actor: 'operator' });
    expectStatus(readable, 200);

    const denied = await call('/api/approvals/flow', {
      method: 'PATCH',
      actor: 'operator',
      body: { steps: DEFAULT_STEPS, allowSelfApproval: true, allowWithdraw: true },
    });
    expectStatus(denied, 403);
  });

  it('级次断号被拒，且库里配置不变', async () => {
    const rejected = await call('/api/approvals/flow', {
      method: 'PATCH',
      actor: 'admin',
      body: {
        steps: [
          { step: 1, permission: 'finance.approve' },
          { step: 3, permission: 'settings.manage' },
        ],
        allowSelfApproval: false,
        allowWithdraw: true,
      },
    });
    expectStatus(rejected, 400);

    const current = await call<ApprovalFlowBody>('/api/approvals/flow', { actor: 'admin' });
    expectStatus(current, 200);
    expect(current.body.steps).toEqual(DEFAULT_STEPS);
  });
});
