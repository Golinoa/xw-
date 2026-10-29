import {
  FINANCE_SORT_FIELDS,
  type OrderStatus,
  type OutstandingFilter,
  type PayableItem,
  type ReceivableItem,
  type SortOrder,
} from '@erp/contracts';

/**
 * 财务明细列表的展示层映射。
 *
 * 这里只做「机器值 → 文案」的翻译与列定义，不做任何金额计算：
 * 金额、已确认、在途、可申请余额都是服务端算好的结果，页面再加一手必然漂移。
 */

/** 两个页签共用一套行结构，差异只在供应商与结算方式两列。 */
export type FinanceKind = 'receivable' | 'payable';

export type FinanceSortField = (typeof FINANCE_SORT_FIELDS)[number];

export interface FinanceSortState {
  sort: FinanceSortField;
  order: SortOrder;
}

/** 结算方式：`monthly` 按月统一结算，`per_trip` 每个团单独结算（R-SETTLE-01）。 */
export type Settlement = PayableItem['settlement'];

export const SETTLEMENT_LABELS: Record<Settlement, string> = {
  monthly: '月结',
  per_trip: '单团结算',
};

/** 应收侧没有结算方式，`null` 表示「不适用」而不是缺数据。 */
export function settlementLabel(value: Settlement | null): string {
  return value === null ? '—' : SETTLEMENT_LABELS[value];
}

/**
 * 结清状态下拉。`all` 只存在于界面：契约 `outstandingSchema` 只接受 'true' / 'false'，
 * 所以「全部」必须在发请求前被去掉，不能原样传给服务端。
 */
export type OutstandingChoice = OutstandingFilter | 'all';

export const OUTSTANDING_OPTIONS: { value: OutstandingChoice; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'true', label: '仅未结清' },
  { value: 'false', label: '仅已结清' },
];

export function isOutstandingChoice(value: string): value is OutstandingChoice {
  return value === 'all' || value === 'true' || value === 'false';
}

export function toOutstandingFilter(choice: OutstandingChoice): OutstandingFilter | undefined {
  return choice === 'all' ? undefined : choice;
}

export function isFinanceKind(value: string): value is FinanceKind {
  return value === 'receivable' || value === 'payable';
}

export function isFinanceSortField(value: string): value is FinanceSortField {
  return FINANCE_SORT_FIELDS.some((field) => field === value);
}

/**
 * 表格行。应收与应付归一成同一种形状，避免模板里到处写 `'supplierName' in record`
 * 这类联合类型判断；供应商与结算方式在应收侧固定为 `null`。
 */
export interface FinanceRow {
  id: string;
  orderNumber: string;
  /** 父订单不在当前数据范围时为 null，此时订单号与客户都不能展示。 */
  orderStatus: OrderStatus | null;
  customerName: string;
  name: string;
  amount: number;
  confirmedAmount: number;
  pendingAmount: number;
  availableAmount: number;
  createdAt: string;
  supplierName: string | null;
  settlement: Settlement | null;
}

export function toFinanceRow(item: ReceivableItem | PayableItem): FinanceRow {
  const base: Omit<FinanceRow, 'supplierName' | 'settlement'> = {
    id: item.id,
    orderNumber: item.orderNumber,
    orderStatus: item.orderStatus,
    customerName: item.customerName,
    name: item.name,
    amount: item.amount,
    confirmedAmount: item.confirmedAmount,
    pendingAmount: item.pendingAmount,
    availableAmount: item.availableAmount,
    createdAt: item.createdAt,
  };
  if ('settlement' in item) {
    return { ...base, supplierName: item.supplierName, settlement: item.settlement };
  }
  return { ...base, supplierName: null, settlement: null };
}

/** 列定义用的最小结构，够 a-table 消费即可，不引入框架内部类型。 */
export interface FinanceColumn {
  title: string;
  dataIndex: string;
  key: string;
  width?: number;
  align?: 'left' | 'right';
  sorter?: boolean;
  sortOrder?: 'ascend' | 'descend' | null;
}

function sortOrderFor(
  state: FinanceSortState,
  field: FinanceSortField,
): 'ascend' | 'descend' | null {
  if (state.sort !== field) return null;
  return state.order === 'asc' ? 'ascend' : 'descend';
}

/**
 * 生成列表列。可排序的只有契约白名单里的三个字段：按订单号排序要跨表，
 * PostgREST 做不到，摆一个点了会报错的表头不如不摆。
 */
export function financeColumns(kind: FinanceKind, state: FinanceSortState): FinanceColumn[] {
  const columns: FinanceColumn[] = [
    { title: '订单号', dataIndex: 'orderNumber', key: 'orderNumber', width: 170 },
    { title: '客户', dataIndex: 'customerName', key: 'customerName', width: 140 },
  ];
  if (kind === 'payable') {
    columns.push({ title: '供应商', dataIndex: 'supplierName', key: 'supplierName', width: 160 });
  }
  columns.push(
    { title: '项目名称', dataIndex: 'name', key: 'name' },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 130,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderFor(state, 'amount'),
    },
    {
      title: '已确认',
      dataIndex: 'confirmedAmount',
      key: 'confirmedAmount',
      width: 130,
      align: 'right',
    },
    {
      title: '在途',
      dataIndex: 'pendingAmount',
      key: 'pendingAmount',
      width: 120,
      align: 'right',
    },
    {
      title: '可申请余额',
      dataIndex: 'availableAmount',
      key: 'availableAmount',
      width: 140,
      align: 'right',
      sorter: true,
      sortOrder: sortOrderFor(state, 'availableAmount'),
    },
  );
  if (kind === 'payable') {
    columns.push({ title: '结算方式', dataIndex: 'settlement', key: 'settlement', width: 120 });
  }
  columns.push({
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 170,
    sorter: true,
    sortOrder: sortOrderFor(state, 'createdAt'),
  });
  return columns;
}
