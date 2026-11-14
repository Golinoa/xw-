/**
 * 工单时间线与事件追加（契约 §5.8 `GET …/timeline`、`POST …/events`、`POST …/references`）。
 *
 * 时间线是 `ops.ticket_events` 的**只读投影**：表仅 INSERT，本文件不提供任何
 * 编辑/删除函数——「不可覆盖」是数据库约束，界面上不给入口只是顺带。
 *
 * 详情响应已内嵌 `timeline[]`（契约 §5.8），因此列表式分页端点只用于
 * 「详情未返回时间线」或「事件很多需要翻页」的场景，避免重复请求。
 */
import type {
  AddTicketCommentInput,
  AddTicketCommentResult,
  AddTicketReferenceInput,
  AddTicketReferenceResult,
  TicketTimelineQuery,
  TicketTimelineResult,
} from './types';

import {
  createIdempotencyKey,
  requestClient,
  TICKET_ENDPOINTS,
  writeConfig,
} from './endpoints';

/** 时间线（按 `created_at` 升序由服务端返回；前端只做展示排序兜底）。 */
export async function fetchTicketTimeline(
  ticketId: string,
  query: TicketTimelineQuery = {},
): Promise<TicketTimelineResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListTicketTimeline } = await import('./dev-stub');
    return stubListTicketTimeline(ticketId, query);
  }
  return requestClient.get<TicketTimelineResult>(
    TICKET_ENDPOINTS.timeline(ticketId),
    { params: query },
  );
}

/**
 * 追加内部说明/沟通摘要（`eventType='comment'`）。
 * 409 `STATE_CONFLICT` = 工单已关闭（契约 §5.8：`closed` 只允许 `reopen`）。
 */
export async function addTicketComment(
  ticketId: string,
  input: AddTicketCommentInput,
): Promise<AddTicketCommentResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubAddTicketComment } = await import('./dev-stub');
    return stubAddTicketComment(ticketId, input);
  }
  return requestClient.post<AddTicketCommentResult>(
    TICKET_ENDPOINTS.events(ticketId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 追加关联（租户同步任务 / 授权变更 / 部署升级记录）。
 * 400 `REFERENCE_CUSTOMER_MISMATCH` = 引用对象不属于该工单客户；409 = 重复关联。
 */
export async function addTicketReference(
  ticketId: string,
  input: AddTicketReferenceInput,
): Promise<AddTicketReferenceResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubAddTicketReference } = await import('./dev-stub');
    return stubAddTicketReference(ticketId, input);
  }
  return requestClient.post<AddTicketReferenceResult>(
    TICKET_ENDPOINTS.references(ticketId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
