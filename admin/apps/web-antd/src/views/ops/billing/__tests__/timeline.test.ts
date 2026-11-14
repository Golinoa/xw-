import type { ReceiptDetail, ReceivableDetail } from '#/api/ops/billing/types';

import { describe, expect, it } from 'vitest';

import {
  buildReceiptLedger,
  buildReceivableLedger,
  formatLedgerTime,
  ledgerAmountText,
} from '../timeline';

const OPERATOR = { displayName: '财务复核·李（虚构）', id: 'op-1' };

const receiptDetail: ReceiptDetail = {
  allocations: [
    {
      allocatedAt: '2026-10-20T02:00:00Z',
      allocatedBy: OPERATOR,
      amount: 30_000,
      id: 'a-1',
      receivableDueDate: '2026-11-30',
      receivableId: 'r-5',
      receivablePeriodNo: 2,
      reversedAmount: 0,
    },
  ],
  receipt: {
    allocatedAmount: 30_000,
    amount: 30_000,
    approvedAt: '2026-10-19T01:00:00Z',
    approvedBy: OPERATOR,
    currency: 'CNY',
    customer: { id: 'c-2', name: '云栖数据服务有限公司（虚构）' },
    id: 'p-1',
    method: { code: 'cheque', name: '支票' },
    receiptNo: 'RC-2026-000304',
    recordedBy: OPERATOR,
    recordedReason: '客户支票入账',
    status: 'reconciled',
    transactionDate: '2026-10-18',
    version: 3,
  },
  refunds: [
    {
      amount: 2000,
      id: 'f-1',
      reason: '服务未开通部分退还（虚构数据）',
      refundDate: '2026-10-22',
      refundNo: 'RF-2026-000402',
      status: 'approved',
    },
  ],
  reversals: [
    {
      amount: 20_000,
      createdAt: '2026-10-23T02:00:00Z',
      createdBy: OPERATOR,
      id: 'v-1',
      reason: '重复登记冲正',
      receiptId: 'p-1',
      type: 'receipt_reversal',
    },
  ],
};

describe('账款明细：收款流水', () => {
  const entries = buildReceiptLedger(receiptDetail);

  it('包含登记、审核、核销、冲正、退款五类事件', () => {
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain('receipt_recorded');
    expect(kinds).toContain('receipt_approved');
    expect(kinds).toContain('allocation');
    expect(kinds).toContain('receipt_reversal');
    expect(kinds).toContain('refund');
  });

  it('按时间倒序排列，最新事件在最前', () => {
    expect(entries[0]?.kind).toBe('receipt_reversal');
    const times = entries.map((entry) => entry.at);
    expect(times.toSorted((a, b) => (a < b ? 1 : -1))).toEqual(times);
  });

  it('冲正事件明确关联原收款且标注原记录未被修改', () => {
    const reversal = entries.find((entry) => entry.kind === 'receipt_reversal');
    expect(reversal?.related).toContain('原收款 RC-2026-000304');
    expect(reversal?.related).toContain('原记录未修改');
    expect(reversal?.reason).toBe('重复登记冲正');
    expect(reversal?.actor).toBe('财务复核·李（虚构）');
  });

  it('金额直接取服务端字段，不做换算', () => {
    const reversal = entries.find((entry) => entry.kind === 'receipt_reversal');
    const approved = entries.find((entry) => entry.kind === 'receipt_approved');
    expect(reversal?.amount).toBe(20_000);
    expect(reversal ? ledgerAmountText(reversal) : 'missing').toBe(
      '¥20,000.00',
    );
    expect(approved ? ledgerAmountText(approved) : 'missing').toBe('—');
  });

  it('未审核收款不虚构审核事件', () => {
    const unapproved = buildReceiptLedger({
      ...receiptDetail,
      receipt: {
        ...receiptDetail.receipt,
        approvedAt: null,
        approvedBy: null,
        status: 'recorded',
      },
    });
    expect(unapproved.some((entry) => entry.kind === 'receipt_approved')).toBe(
      false,
    );
  });
});

describe('账款明细：应收流水', () => {
  const detail: ReceivableDetail = {
    allocations: [
      {
        allocatedAt: '2026-10-13T03:00:00Z',
        allocatedBy: OPERATOR,
        amount: 40_000,
        id: 'a-2',
        receiptId: 'p-2',
        receiptNo: 'RC-2026-000302',
        reversedAmount: 0,
      },
    ],
    extensions: [
      {
        createdAt: '2026-10-21T06:00:00Z',
        createdBy: OPERATOR,
        id: 'e-1',
        newDueDate: '2026-11-30',
        previousDueDate: '2026-10-31',
        reason: '客户申请顺延一个月',
      },
    ],
    receivable: {
      allocatedAmount: 40_000,
      amount: 120_000,
      contractId: 'ht-1',
      contractNo: 'HT-2026-000201',
      currency: 'CNY',
      customer: { id: 'c-1', name: '星澜文旅集团有限公司（虚构）' },
      dueDate: '2026-11-30',
      id: 'r-2',
      outstanding: 80_000,
      periodNo: 2,
      status: 'partial',
    },
    reversals: [
      {
        allocationId: 'a-1',
        amount: 15_000,
        createdAt: '2026-10-25T01:30:00Z',
        createdBy: OPERATOR,
        id: 'v-2',
        reason: '核销对象选错',
        type: 'allocation_reversal',
      },
    ],
  };

  const entries = buildReceivableLedger(detail);

  it('展期事件保留原到期日与新到期日', () => {
    const extension = entries.find((entry) => entry.kind === 'extension');
    expect(extension?.related).toBe(
      '原到期日 2026-10-31 → 新到期日 2026-11-30',
    );
    expect(extension?.reason).toBe('客户申请顺延一个月');
    expect(extension?.amount).toBeNull();
  });

  it('撤销核销关联原核销流水并注明保留原记录', () => {
    const reversal = entries.find(
      (entry) => entry.kind === 'allocation_reversal',
    );
    expect(reversal?.related).toContain('原核销保留');
    expect(reversal?.amount).toBe(15_000);
  });

  it('时间展示区分纯日期与时间戳', () => {
    expect(formatLedgerTime('2026-10-18')).toBe('2026-10-18');
    expect(formatLedgerTime('2026-10-18T02:00:00Z')).toContain('2026-10-18');
    expect(formatLedgerTime('')).toBe('—');
  });
});
