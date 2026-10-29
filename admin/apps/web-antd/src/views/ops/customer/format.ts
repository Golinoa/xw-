/**
 * customer 域展示层格式化与词表映射。
 *
 * 机器状态与展示标签分离（`admin/.harness/FRONTEND.md`）：状态枚举只在契约里定义，
 * 这里只负责翻译；未知枚举降级为 `未知(<raw>)`，不得留白（契约 §2.6）。
 */
import type {
  CustomerStatus,
  CustomerTransitionAction,
} from '#/api/ops/customer';

export const CUSTOMER_STATUS_LABEL: Readonly<Record<CustomerStatus, string>> = {
  active: '服务中',
  onboarding: '交付中',
  signed: '已签约',
  suspended: '已暂停',
  terminated: '已终止',
};

export const CUSTOMER_STATUS_COLOR: Readonly<Record<CustomerStatus, string>> = {
  active: 'success',
  onboarding: 'processing',
  signed: 'default',
  suspended: 'warning',
  terminated: 'error',
};

/** 状态展示文案；未知值降级显示，不抛错（契约 §2.6 前端兼容要求）。 */
export function customerStatusLabel(status: string): string {
  return CUSTOMER_STATUS_LABEL[status as CustomerStatus] ?? `未知(${status})`;
}

export function customerStatusColor(status: string): string {
  return CUSTOMER_STATUS_COLOR[status as CustomerStatus] ?? 'default';
}

/** 客户状态迁移动作 → 中文按钮/审计文案。 */
export const CUSTOMER_ACTION_LABEL: Readonly<
  Record<CustomerTransitionAction, string>
> = {
  activate: '标记为服务中',
  resume: '恢复服务',
  start_onboarding: '开始交付',
  suspend: '暂停服务',
  terminate: '终止客户',
};

/** 契约 §5.2 的 `action` 取值，用于按当前状态渲染可用动作。 */
export const CUSTOMER_ALLOWED_ACTIONS: Readonly<
  Record<CustomerStatus, CustomerTransitionAction[]>
> = {
  active: ['suspend', 'terminate'],
  onboarding: ['activate', 'terminate'],
  signed: ['start_onboarding', 'terminate'],
  suspended: ['resume', 'terminate'],
  terminated: [],
};

/** 需要填写原因的动作（契约 §5.2：`suspend`/`resume`/`terminate` 需 `reason`）。 */
export const CUSTOMER_REASON_REQUIRED: ReadonlySet<CustomerTransitionAction> =
  new Set(['resume', 'suspend', 'terminate']);

/** 纯日期 `YYYY-MM-DD` → 展示文案；空值显示占位符，不伪装成「今天」。 */
export function formatDate(value: null | string | undefined): string {
  return value ? value.slice(0, 10) : '—';
}

/** ISO 时间戳 → `YYYY-MM-DD HH:mm`（本地时区展示，仅用于免歧义场景）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 客户档案字段的空值占位，避免把 `null` 显示成空白。 */
export function displayText(value: null | string | undefined): string {
  return value && value.trim() !== '' ? value : '—';
}
