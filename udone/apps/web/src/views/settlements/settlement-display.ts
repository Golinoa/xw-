import { SETTLEMENT_STATUSES, type SettlementStatus } from '@erp/contracts';

/** 结算批次状态的中文文案与标签色。枚举是机器值，文案只在这里维护。 */
export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  cancelled: '已作废',
};

export const SETTLEMENT_STATUS_COLORS: Record<SettlementStatus, string> = {
  draft: 'default',
  confirmed: 'green',
  cancelled: 'red',
};

export function isSettlementStatus(value: string): value is SettlementStatus {
  return (SETTLEMENT_STATUSES as readonly string[]).includes(value);
}

/** `2026-11` → `2026 年 11 月`。只做展示，不参与任何比较。 */
export function formatPeriodMonth(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  if (!year || !month) return periodMonth;
  return `${year} 年 ${Number(month)} 月`;
}

/**
 * 已确认批次作废要写原因，草稿不需要。
 * 页面用它决定「作废」弹窗要不要强制填原因 —— 但真正的强制在库函数里，
 * 这里只是别让用户白白提交一次。
 */
export function cancelNeedsReason(status: SettlementStatus): boolean {
  return status === 'confirmed';
}
