/**
 * 账款明细（流水视图）的事件拼装。
 *
 * 契约没有专门的「跨对象流水」端点（§5.5 只有按对象的详情），因此本页的明细
 * 来自 `GET /receivables/{id}` 与 `GET /receipts/{id}` 返回的
 * `allocations[]` / `extensions[]` / `reversals[]` / `refunds[]`。
 * 这里只做「合并 + 排序 + 归一化文案」，**不做任何金额运算**：
 * 每条事件直接展示服务端返回的金额，合计仍以服务端 summary 为准。
 *
 * 纯函数，便于单测（见 `__tests__/timeline.test.ts`）。
 */
import type { ReceiptDetail, ReceivableDetail } from '#/api/ops/billing/types';

import {
  actorName,
  formatDate,
  formatDateTime,
} from '#/api/ops/billing/format';
import { formatMoney } from '#/api/ops/billing/money';

export type LedgerEntryKind =
  | 'allocation'
  | 'allocation_reversal'
  | 'extension'
  | 'receipt_approved'
  | 'receipt_recorded'
  | 'receipt_reversal'
  | 'refund';

export interface LedgerEntry {
  /** 展示用操作者名（拿不到姓名时回退 id 前 8 位）。 */
  actor: string;
  /** 时间原文：可能是 `YYYY-MM-DD` 或 ISO 8601，展示时按长度区分。 */
  at: string;
  /** 金额原文（服务端返回），`null` 表示该事件没有金额语义。 */
  amount: null | number;
  /** 币种，用于金额格式化。 */
  currency: string;
  id: string;
  kind: LedgerEntryKind;
  /** 原因（服务端 `reason`）；契约没有原因的事件给出明确说明。 */
  reason: string;
  /** 关联对象的人类可读描述，例如「收款 RC-2026-000301」。 */
  related: string;
  title: string;
}

/** 时间展示：纯日期按日期格式，时间戳按本地时区的日期时间格式。 */
export function formatLedgerTime(at: string): string {
  if (!at) {
    return '—';
  }
  return at.length <= 10 ? formatDate(at) : formatDateTime(at);
}

function sortDesc(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.toSorted((left, right) => {
    if (left.at === right.at) {
      return 0;
    }
    return left.at < right.at ? 1 : -1;
  });
}

/** 收款维度的完整流水：登记 → 审核 → 核销 → 撤销/冲正 → 退款。 */
export function buildReceiptLedger(detail: ReceiptDetail): LedgerEntry[] {
  const { receipt } = detail;
  const currency = receipt.currency;
  const entries: LedgerEntry[] = [
    {
      actor: actorName(receipt.recordedBy),
      amount: receipt.amount,
      at: receipt.transactionDate,
      currency,
      id: `${receipt.id}-recorded`,
      kind: 'receipt_recorded',
      reason: receipt.recordedReason ?? '线下收款登记',
      related: `收款 ${receipt.receiptNo}`,
      title: '登记线下收款',
    },
  ];

  if (receipt.approvedAt) {
    entries.push({
      actor: receipt.approvedBy ? actorName(receipt.approvedBy) : '—',
      amount: null,
      at: receipt.approvedAt,
      currency,
      id: `${receipt.id}-approved`,
      kind: 'receipt_approved',
      reason: '审核通过，计入实收',
      related: `收款 ${receipt.receiptNo}`,
      title: '审核收款',
    });
  }

  for (const allocation of detail.allocations) {
    entries.push({
      actor: actorName(allocation.allocatedBy),
      amount: allocation.amount,
      at: allocation.allocatedAt,
      currency,
      id: `allocation-${allocation.id}`,
      kind: 'allocation',
      reason: '核销分配',
      related:
        allocation.receivablePeriodNo === undefined
          ? `应收 ${allocation.receivableId}`
          : `应收第 ${allocation.receivablePeriodNo} 期（${formatDate(allocation.receivableDueDate)} 到期）`,
      title: '核销到应收',
    });
  }

  for (const reversal of detail.reversals) {
    entries.push({
      actor: actorName(reversal.createdBy),
      amount: reversal.amount,
      at: reversal.createdAt,
      currency,
      id: `reversal-${reversal.id}`,
      kind:
        reversal.type === 'receipt_reversal'
          ? 'receipt_reversal'
          : 'allocation_reversal',
      reason: reversal.reason,
      related:
        reversal.type === 'receipt_reversal'
          ? `原收款 ${receipt.receiptNo}（原记录未修改）`
          : `核销流水 ${reversal.allocationId ?? '—'}`,
      title:
        reversal.type === 'receipt_reversal'
          ? '收款冲正（反向流水）'
          : '撤销核销（反向流水）',
    });
  }

  for (const refund of detail.refunds) {
    entries.push({
      actor: '—',
      amount: refund.amount,
      at: refund.refundDate,
      currency,
      id: `refund-${refund.id}`,
      kind: 'refund',
      reason: refund.reason,
      related: `退款 ${refund.refundNo}（${refund.status}）`,
      title: '登记退款',
    });
  }

  return sortDesc(entries);
}

/** 应收维度的完整流水：核销 → 撤销核销 → 展期。 */
export function buildReceivableLedger(detail: ReceivableDetail): LedgerEntry[] {
  const { receivable } = detail;
  const currency = receivable.currency;
  const entries: LedgerEntry[] = [];

  for (const allocation of detail.allocations) {
    entries.push({
      actor: actorName(allocation.allocatedBy),
      amount: allocation.amount,
      at: allocation.allocatedAt,
      currency,
      id: `allocation-${allocation.id}`,
      kind: 'allocation',
      reason: '核销分配',
      related: allocation.receiptNo
        ? `收款 ${allocation.receiptNo}`
        : `收款 ${allocation.receiptId}`,
      title: '收款核销到本期',
    });
  }

  for (const reversal of detail.reversals) {
    entries.push({
      actor: actorName(reversal.createdBy),
      amount: reversal.amount,
      at: reversal.createdAt,
      currency,
      id: `reversal-${reversal.id}`,
      kind: 'allocation_reversal',
      reason: reversal.reason,
      related: `核销流水 ${reversal.allocationId ?? '—'}（原核销保留）`,
      title: '撤销核销',
    });
  }

  for (const extension of detail.extensions) {
    entries.push({
      actor: actorName(extension.createdBy),
      amount: null,
      at: extension.createdAt,
      currency,
      id: `extension-${extension.id}`,
      kind: 'extension',
      reason: extension.reason,
      related: `原到期日 ${formatDate(extension.previousDueDate)} → 新到期日 ${formatDate(extension.newDueDate)}`,
      title: '应收展期（保留原到期日）',
    });
  }

  return sortDesc(entries);
}

/** 事件金额展示（无金额语义时给占位符）。 */
export function ledgerAmountText(entry: LedgerEntry): string {
  return entry.amount === null
    ? '—'
    : formatMoney(entry.amount, entry.currency);
}
