/**
 * 工单时间线的拼装与排序。
 *
 * 契约 §3.8：`ops.ticket_events` 仅 INSERT，`INDEX(ticket_id, created_at)`；
 * 源码参考门 §4.3：时间线是核心可读物——「谁在什么时候因为什么把状态改成了什么」。
 *
 * 这里只做「排序 + 归一化文案」，不发请求、不判断权限：
 * - **升序**：从创建到现在，读起来就是一条处理经过；服务端可能倒序返回，故统一重排。
 * - 同秒事件保持服务端原序（`toSorted` 是稳定排序），不按字符串再抖一次。
 * - 原因/备注取 `eventReason()`：契约 `ticket_events` 没有 `reason` 列，终态原因
 *   可能落在 `reason`/`metadata.reason`/`body`，取值口径集中在 `format.ts`。
 */
import type { TicketEvent, TicketEventType } from '#/api/ops/support/types';

import {
  actorName,
  eventReason,
  formatDateTime,
  ticketEventView,
  ticketStatusView,
} from '#/api/ops/support/format';

export type TimelineKind = 'assignment' | 'comment' | 'lifecycle' | 'status';

export interface TimelineEntry {
  actor: string;
  /** 展示时间（本地时区 `YYYY-MM-DD HH:mm`）。 */
  at: string;
  /** 状态变迁路径，如「待受理 → 已分派」；非状态事件为空串。 */
  change: string;
  /** 事件类型徽标颜色（未知类型给 default）。 */
  color: string;
  /** 事件 ID，用于列表 key。 */
  id: string;
  /** 事件类型展示名。 */
  label: string;
  /** 原始事件类型（未知值原样保留，便于排查契约漂移）。 */
  rawType: string;
  /** 原因/备注正文；没有就是空串，由组件决定是否显示占位。 */
  reason: string;
  /** 原始时间戳（排序与调试用）。 */
  rawAt: string;
  kind: TimelineKind;
  /** 等待对象（`wait` 事件才有）。 */
  waitingOn: string;
}

function kindOf(eventType: string | TicketEventType): TimelineKind {
  if (eventType === 'assigned') {
    return 'assignment';
  }
  if (eventType === 'comment') {
    return 'comment';
  }
  if (eventType === 'status_changed') {
    return 'status';
  }
  return 'lifecycle';
}

function changeOf(event: TicketEvent): string {
  if (!event.fromStatus && !event.toStatus) {
    return '';
  }
  if (!event.fromStatus) {
    return ticketStatusView(String(event.toStatus)).label;
  }
  if (!event.toStatus) {
    return ticketStatusView(String(event.fromStatus)).label;
  }
  return `${ticketStatusView(String(event.fromStatus)).label} → ${
    ticketStatusView(String(event.toStatus)).label
  }`;
}

/** 单条事件的展示模型。 */
export function toTimelineEntry(event: TicketEvent): TimelineEntry {
  const view = ticketEventView(String(event.eventType));
  return {
    actor: actorName(event.actor),
    at: formatDateTime(event.createdAt),
    change: changeOf(event),
    // antd 时间线圆点：`default` 不是合法预设色，统一降级为灰色圆点。
    color: view.color === 'default' ? 'gray' : view.color,
    id: event.id,
    kind: kindOf(String(event.eventType)),
    label: view.label,
    rawAt: event.createdAt,
    rawType: String(event.eventType),
    reason: eventReason(event),
    waitingOn: event.waitingOn?.trim() ?? '',
  };
}

/**
 * 时间线（**升序**）。
 *
 * 入参可能是详情内嵌的 `timeline[]`，也可能是分页端点的 `items[]`；
 * 两者形态一致，统一在页面侧重排，避免依赖服务端顺序。
 */
export function buildTicketTimeline(
  events: null | readonly TicketEvent[] | undefined,
): TimelineEntry[] {
  if (!events || events.length === 0) {
    return [];
  }
  return events
    .map((event) => ({ entry: toTimelineEntry(event), raw: event }))
    .toSorted((left, right) => {
      const leftTime = left.raw.createdAt ?? '';
      const rightTime = right.raw.createdAt ?? '';
      if (leftTime === rightTime) {
        return 0;
      }
      return leftTime < rightTime ? -1 : 1;
    })
    .map((item) => item.entry);
}

/** 时间线概览计数（详情页顶部一行摘要，避免运营逐条数）。 */
export interface TimelineSummary {
  assignments: number;
  comments: number;
  statusChanges: number;
  total: number;
}

export function summarizeTimeline(
  entries: readonly TimelineEntry[],
): TimelineSummary {
  return {
    assignments: entries.filter((entry) => entry.kind === 'assignment').length,
    comments: entries.filter((entry) => entry.kind === 'comment').length,
    statusChanges: entries.filter((entry) => entry.kind === 'status').length,
    total: entries.length,
  };
}
