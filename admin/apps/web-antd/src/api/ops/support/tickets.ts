/**
 * 工单读取与建单/编辑（契约 §5.8 `GET|POST /tickets`、`GET|PATCH /tickets/{ticketId}`）。
 *
 * 本文件只做「路径 + 参数 + 类型 + 调用 request 客户端」：
 * - 不处理 UI 提示、不跳转、不做业务判断；
 * - 列表的分页/筛选/排序一律走服务端参数（`page`/`pageSize`/`sort`/`order` + §5.8 筛选），
 *   禁止全量拉取后在浏览器过滤；
 * - 状态与指派人**不在这里改**：分别走 `transitions.ts` 的
 *   `POST …/transition` 与 `POST …/assign`，避免「编辑顺手改状态」的越权，
 *   也让每次状态推进都必然产生一条时间线事件。
 */
import type {
  CreateTicketInput,
  CreateTicketResult,
  TicketDetail,
  TicketListQuery,
  TicketListResult,
  UpdateTicketInput,
  UpdateTicketResult,
} from './types';

import {
  buildTicketListParams,
  createIdempotencyKey,
  requestClient,
  TICKET_ENDPOINTS,
  writeConfig,
} from './endpoints';

/** 工单列表（服务端分页/筛选；`overdueOnly` 与 `isOverdue` 都由服务端判定）。 */
export async function fetchTickets(
  query: TicketListQuery = {},
): Promise<TicketListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListTickets } = await import('./dev-stub');
    return stubListTickets(query);
  }
  return requestClient.get<TicketListResult>(TICKET_ENDPOINTS.tickets, {
    params: buildTicketListParams(query),
  });
}

/** 工单详情：`ticket{...}` + `timeline[]` + `references[]` + `allowedActions[]`。 */
export async function fetchTicket(ticketId: string): Promise<TicketDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetTicket } = await import('./dev-stub');
    return stubGetTicket(ticketId);
  }
  return requestClient.get<TicketDetail>(TICKET_ENDPOINTS.ticket(ticketId));
}

/**
 * 创建工单（`ticket.create`，幂等必填）。
 * 400 `REFERENCE_CUSTOMER_MISMATCH` = 关联对象不属于该客户。
 */
export async function createTicket(
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateTicket } = await import('./dev-stub');
    return stubCreateTicket(input);
  }
  return requestClient.post<CreateTicketResult>(
    TICKET_ENDPOINTS.tickets,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 编辑工单字段（不含状态/指派人；`version` 必传，409 表示他人已改）。 */
export async function updateTicket(
  ticketId: string,
  input: UpdateTicketInput,
): Promise<UpdateTicketResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateTicket } = await import('./dev-stub');
    return stubUpdateTicket(ticketId, input);
  }
  return requestClient.request<UpdateTicketResult>(
    TICKET_ENDPOINTS.ticket(ticketId),
    {
      data: input,
      method: 'PATCH',
      ...writeConfig(createIdempotencyKey()),
    },
  );
}
