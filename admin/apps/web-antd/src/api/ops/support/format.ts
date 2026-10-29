/**
 * 工单域展示映射：状态/优先级/事件类型词表、逾期徽标、联系方式掩码、时间格式化。
 *
 * 原则（契约 §2.6）：未知枚举值降级为「未知(原值)」，不留白也不抛错。
 *
 * **逾期口径（硬约束，源码参考门 §4.2）**：本文件只读取服务端下发的
 * `isOverdue`，不存在任何「拿 `dueAt` 与当前时间比较」的代码。客户端时钟/时区与
 * 后端 `Asia/Shanghai` 业务时区不一致时，本地推断会产生假告警，因此宁可显示
 * 「逾期标识未返回」也不自算。
 */
import type {
  TicketActorRef,
  TicketCustomerRef,
  TicketEvent,
  TicketEventType,
  TicketPriority,
  TicketStatus,
} from './types';

import dayjs from 'dayjs';

const UNKNOWN_PREFIX = '未知';

/** Tag 颜色（ant-design-vue 语义色）。 */
export type TicketTagColor =
  | 'blue'
  | 'cyan'
  | 'default'
  | 'green'
  | 'orange'
  | 'purple'
  | 'red';

export interface StatusView {
  color: TicketTagColor;
  /** 是否为已知枚举；未知值用于提示契约漂移。 */
  known: boolean;
  label: string;
}

const STATUS_LABEL: Readonly<Record<TicketStatus, string>> = {
  assigned: '已分派',
  closed: '已关闭',
  in_progress: '处理中',
  new: '待受理',
  resolved: '已解决',
  waiting: '等待中',
};

const STATUS_COLOR: Readonly<Record<TicketStatus, TicketTagColor>> = {
  assigned: 'blue',
  closed: 'default',
  in_progress: 'cyan',
  new: 'orange',
  resolved: 'green',
  waiting: 'purple',
};

const PRIORITY_LABEL: Readonly<Record<TicketPriority, string>> = {
  high: '高',
  low: '低',
  normal: '普通',
  urgent: '紧急',
};

const PRIORITY_COLOR: Readonly<Record<TicketPriority, TicketTagColor>> = {
  high: 'orange',
  low: 'default',
  normal: 'blue',
  urgent: 'red',
};

const EVENT_LABEL: Readonly<Record<TicketEventType, string>> = {
  assigned: '分派',
  closed: '关闭',
  comment: '备注',
  created: '创建',
  linked: '关联',
  reopened: '重开',
  status_changed: '状态变更',
};

const EVENT_COLOR: Readonly<Record<TicketEventType, TicketTagColor>> = {
  assigned: 'blue',
  closed: 'default',
  comment: 'default',
  created: 'default',
  linked: 'purple',
  reopened: 'orange',
  status_changed: 'cyan',
};

function withUnknown<T extends string>(
  value: string,
  labelTable: Readonly<Record<T, string>>,
  colorTable: Readonly<Record<T, TicketTagColor>>,
): StatusView {
  const known = Object.prototype.hasOwnProperty.call(labelTable, value);
  return {
    color: known ? (colorTable[value as T] ?? 'default') : 'default',
    known,
    label: known
      ? (labelTable[value as T] ?? value)
      : `${UNKNOWN_PREFIX}(${value})`,
  };
}

export function ticketStatusView(status: string): StatusView {
  return withUnknown(status, STATUS_LABEL, STATUS_COLOR);
}

export function ticketPriorityView(priority: string): StatusView {
  return withUnknown(priority, PRIORITY_LABEL, PRIORITY_COLOR);
}

export function ticketEventView(eventType: string): StatusView {
  return withUnknown(eventType, EVENT_LABEL, EVENT_COLOR);
}

export const TICKET_STATUS_OPTIONS = (
  ['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed'] as const
).map((value) => ({ label: STATUS_LABEL[value], value }));

export const TICKET_PRIORITY_OPTIONS = (
  ['urgent', 'high', 'normal', 'low'] as const
).map((value) => ({ label: PRIORITY_LABEL[value], value }));

/** 状态是否属于「未办结」（PRD §6.1 开放工单口径：状态不为 resolved/closed）。 */
export function isOpenTicketStatus(status: string): boolean {
  return status !== 'resolved' && status !== 'closed';
}

/**
 * 逾期徽标的展示口径。
 *
 * `known=false` 表示服务端没有下发 `isOverdue`：此时**不显示**徽标，
 * 页面文案说明「逾期标识未返回」，绝不回退到本地时间比较。
 */
export interface OverdueView {
  known: boolean;
  overdue: boolean;
  label: string;
}

export const OVERDUE_SOURCE_NOTE =
  '逾期由服务端按内部工作时限（settings.ticket.dueHours）计算并下发 isOverdue，前端不做本地时间比较。';

export function ticketOverdueView(
  ticket: null | undefined | { isOverdue?: boolean },
): OverdueView {
  const value = ticket?.isOverdue;
  if (value === true) {
    return { known: true, label: '已逾期', overdue: true };
  }
  if (value === false) {
    return { known: true, label: '未逾期', overdue: false };
  }
  return { known: false, label: '逾期标识未返回', overdue: false };
}

/**
 * 客户联系方式展示行（与 customer 域同口径）。
 *
 * 规则：
 * 1. 默认只显示掩码（`maskedPhone`/`maskedEmail`）；
 * 2. 仅当具备 `customer.sensitive.read` **且**后端下发了原值时显示原值——
 *    后端不下发原值时不显示，前端不会尝试「还原」掩码；
 * 3. 掩码缺失时显示「未登记」，不显示空白。
 */
export interface ContactLine {
  label: string;
  masked: boolean;
  value: string;
}

export function ticketContactLines(
  customer: null | TicketCustomerRef | undefined,
  canReadSensitive: boolean,
): ContactLine[] {
  if (!customer) {
    return [];
  }
  const lines: ContactLine[] = [];

  const phone = canReadSensitive ? customer.phone : undefined;
  lines.push({
    label: '电话',
    masked: !phone,
    value: phone ?? customer.maskedPhone ?? '未登记',
  });

  const email = canReadSensitive ? customer.email : undefined;
  lines.push({
    label: '邮箱',
    masked: !email,
    value: email ?? customer.maskedEmail ?? '未登记',
  });

  return lines;
}

/** 联系方式提示文案：说明为什么看到的是掩码。 */
export function contactHint(canReadSensitive: boolean): string {
  return canReadSensitive
    ? '联系方式显示后端下发的原值（仅具备 customer.sensitive.read 且服务端判定可读时）。'
    : '联系方式默认掩码；查看原值需申请 customer.sensitive.read 权限。';
}

/**
 * 操作者归一化：契约列是 `uuid`，展示需要姓名。
 * 取不到姓名时退回 id 前 8 位，绝不渲染空字符串。
 */
export function actorId(
  actor: null | TicketActorRef | undefined,
): null | string {
  if (actor === null || actor === undefined) {
    return null;
  }
  if (typeof actor === 'string') {
    return actor === '' ? null : actor;
  }
  return actor.id === '' ? null : actor.id;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function actorName(actor: null | TicketActorRef | undefined): string {
  if (actor === null || actor === undefined) {
    return '—';
  }
  if (typeof actor === 'string') {
    return actor === '' ? '—' : shortId(actor);
  }
  const name = actor.displayName?.trim() ?? '';
  return name === '' ? shortId(actor.id) : name;
}

/**
 * 事件原因/备注的统一取值。
 *
 * 契约 `ops.ticket_events` 没有 `reason` 列：终态原因可能落在 `reason`
 * （契约推导字段）、`metadata.reason` 或 `body`。按此优先级取，取不到给空串，
 * 由调用方决定是否展示「未填写原因」。
 */
export function eventReason(event: TicketEvent): string {
  const direct = event.reason?.trim() ?? '';
  if (direct !== '') {
    return direct;
  }
  const fromMetadata = event.metadata?.reason;
  if (typeof fromMetadata === 'string' && fromMetadata.trim() !== '') {
    return fromMetadata.trim();
  }
  return event.body?.trim() ?? '';
}

/** 时间戳展示到分钟（后端 UTC ISO 8601，契约 §2.3）。 */
export function formatDateTime(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm') : '—';
}

/** 纯日期展示；空值给占位符，不伪装成「今天」。 */
export function formatDate(value: null | string | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : '—';
}

/** 字段空值占位。 */
export function displayText(value: null | string | undefined): string {
  return value && value.trim() !== '' ? value : '—';
}

/** 关联引用类型的展示文案（契约 §3.8 `ref_type`）。 */
const REF_TYPE_LABEL: Readonly<Record<string, string>> = {
  deployment_version: '部署升级记录',
  entitlement_change: '授权变更',
  tenant_command: '租户同步任务',
};

export function refTypeLabel(refType: string): string {
  return REF_TYPE_LABEL[refType] ?? `${UNKNOWN_PREFIX}(${refType})`;
}

export const TICKET_REF_TYPE_OPTIONS = (
  ['tenant_command', 'entitlement_change', 'deployment_version'] as const
).map((value) => ({ label: REF_TYPE_LABEL[value] ?? value, value }));
