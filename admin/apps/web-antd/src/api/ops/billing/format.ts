import type {
  BillingMethodRef,
  OpsActorRef,
  ReceiptStatus,
  ReceivableStatus,
  RefundStatus,
} from './types';

/**
 * 账款域展示映射：状态标签、操作者/收款方式归一化、日期格式化。
 *
 * 原则（`Docs/ops-api-contract.md` §2.6）：未知枚举值必须降级为「未知(原值)」，
 * 不能渲染空白——否则后端加法式新增状态会让页面出现"没有状态"的脏数据观感。
 */
import dayjs from 'dayjs';

/** 未知枚举的展示前缀。 */
const UNKNOWN_PREFIX = '未知';

/** Tag 颜色（ant-design-vue 语义色）。 */
export type OpsTagColor = 'blue' | 'default' | 'green' | 'orange' | 'red';

const RECEIVABLE_STATUS_LABEL: Readonly<Record<ReceivableStatus, string>> = {
  overdue: '逾期',
  paid: '已收清',
  partial: '部分收款',
  reversed: '已冲销',
  unpaid: '未收',
  upcoming: '未到期',
};

const RECEIVABLE_STATUS_COLOR: Readonly<Record<ReceivableStatus, OpsTagColor>> =
  {
    overdue: 'red',
    paid: 'green',
    partial: 'blue',
    reversed: 'default',
    unpaid: 'orange',
    upcoming: 'default',
  };

const RECEIPT_STATUS_LABEL: Readonly<Record<ReceiptStatus, string>> = {
  pending_reconcile: '已审核待核销',
  recorded: '已登记未审核',
  reconciled: '已核销',
  refunded: '已退款',
  reversed: '已冲正',
};

const RECEIPT_STATUS_COLOR: Readonly<Record<ReceiptStatus, OpsTagColor>> = {
  pending_reconcile: 'blue',
  // 未审核不计入实收：用警示色提醒"这笔钱还没进实收"
  recorded: 'orange',
  reconciled: 'green',
  refunded: 'default',
  reversed: 'red',
};

const REFUND_STATUS_LABEL: Readonly<Record<RefundStatus, string>> = {
  approved: '已审核',
  cancelled: '已取消',
  recorded: '已登记未审核',
};

const REFUND_STATUS_COLOR: Readonly<Record<RefundStatus, OpsTagColor>> = {
  approved: 'green',
  cancelled: 'default',
  recorded: 'orange',
};

export interface StatusView {
  color: OpsTagColor;
  label: string;
}

function withUnknown(
  value: string,
  table: Readonly<Record<string, string>>,
  colorTable: Readonly<Record<string, OpsTagColor>>,
  fallbackColor: OpsTagColor = 'default',
): StatusView & { known: boolean } {
  const known = Object.prototype.hasOwnProperty.call(table, value);
  return {
    color: known ? (colorTable[value] ?? fallbackColor) : fallbackColor,
    known,
    label: known ? (table[value] ?? value) : `${UNKNOWN_PREFIX}(${value})`,
  };
}

export function receivableStatusView(status: string): StatusView {
  return withUnknown(status, RECEIVABLE_STATUS_LABEL, RECEIVABLE_STATUS_COLOR);
}

export function receiptStatusView(status: string): StatusView {
  return withUnknown(status, RECEIPT_STATUS_LABEL, RECEIPT_STATUS_COLOR);
}

export function refundStatusView(status: string): StatusView {
  return withUnknown(status, REFUND_STATUS_LABEL, REFUND_STATUS_COLOR);
}

/** 应收状态筛选下拉选项（按契约优先级顺序）。 */
export const RECEIVABLE_STATUS_OPTIONS = (
  ['upcoming', 'partial', 'overdue', 'paid', 'reversed'] as const
).map((value) => ({ label: RECEIVABLE_STATUS_LABEL[value], value }));

export const RECEIPT_STATUS_OPTIONS = (
  [
    'recorded',
    'pending_reconcile',
    'reconciled',
    'refunded',
    'reversed',
  ] as const
).map((value) => ({ label: RECEIPT_STATUS_LABEL[value], value }));

export const REFUND_STATUS_OPTIONS = (
  ['recorded', 'approved', 'cancelled'] as const
).map((value) => ({ label: REFUND_STATUS_LABEL[value], value }));

/** 收款方式下拉：契约未给字典端点，先给线下可用集合，值域以字典为准（见 journal）。 */
export const RECEIPT_METHOD_OPTIONS = [
  { label: '银行转账', value: 'bank_transfer' },
  { label: '现金', value: 'cash' },
  { label: '支票', value: 'cheque' },
  { label: '其它线下方式', value: 'other_offline' },
];

/**
 * 操作者 ID 归一化。
 * 兼容契约的两种可能形态（id 字符串 / `{id,displayName}`），见 `types.ts` 的「待确认」说明。
 */
export function actorId(actor: null | OpsActorRef | undefined): null | string {
  if (actor === null || actor === undefined) {
    return null;
  }
  if (typeof actor === 'string') {
    return actor === '' ? null : actor;
  }
  return actor.id === '' ? null : actor.id;
}

/** 操作者展示名；拿不到姓名时退回 id 前 8 位，绝不渲染成空。 */
export function actorName(actor: null | OpsActorRef | undefined): string {
  if (actor === null || actor === undefined) {
    return '—';
  }
  if (typeof actor === 'string') {
    return actor === '' ? '—' : shortId(actor);
  }
  const name = actor.displayName?.trim() ?? '';
  return name === '' ? shortId(actor.id) : name;
}

/** 收款方式展示名。 */
export function methodLabel(
  method: BillingMethodRef | null | undefined,
): string {
  if (method === null || method === undefined) {
    return '—';
  }
  const raw =
    typeof method === 'string' ? method : (method.name ?? method.code);
  const option = RECEIPT_METHOD_OPTIONS.find((item) => item.value === raw);
  return option?.label ?? raw;
}

/** 收款方式代码，用于筛选回填。 */
export function methodCode(
  method: BillingMethodRef | null | undefined,
): string {
  if (method === null || method === undefined) {
    return '';
  }
  return typeof method === 'string' ? method : method.code;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** 纯日期 `YYYY-MM-DD` 原样展示；异常值不猜。 */
export function formatDate(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : '—';
}

/** 时间戳按浏览器本地时区展示到分钟；后端返回 UTC ISO 8601（契约 §2.3）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}
