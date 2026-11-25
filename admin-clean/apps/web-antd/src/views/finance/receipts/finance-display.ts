import {
  FINANCE_SORT_FIELDS,
  type OutstandingFilter,
  type PayableItem,
  type ReceivableItem,
  type SortOrder,
} from '@erp/contracts';

/**
 * 金额、已确认、在途、可申请余额都是服务端算好的结果。
 * 这里只做机器值 → 文案与行形状归一，页面不再加一手算术，必然不漂移。
 */

export type FinanceKind = 'payable' | 'receivable';
export type FinanceSortField = (typeof FINANCE_SORT_FIELDS)[number];
export type Settlement = PayableItem['settlement'];
export type OutstandingChoice = 'all' | OutstandingFilter;

export interface FinanceSortState {
  order: SortOrder;
  sort: FinanceSortField;
}

export const FINANCE_KINDS: readonly FinanceKind[] = ['receivable', 'payable'];
export const FINANCE_SORT_FIELDS_ORDER: readonly FinanceSortField[] = FINANCE_SORT_FIELDS;

export const SETTLEMENT_LABEL_KEYS: Record<Settlement, string> = {
  monthly: 'shell.receipts.settlementMonthly',
  per_trip: 'shell.receipts.settlementPerTrip',
};

/** 应收侧没有结算方式，null 表示「不适用」而不是缺数据。 */
export function settlementLabelKey(value: null | Settlement): string {
  return value === null ? '' : SETTLEMENT_LABEL_KEYS[value];
}

/** 「全部」只在界面存在，契约 outstanding 只接受 true/false，发请求前必须去掉。 */
export const OUTSTANDING_CHOICES: readonly OutstandingChoice[] = ['all', 'false', 'true'];

export function isOutstandingChoice(value: string): value is OutstandingChoice {
  return value === 'all' || value === 'false' || value === 'true';
}

export function toOutstandingFilter(choice: OutstandingChoice): OutstandingFilter | undefined {
  return choice === 'all' ? undefined : choice;
}

export function isFinanceKind(value: string): value is FinanceKind {
  return value === 'payable' || value === 'receivable';
}

export function isFinanceSortField(value: string): value is FinanceSortField {
  return (FINANCE_SORT_FIELDS as readonly string[]).includes(value);
}

/** 应收与应付归一成同一行形状，模板里就不必到处写 `'settlement' in record` 联合判断。 */
export interface FinanceRow {
  amount: number;
  availableAmount: number;
  confirmedAmount: number;
  createdAt: string;
  customerName: string;
  id: string;
  name: string;
  orderNumber: string;
  orderStatus: ReceivableItem['orderStatus'];
  pendingAmount: number;
  settlement: null | Settlement;
  supplierName: null | string;
}

export function toFinanceRow(item: PayableItem | ReceivableItem): FinanceRow {
  const base = {
    amount: item.amount,
    availableAmount: item.availableAmount,
    confirmedAmount: item.confirmedAmount,
    createdAt: item.createdAt,
    customerName: item.customerName,
    id: item.id,
    name: item.name,
    orderNumber: item.orderNumber,
    orderStatus: item.orderStatus,
    pendingAmount: item.pendingAmount,
  };
  if ('settlement' in item) {
    return { ...base, settlement: item.settlement, supplierName: item.supplierName };
  }
  return { ...base, settlement: null, supplierName: null };
}

export function sortOrderFor(state: FinanceSortState, field: FinanceSortField) {
  if (state.sort !== field) return null;
  return state.order === 'asc' ? 'ascend' : 'descend';
}
