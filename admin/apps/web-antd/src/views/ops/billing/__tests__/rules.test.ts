import { describe, expect, it } from 'vitest';

import {
  canAllocateReceipt,
  canExtendReceivable,
  canRefundReceipt,
  canReverseAllocation,
  canReverseReceipt,
  canReviewReceipt,
  checkAllocations,
  validateReason,
} from '#/api/ops/billing/rules';

const RECORDER = '00000000-0000-4000-8000-000000000003';
const REVIEWER = '00000000-0000-4000-8000-000000000002';

describe('审核收款：登记人 ≠ 审核人（职责分离）', () => {
  it('当前登录人是登记人时，审核按钮不可用并给出原因', () => {
    const decision = canReviewReceipt({
      currentOperatorId: RECORDER,
      hasApprovePermission: true,
      recordedBy: RECORDER,
      status: 'recorded',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('segregation_of_duty');
    expect(decision.message).toContain('登记人');
  });

  it('操作者是对象形态 {id,displayName} 时同样能识别', () => {
    const decision = canReviewReceipt({
      currentOperatorId: RECORDER,
      hasApprovePermission: true,
      recordedBy: { displayName: '收款登记·王（虚构）', id: RECORDER },
      status: 'recorded',
    });
    expect(decision.code).toBe('segregation_of_duty');
  });

  it('换一个人审核即可通过', () => {
    const decision = canReviewReceipt({
      currentOperatorId: REVIEWER,
      hasApprovePermission: true,
      recordedBy: RECORDER,
      status: 'recorded',
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('无 receipt.approve 时按钮不可用', () => {
    const decision = canReviewReceipt({
      currentOperatorId: REVIEWER,
      hasApprovePermission: false,
      recordedBy: RECORDER,
      status: 'recorded',
    });
    expect(decision.code).toBe('permission');
  });

  it('只有 recorded 状态可审核（已审核不能重复审核）', () => {
    const decision = canReviewReceipt({
      currentOperatorId: REVIEWER,
      hasApprovePermission: true,
      recordedBy: RECORDER,
      status: 'pending_reconcile',
    });
    expect(decision.code).toBe('state');
  });

  it('拿不到当前操作人身份时不放行', () => {
    const decision = canReviewReceipt({
      currentOperatorId: null,
      hasApprovePermission: true,
      recordedBy: RECORDER,
      status: 'recorded',
    });
    expect(decision.code).toBe('identity_unknown');
  });
});

describe('核销前置条件', () => {
  it('未审核收款不能核销', () => {
    const decision = canAllocateReceipt({
      hasPermission: true,
      status: 'recorded',
    });
    expect(decision.code).toBe('receipt_not_approved');
  });

  it('已冲正/已退款收款不能核销', () => {
    expect(
      canAllocateReceipt({ hasPermission: true, status: 'reversed' }).code,
    ).toBe('state');
    expect(
      canAllocateReceipt({ hasPermission: true, status: 'refunded' }).code,
    ).toBe('state');
  });

  it('已审核待核销可以核销', () => {
    expect(
      canAllocateReceipt({ hasPermission: true, status: 'pending_reconcile' }),
    ).toEqual({ allowed: true });
  });
});

describe('冲正与退款前置条件', () => {
  it('仍有有效核销时不能冲正，提示先撤销核销', () => {
    const decision = canReverseReceipt({
      hasActiveAllocations: true,
      hasPermission: true,
      status: 'reconciled',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain('撤销核销');
  });

  it('无有效核销可以冲正', () => {
    expect(
      canReverseReceipt({
        hasActiveAllocations: false,
        hasPermission: true,
        status: 'pending_reconcile',
      }),
    ).toEqual({ allowed: true });
  });

  it('已冲正不能重复冲正', () => {
    expect(
      canReverseReceipt({
        hasActiveAllocations: false,
        hasPermission: true,
        status: 'reversed',
      }).code,
    ).toBe('state');
  });

  it('未审核收款不能登记退款', () => {
    expect(
      canRefundReceipt({ hasPermission: true, status: 'recorded' }).code,
    ).toBe('receipt_not_approved');
  });

  it('核销已全部撤销时不能再次撤销', () => {
    expect(
      canReverseAllocation({ hasPermission: true, remainingAmount: 0 }).code,
    ).toBe('state');
  });
});

describe('展期：未结清才可展期', () => {
  it('已收清不可展期', () => {
    const decision = canExtendReceivable({
      hasPermission: true,
      outstanding: 0,
      status: 'paid',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('receivable_settled');
    expect(decision.message).toContain('已结清');
  });

  it('已冲销不可展期', () => {
    expect(
      canExtendReceivable({ hasPermission: true, status: 'reversed' }).code,
    ).toBe('receivable_reversed');
  });

  it('未收余额为 0 时按已结清处理（不依赖状态字段）', () => {
    expect(
      canExtendReceivable({
        hasPermission: true,
        outstanding: 0,
        status: 'partial',
      }).code,
    ).toBe('receivable_settled');
  });

  it('部分收款（未结清）可以展期', () => {
    expect(
      canExtendReceivable({
        hasPermission: true,
        outstanding: 80_000,
        status: 'partial',
      }),
    ).toEqual({ allowed: true });
  });

  it('缺少 receivable.write 不可展期', () => {
    expect(
      canExtendReceivable({ hasPermission: false, status: 'partial' }).code,
    ).toBe('permission');
  });
});

describe('必填原因', () => {
  it('空白原因被拒绝', () => {
    expect(validateReason('   ').ok).toBe(false);
    expect(validateReason('   ').message).toContain('原因');
  });

  it('超长原因被拒绝，正常原因通过并 trim', () => {
    expect(validateReason('x'.repeat(501)).ok).toBe(false);
    const result = validateReason('  客户退回部分款项  ');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('客户退回部分款项');
  });
});

describe('核销提交前校验（超额拦截）', () => {
  const baseLine = {
    currency: 'CNY',
    customerId: 'c1',
    outstanding: 80_000,
    receivableId: 'r1',
  };

  it('单期超额被拦截', () => {
    const result = checkAllocations({
      lines: [{ ...baseLine, amountInput: '80000.01' }],
      receiptAllocatedAmount: 0,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.ok).toBe(false);
    expect(result.lineIssues.map((issue) => issue.code)).toContain(
      'receivable_exceeded',
    );
  });

  it('合计超过收款可分配余额被拦截', () => {
    const result = checkAllocations({
      lines: [
        { ...baseLine, amountInput: '60000', receivableId: 'r1' },
        {
          amountInput: '50000',
          currency: 'CNY',
          customerId: 'c1',
          outstanding: 100_000,
          receivableId: 'r2',
        },
      ],
      receiptAllocatedAmount: 5000,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.ok).toBe(false);
    expect(result.formIssues.map((issue) => issue.code)).toContain(
      'receipt_exceeded',
    );
    // 合计只用于提示，仍然精确到分
    expect(result.total).toBe('110000.00');
    expect(result.allocatable).toBe('95000.00');
  });

  it('负数金额被拦截', () => {
    const result = checkAllocations({
      lines: [{ ...baseLine, amountInput: '-1' }],
      receiptAllocatedAmount: 0,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.ok).toBe(false);
    expect(result.lineIssues[0]?.message).toContain('负数');
  });

  it('跨客户/跨币种被拦截', () => {
    const result = checkAllocations({
      lines: [
        { ...baseLine, amountInput: '100', currency: 'USD' },
        {
          ...baseLine,
          amountInput: '100',
          customerId: 'c2',
          receivableId: 'r2',
        },
      ],
      receiptAllocatedAmount: 0,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    const codes = result.lineIssues.map((issue) => issue.code);
    expect(codes).toContain('currency_mismatch');
    expect(codes).toContain('customer_mismatch');
  });

  it('同一期应收重复填写被拦截', () => {
    const result = checkAllocations({
      lines: [
        { ...baseLine, amountInput: '100' },
        { ...baseLine, amountInput: '200' },
      ],
      receiptAllocatedAmount: 0,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.lineIssues.map((issue) => issue.code)).toContain(
      'duplicate_receivable',
    );
  });

  it('小数分精度不产生假超额', () => {
    const result = checkAllocations({
      lines: [
        {
          amountInput: '0.1',
          currency: 'CNY',
          customerId: 'c1',
          outstanding: 0.1,
          receivableId: 'r1',
        },
        {
          amountInput: '0.2',
          currency: 'CNY',
          customerId: 'c1',
          outstanding: 0.2,
          receivableId: 'r2',
        },
      ],
      receiptAllocatedAmount: 0,
      receiptAmount: 0.3,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe('0.30');
    expect(result.allocatable).toBe('0.30');
  });

  it('一条都没填时提示需要至少一条', () => {
    const result = checkAllocations({
      lines: [],
      receiptAllocatedAmount: 0,
      receiptAmount: 100_000,
      receiptCurrency: 'CNY',
      receiptCustomerId: 'c1',
    });
    expect(result.ok).toBe(false);
    expect(result.formIssues[0]?.message).toContain('至少');
  });
});
