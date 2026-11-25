import { SETTLEMENT_STATUSES, type SettlementStatus } from '@erp/contracts';

/** 机器值 → i18n 文案键与标签色。 */
export const SETTLEMENT_STATUS_LABEL_KEYS: Record<SettlementStatus, string> = {
  cancelled: 'shell.settlements.statusCancelled',
  confirmed: 'shell.settlements.statusConfirmed',
  draft: 'shell.settlements.statusDraft',
};

export const SETTLEMENT_STATUS_COLORS: Record<SettlementStatus, string> = {
  cancelled: 'red',
  confirmed: 'green',
  draft: 'default',
};

export const SETTLEMENT_STATUSES_ORDER: readonly SettlementStatus[] = SETTLEMENT_STATUSES;

export function isSettlementStatus(value: string): value is SettlementStatus {
  return (SETTLEMENT_STATUSES as readonly string[]).includes(value);
}

/** `2026-11` → `2026 年 11 月`，只做展示不参与比较。 */
export function formatPeriodMonth(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  return year && month ? `${year} / ${Number(month)}` : periodMonth;
}

/** 已确认批次作废要写原因，草稿不需要；真正的强制在库函数里。 */
export function cancelNeedsReason(status: SettlementStatus): boolean {
  return status === 'confirmed';
}
