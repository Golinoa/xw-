import { beforeEach, describe, expect, it } from 'vitest';

import { OpsApiError } from '#/api/adapter/errors';
import {
  resetStubBillingState,
  stubAllocateReceipt,
  stubExtendReceivable,
  stubListReceivables,
  stubReverseReceipt,
  stubTransitionReceipt,
} from '#/api/ops/billing/dev-stub';
import { STUB_CURRENT_OPERATOR_ID } from '#/api/ops/billing/fixtures';

const RECORDED_BY_CURRENT = '44444444-4444-4444-8444-444444444403';
const PENDING_RECEIPT = '44444444-4444-4444-8444-444444444406';
const PAID_RECEIVABLE = '33333333-3333-4333-8333-333333333301';

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
 * 开发态契约桩必须复刻服务端不变量，否则前端会在"假的成功"里漏掉真实错误分支。
 */
describe('开发态账款桩的拒绝路径', () => {
  beforeEach(() => {
    resetStubBillingState();
  });

  it('登记人自己审核 → 403 SEGREGATION_OF_DUTY', async () => {
    const error = await catchError(
      stubTransitionReceipt(RECORDED_BY_CURRENT, {
        action: 'approve',
        reason: '自己审核',
        version: 1,
      }),
    );
    expect(error.status).toBe(403);
    expect(error.reason).toBe('SEGREGATION_OF_DUTY');
  });

  it('未审核收款参与核销 → 409 RECEIPT_NOT_APPROVED', async () => {
    const error = await catchError(
      stubAllocateReceipt(RECORDED_BY_CURRENT, {
        allocations: [
          {
            amount: 100,
            receivableId: '33333333-3333-4333-8333-333333333301',
          },
        ],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reason).toBe('RECEIPT_NOT_APPROVED');
  });

  it('单期超额核销 → 409 RECEIVABLE_EXCEEDED', async () => {
    const error = await catchError(
      stubAllocateReceipt(PENDING_RECEIPT, {
        allocations: [
          {
            // 首期已收清（未收余额 0），任何金额都超该期余额
            amount: 100,
            receivableId: PAID_RECEIVABLE,
          },
        ],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reason).toBe('RECEIVABLE_EXCEEDED');
  });

  it('收款可分配额不足 → 409 RECEIPT_EXCEEDED', async () => {
    const error = await catchError(
      stubAllocateReceipt(PENDING_RECEIPT, {
        allocations: [
          {
            amount: 10_000,
            receivableId: '33333333-3333-4333-8333-333333333302',
          },
          {
            amount: 10_000,
            receivableId: '33333333-3333-4333-8333-333333333303',
          },
        ],
      }),
    );
    expect(error.reason).toBe('RECEIPT_EXCEEDED');
  });

  it('已结清应收展期 → 409 RECEIVABLE_SETTLED', async () => {
    const error = await catchError(
      stubExtendReceivable(PAID_RECEIVABLE, {
        newDueDate: '2026-12-31',
        reason: '客户申请',
        version: 2,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.reason).toBe('RECEIVABLE_SETTLED');
  });

  it('仍有有效核销时冲正 → 409 HAS_ALLOCATIONS', async () => {
    const error = await catchError(
      stubReverseReceipt('44444444-4444-4444-8444-444444444401', {
        reason: '重复登记',
        version: 3,
      }),
    );
    expect(error.reason).toBe('HAS_ALLOCATIONS');
  });

  it('应收状态由服务端派生，前端不自行推算', async () => {
    const result = await stubListReceivables({ page: 1, pageSize: 15 });
    const statuses = new Set(result.items.map((item) => item.status));
    expect(statuses.size).toBeGreaterThan(0);
    expect(result.summary).toBeDefined();
    // 合计必须是服务端字段，不是前端累加
    expect(typeof result.summary?.outstandingAmount).toBe('number');
  });

  it('桩数据全部是虚构内容', async () => {
    const result = await stubListReceivables({ page: 1, pageSize: 15 });
    for (const item of result.items) {
      expect(item.customer.name).toContain('虚构');
    }
    expect(STUB_CURRENT_OPERATOR_ID).toMatch(
      /^00000000-0000-4000-8000-000000000001$/,
    );
  });
});
