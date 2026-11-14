/**
 * 工单分派与状态流转（契约 §5.8 `POST /tickets/{id}/assign`、`…/transition`）。
 *
 * 为什么单独成文件：这两条是工单的**唯一**状态写入通道，每次调用都会追加一条
 * 不可覆盖的时间线事件（`assigned` / `status_changed` / `reopened` / `closed`）。
 * 页面不得通过 `PATCH /tickets/{id}` 改状态——契约的 PATCH 请求体里根本没有 `status`。
 *
 * 两个函数都要求 `version`（乐观锁）：并发下他人已流转时服务端返回 409，
 * 页面必须刷新后重试（源码参考门 §3.1/§4.2 同一约束）。
 */
import type {
  AssignTicketInput,
  TicketMutationResult,
  TicketTransitionInput,
} from './types';

import {
  createIdempotencyKey,
  requestClient,
  TICKET_ENDPOINTS,
  writeConfig,
} from './endpoints';

/**
 * 分派/改派（`ticket.assign`）。
 *
 * 409 `STATE_CONFLICT` 的典型原因：工单已 `closed`（契约 §5.8 明确「closed 不可直接分派」），
 * 需先重开再分派。
 */
export async function assignTicket(
  ticketId: string,
  input: AssignTicketInput,
): Promise<TicketMutationResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubAssignTicket } = await import('./dev-stub');
    return stubAssignTicket(ticketId, input);
  }
  return requestClient.post<TicketMutationResult>(
    TICKET_ENDPOINTS.assign(ticketId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 状态流转（`start`/`wait`/`resume`/`resolve`/`close`/`reopen`）。
 *
 * - 权限：`start`/`wait`/`resume`/`resolve` 需 `ticket.update`；
 *   `close`/`reopen` 需 `ticket.close`（契约 §5.8）。
 * - 守卫：`wait` 必带 `waitingOn`；`resolve` 必带 `resolutionSummary`；
 *   `close`/`reopen` 必带 `reason`（契约 §3.8 + 源码参考门 §4.1）。
 * - 失败 409 `STATE_CONFLICT` 会带 `details.allowedActions`，页面据此刷新渲染。
 */
export async function transitionTicket(
  ticketId: string,
  input: TicketTransitionInput,
): Promise<TicketMutationResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionTicket } = await import('./dev-stub');
    return stubTransitionTicket(ticketId, input);
  }
  return requestClient.post<TicketMutationResult>(
    TICKET_ENDPOINTS.transition(ticketId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
