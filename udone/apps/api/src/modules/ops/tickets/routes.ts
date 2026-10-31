import { Hono, type Context } from 'hono';
import {
  DEFAULT_PAGE_SIZE,
  ERROR_CODES,
  OPS_ROUTES,
  opsTicketAssignRequestSchema,
  opsTicketCreateRequestSchema,
  opsTicketEventCreateRequestSchema,
  opsTicketListQuerySchema,
  opsTicketReferenceCreateRequestSchema,
  opsTicketTransitionRequestSchema,
  opsTicketUpdateRequestSchema,
  pageNumberSchema,
  pageSizeSchema,
  type OpsTicketListQuery,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  ticketAssignableOperatorsEnvelopeSchema,
  ticketAssignEnvelopeSchema,
  ticketCreateEnvelopeSchema,
  ticketDetailEnvelopeSchema,
  ticketEventCreateEnvelopeSchema,
  ticketListEnvelopeSchema,
  ticketReferenceCreateEnvelopeSchema,
  ticketTimelineEnvelopeSchema,
  ticketTransitionEnvelopeSchema,
  ticketUpdateEnvelopeSchema,
  toTicket,
  toTicketEvent,
  toTicketListItem,
  toTicketReference,
} from './protocol';

export const opsTicketRoutes = new Hono<ApiEnvironment>();

/**
 * 支撑域（契约 §5.6 的十个端点：售后工单与时间线）。
 *
 * 四处照抄别的域会错的地方：
 *
 * 1. **静态路由必须先注册**。`/tickets/assignable-operators` 排在
 *    `/tickets/:ticketId` 之前，否则 `assignable-operators` 会被当成 ticketId
 *    去解析 uuid，用户看到的是「工单不存在」而不是「路由写错了」。
 *
 * 2. **`status` / `priority` 都是多选**（`context.req.queries()`）。`req.query()`
 *    对重复键只返回最后一个值，照抄单值解析会把「多选」静默变成「只筛最后一个」。
 *
 * 3. **`transition` 的权限按动作分流**：`close` / `reopen` 要 `ticket.close`，
 *    其余要 `ticket.update`。路由层的 `requireOpsPermission` 只能表达一个权限，
 *    所以这里先查 `ticket.update`（`close`/`reopen` 的调用方必然也有它），真正的
 *    分流在 RPC 里做——两边都判，路由层挡掉绝大多数，库层挡住「绕过路由」。
 *
 * 4. **三个写端点必须显式断言幂等键**（§5.6 标注「必填」的 create / assign /
 *    transition）。全局幂等中间件对缺键请求放行，所以漏带时工单会被创建两次，
 *    用户看到的是两条一样的记录。
 */

/** 共享的 RPC 调用与形状校验（与应收域同构）。 */
async function callOpsRpc<S extends z.ZodType>(
  context: Context<ApiEnvironment>,
  name: string,
  body: Record<string, unknown>,
  schema: S,
): Promise<z.output<S>> {
  const client = createRestClient(context.env, context.get('opsToken'));

  let payload: unknown;
  try {
    payload = await client.rest<unknown>(`rpc/${name}`, { method: 'POST', body, profile: 'ops' });
  } catch (cause) {
    const requestId = context.get('requestId');
    if (cause instanceof RestConflictError) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The support directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The support directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The support directory rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The support directory is unavailable',
      );
    }
    throw cause;
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'ops_rpc_shape_invalid',
        rpc: name,
        requestId: context.get('requestId'),
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }),
    );
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The support directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

function requireIdempotencyKey(context: Context<ApiEnvironment>): void {
  if (!context.req.header('Idempotency-Key')) {
    throw new ApiHttpError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'The Idempotency-Key header is required for this endpoint',
      { field: 'Idempotency-Key' },
    );
  }
}

function missing(resource = 'ticket'): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The ticket does not exist', { resource });
}

function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The ticket request was rejected', {
    reason,
    ...details,
  });
}

/**
 * 409 `STATE_CONFLICT` + `{reason, allowedActions}`。
 *
 * `allowedActions` 与详情里的同名字段同源（库里的 `ops.allowed_ticket_actions`）：
 * 前端拿到 409 时能直接把按钮刷成合法集合，不必再拉一次详情。
 */
function stateConflict(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.STATE_CONFLICT, 'The ticket state does not allow it', {
    reason,
    ...details,
  });
}

function versionConflict(currentVersion: number): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The ticket was modified by someone else', {
    currentVersion,
  });
}

/** `status` / `priority` 走 `queries()`，布尔串显式判两个值（`'false'` 不是真值）。 */
function parseTicketListQuery(context: Context<ApiEnvironment>): OpsTicketListQuery {
  const raw: Record<string, unknown> = { ...context.req.query() };

  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;
  const priorities = context.req.queries('priority');
  if (priorities) raw.priority = priorities;

  for (const key of ['unassigned', 'overdueOnly'] as const) {
    const value = raw[key];
    if (value === 'true' || value === '1') raw[key] = true;
    else if (value === 'false' || value === '0') raw[key] = false;
    else if (value === undefined || value === '') delete raw[key];
  }

  const parsed = opsTicketListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The query parameters are invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

/** `GET /api/v1/ops/tickets` */
opsTicketRoutes.get(OPS_ROUTES.listOpsTickets.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.read');
  const query = parseTicketListQuery(context);

  const result = await callOpsRpc(
    context,
    'list_tickets',
    {
      p_customer_id: query.customerId ?? null,
      p_statuses: query.status ?? null,
      p_priorities: query.priority ?? null,
      p_assignee_operator_id: query.assigneeOperatorId ?? null,
      p_product_id: query.productId ?? null,
      p_updated_from: query.updatedFrom ?? null,
      p_created_from: query.createdFrom ?? null,
      p_created_to: query.createdTo ?? null,
      p_unassigned: query.unassigned ?? false,
      p_overdue_only: query.overdueOnly ?? false,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    ticketListEnvelopeSchema,
  );

  return respond(context, 'listOpsTickets', {
    items: result.items.map(toTicketListItem),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/**
 * `GET /api/v1/ops/tickets/assignable-operators`
 *
 * 排在 `/:ticketId` 之前（见文件头第 1 条）。
 */
opsTicketRoutes.get(
  OPS_ROUTES.listOpsTicketAssignableOperators.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'ticket.read');
    const keyword = context.req.query('keyword');

    const result = await callOpsRpc(
      context,
      'list_assignable_operators',
      { p_keyword: keyword ?? null },
      ticketAssignableOperatorsEnvelopeSchema,
    );

    return respond(context, 'listOpsTicketAssignableOperators', {
      items: result.items.map((operator) => ({
        id: operator.id,
        displayName: operator.display_name,
        status: operator.status,
      })),
    });
  },
);

/** `POST /api/v1/ops/tickets` */
opsTicketRoutes.post(OPS_ROUTES.createOpsTicket.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.create');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsTicketCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_ticket',
    {
      p_customer_id: body.customerId,
      p_subject: body.subject,
      p_description: body.description,
      p_issue_type: body.issueType,
      p_priority: body.priority,
      p_product_id: body.productId ?? null,
      p_contract_id: body.contractId ?? null,
      p_tenant_mapping_id: body.tenantMappingId ?? null,
      p_deployment_instance_id: body.deploymentInstanceId ?? null,
    },
    ticketCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'createOpsTicket', { ticket: toTicket(result.ticket) }, 201);
  }

  switch (result.status) {
    case 'customer_not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist', {
        resource: 'customer',
      });
    case 'subject_required':
      throw rejected('SUBJECT_REQUIRED', { field: 'subject' });
    case 'description_required':
      throw rejected('DESCRIPTION_REQUIRED', { field: 'description' });
    case 'issue_type_required':
      throw rejected('ISSUE_TYPE_REQUIRED', { field: 'issueType' });
    case 'priority_invalid':
      throw rejected('PRIORITY_INVALID', { field: 'priority' });
    case 'reference_not_found':
      throw rejected('REFERENCE_NOT_FOUND', { field: result.field });
    case 'reference_customer_mismatch':
      // 契约 §6.4 定死了这个 reason 拼写。
      throw rejected('REFERENCE_CUSTOMER_MISMATCH', { field: result.field });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/tickets/{ticketId}` */
opsTicketRoutes.get(OPS_ROUTES.getOpsTicket.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.read');
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_ticket',
    { p_ticket_id: params.ticketId },
    ticketDetailEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'getOpsTicket', {
      ticket: toTicket(result.ticket),
      timeline: result.timeline.map(toTicketEvent),
      references: result.references.map(toTicketReference),
      allowedActions: result.allowed_actions,
      assignableOperators: result.assignable_operators.map((operator) => ({
        id: operator.id,
        displayName: operator.display_name,
        status: operator.status,
      })),
    });
  }

  throw missing();
});

/** `PATCH /api/v1/ops/tickets/{ticketId}` */
opsTicketRoutes.patch(OPS_ROUTES.updateOpsTicket.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.update');
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));
  const body = await parseJson(context, opsTicketUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_ticket',
    {
      p_ticket_id: params.ticketId,
      p_expected_version: body.version,
      p_subject: body.subject ?? null,
      p_description: body.description ?? null,
      p_issue_type: body.issueType ?? null,
      p_priority: body.priority ?? null,
    },
    ticketUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsTicket', { ticket: toTicket(result.ticket) });
  }

  switch (result.status) {
    case 'ticket_not_found':
      throw missing();
    case 'version_mismatch':
      throw versionConflict(result.current_version);
    case 'priority_invalid':
      throw rejected('PRIORITY_INVALID', { field: 'priority' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/tickets/{ticketId}/assign` */
opsTicketRoutes.post(OPS_ROUTES.assignOpsTicket.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.assign');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));
  const body = await parseJson(context, opsTicketAssignRequestSchema);

  const result = await callOpsRpc(
    context,
    'assign_ticket',
    {
      p_ticket_id: params.ticketId,
      p_assignee_operator_id: body.assigneeOperatorId,
      p_expected_version: body.version,
      p_reason: body.reason ?? null,
    },
    ticketAssignEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'assignOpsTicket', {
      ticket: toTicket(result.ticket),
      event: { id: result.event.id },
    });
  }

  switch (result.status) {
    case 'ticket_not_found':
      throw missing();
    case 'version_mismatch':
      throw versionConflict(result.current_version);
    case 'ticket_closed':
      throw stateConflict('TICKET_CLOSED', { allowedActions: result.allowed_actions });
    case 'assignee_not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The assignee does not exist', {
        resource: 'operator',
      });
    case 'assignee_inactive':
      // 停用成员不能接单：分给一个不会看到它的人，是「已分派」的假象。
      throw stateConflict('ASSIGNEE_INACTIVE', { assigneeStatus: result.assignee_status });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/tickets/{ticketId}/transition` */
opsTicketRoutes.post(OPS_ROUTES.transitionOpsTicket.path, requireOpsAuth(), async (context) => {
  // 分流在库层（见文件头第 3 条）：路由层先要 ticket.update，close/reopen 的库层
  // 检查再要 ticket.close。两个都判，任一层缺失都不会让「能处理的人也能关闭」成立。
  requireOpsPermission(context, 'ticket.update');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));
  const body = await parseJson(context, opsTicketTransitionRequestSchema);

  const result = await callOpsRpc(
    context,
    'transition_ticket',
    {
      p_ticket_id: params.ticketId,
      p_action: body.action,
      p_expected_version: body.version,
      p_waiting_on: body.waitingOn ?? null,
      p_resolution_summary: body.resolutionSummary ?? null,
      p_reason: body.reason ?? null,
    },
    ticketTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsTicket', {
      ticket: toTicket(result.ticket),
      event: { id: result.event.id },
    });
  }

  switch (result.status) {
    case 'ticket_not_found':
      throw missing();
    case 'version_mismatch':
      throw versionConflict(result.current_version);
    case 'invalid_transition':
      throw stateConflict('INVALID_TRANSITION', {
        current: result.current,
        action: result.action,
        allowedActions: result.allowed_actions,
      });
    case 'waiting_on_required':
      throw rejected('WAITING_ON_REQUIRED', { field: 'waitingOn' });
    case 'resolution_summary_required':
      throw rejected('RESOLUTION_SUMMARY_REQUIRED', { field: 'resolutionSummary' });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/tickets/{ticketId}/timeline` */
opsTicketRoutes.get(OPS_ROUTES.listOpsTicketTimeline.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.read');
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));

  const paging = z
    .object({
      page: pageNumberSchema.default(1),
      pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
    })
    .safeParse({
      page: context.req.query('page'),
      pageSize: context.req.query('pageSize'),
    });

  if (!paging.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The query parameters are invalid', {
      issues: paging.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
      })),
    });
  }

  const result = await callOpsRpc(
    context,
    'list_ticket_timeline',
    {
      p_ticket_id: params.ticketId,
      p_limit: paging.data.pageSize,
      p_offset: (paging.data.page - 1) * paging.data.pageSize,
    },
    ticketTimelineEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'listOpsTicketTimeline', {
      items: result.items.map(toTicketEvent),
      total: result.total,
      page: paging.data.page,
      pageSize: paging.data.pageSize,
    });
  }

  throw missing();
});

/** `POST /api/v1/ops/tickets/{ticketId}/events` */
opsTicketRoutes.post(OPS_ROUTES.createOpsTicketEvent.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'ticket.update');
  const params = parseParams(context, z.object({ ticketId: z.uuid() }));
  const body = await parseJson(context, opsTicketEventCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'add_ticket_event',
    { p_ticket_id: params.ticketId, p_body: body.body },
    ticketEventCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsTicketEvent',
      {
        event: { id: result.event.id, eventType: result.event.event_type },
      },
      201,
    );
  }

  switch (result.status) {
    case 'ticket_not_found':
      throw missing();
    case 'ticket_closed':
      // 契约 §5.6：关闭的工单只允许 reopen。
      throw stateConflict('TICKET_CLOSED', { allowedActions: result.allowed_actions });
    case 'body_required':
      throw rejected('BODY_REQUIRED', { field: 'body' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/tickets/{ticketId}/references` */
opsTicketRoutes.post(
  OPS_ROUTES.createOpsTicketReference.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'ticket.update');
    const params = parseParams(context, z.object({ ticketId: z.uuid() }));
    const body = await parseJson(context, opsTicketReferenceCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'add_ticket_reference',
      {
        p_ticket_id: params.ticketId,
        p_ref_type: body.refType,
        p_ref_id: body.refId,
      },
      ticketReferenceCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsTicketReference',
        { reference: toTicketReference(result.reference) },
        201,
      );
    }

    switch (result.status) {
      case 'ticket_not_found':
        throw missing();
      case 'invalid_ref_type':
        throw rejected('INVALID_REF_TYPE', { allowedRefTypes: result.allowed_ref_types });
      case 'reference_not_found':
        throw rejected('REFERENCE_NOT_FOUND', { field: 'refId' });
      case 'reference_exists':
        // 契约 §5.6：重复关联是 409 CONFLICT，不是 400 —— 请求本身合法，
        // 是当前状态（已关联）与它冲突。
        throw new ApiHttpError(
          409,
          ERROR_CODES.CONFLICT,
          'The reference is already linked to this ticket',
          { reason: 'REFERENCE_EXISTS' },
        );
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);
