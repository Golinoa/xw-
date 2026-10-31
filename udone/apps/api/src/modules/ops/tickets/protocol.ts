import {
  z,
  type OpsTicket,
  type OpsTicketActor,
  type OpsTicketEvent,
  type OpsTicketListItem,
  type OpsTicketReference,
} from '@erp/contracts';

/**
 * 支撑域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 与其它域同构，两处值得单独写下来：
 *
 * 1. **`due_at` / `closed_at` 是 `nullable`**。`jsonb_build_object` 对 SQL NULL
 *    会产出 JSON `null`（键仍然存在），所以 schema 必须允许 null 而不是
 *    `.optional()`——`.optional()` 只容忍「键不在」，而键一定在。
 *
 * 2. **`is_overdue` 是布尔值，不是「有 due_at 就算逾期」**。它由库算好传下来，
 *    这里只做透传：任何在出站层重算的做法都会让「列表显示的逾期」与
 *    「overdueOnly 筛出来的逾期」变成两个口径。
 */
export const ticketActorRowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  status: z.string().min(1),
});

export const ticketCustomerRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

export const ticketRowSchema = z.object({
  id: z.string().min(1),
  ticket_no: z.string().min(1),
  customer_id: z.string().min(1),
  customer: ticketCustomerRowSchema,
  product_id: z.string().nullable(),
  contract_id: z.string().nullable(),
  tenant_mapping_id: z.string().nullable(),
  deployment_instance_id: z.string().nullable(),
  subject: z.string().min(1),
  description: z.string().min(1),
  issue_type: z.string().min(1),
  priority: z.enum(['urgent', 'high', 'normal', 'low']),
  status: z.enum(['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed']),
  assignee: ticketActorRowSchema.nullable(),
  waiting_on: z.string().nullable(),
  resolution_summary: z.string().nullable(),
  due_at: z.string().nullable(),
  is_overdue: z.boolean(),
  closed_at: z.string().nullable(),
  reopen_count: z.number().int().min(0),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const ticketEventRowSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  actor: ticketActorRowSchema.nullable(),
  body: z.string().nullable(),
  waiting_on: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string().min(1),
});

export const ticketReferenceRowSchema = z.object({
  ref_type: z.enum(['tenant_command', 'entitlement_change', 'deployment_version']),
  ref_id: z.string().min(1),
  created_by: z.string().nullable(),
  created_at: z.string().min(1),
});

/** 每次写操作的失败分支都带一个能直接渲染的定位信息（字段名 / 当前版本 / 可用动作）。 */
export const ticketListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  total: z.number().int().min(0),
  items: z.array(ticketRowSchema),
});

export const ticketDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    ticket: ticketRowSchema,
    timeline: z.array(ticketEventRowSchema),
    references: z.array(ticketReferenceRowSchema),
    allowed_actions: z.array(z.string()),
    assignable_operators: z.array(ticketActorRowSchema),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
]);

export const ticketCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), ticket: ticketRowSchema }),
  z.object({ status: z.literal('customer_not_found') }),
  z.object({ status: z.literal('subject_required') }),
  z.object({ status: z.literal('description_required') }),
  z.object({ status: z.literal('issue_type_required') }),
  z.object({ status: z.literal('priority_invalid') }),
  z.object({
    status: z.literal('reference_not_found'),
    field: z.string(),
  }),
  z.object({
    status: z.literal('reference_customer_mismatch'),
    field: z.string(),
  }),
]);

export const ticketUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), ticket: ticketRowSchema }),
  z.object({ status: z.literal('ticket_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('priority_invalid') }),
]);

export const ticketAssignEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    ticket: ticketRowSchema,
    event: z.object({ id: z.string().min(1) }),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({
    status: z.literal('ticket_closed'),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('assignee_not_found') }),
  z.object({
    status: z.literal('assignee_inactive'),
    assignee_status: z.string(),
  }),
]);

export const ticketTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    ticket: ticketRowSchema,
    event: z.object({ id: z.string().min(1) }),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  /**
   * 非法迁移必须回 `allowed_actions`：前端拿它直接渲染按钮，而不是自己维护
   * 一份状态机（两份状态机的漂移是这类页面最常见的缺陷）。
   */
  z.object({
    status: z.literal('invalid_transition'),
    current: z.string(),
    action: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('waiting_on_required') }),
  z.object({ status: z.literal('resolution_summary_required') }),
  z.object({ status: z.literal('reason_required') }),
]);

export const ticketEventCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    event: z.object({ id: z.string().min(1), event_type: z.string().min(1) }),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
  z.object({
    status: z.literal('ticket_closed'),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('body_required') }),
]);

export const ticketReferenceCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    reference: ticketReferenceRowSchema,
    event: z.object({ id: z.string().min(1) }),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
  z.object({
    status: z.literal('invalid_ref_type'),
    allowed_ref_types: z.array(z.string()),
  }),
  z.object({ status: z.literal('reference_not_found') }),
  z.object({ status: z.literal('reference_exists') }),
]);

export const ticketTimelineEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    total: z.number().int().min(0),
    items: z.array(ticketEventRowSchema),
  }),
  z.object({ status: z.literal('ticket_not_found') }),
]);

export const ticketAssignableOperatorsEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(ticketActorRowSchema),
});

export function toTicketActor(row: z.output<typeof ticketActorRowSchema>): OpsTicketActor {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
  };
}

export function toTicketListItem(row: z.output<typeof ticketRowSchema>): OpsTicketListItem {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    subject: row.subject,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    priority: row.priority,
    status: row.status,
    assignee: row.assignee ? toTicketActor(row.assignee) : null,
    updatedAt: row.updated_at,
    dueAt: row.due_at,
    isOverdue: row.is_overdue,
  };
}

export function toTicket(row: z.output<typeof ticketRowSchema>): OpsTicket {
  return {
    ...toTicketListItem(row),
    description: row.description,
    issueType: row.issue_type,
    productId: row.product_id,
    contractId: row.contract_id,
    tenantMappingId: row.tenant_mapping_id,
    deploymentInstanceId: row.deployment_instance_id,
    waitingOn: row.waiting_on,
    resolutionSummary: row.resolution_summary,
    closedAt: row.closed_at,
    reopenCount: row.reopen_count,
    version: row.version,
    createdAt: row.created_at,
  };
}

export function toTicketEvent(row: z.output<typeof ticketEventRowSchema>): OpsTicketEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    fromStatus: row.from_status as OpsTicketEvent['fromStatus'],
    toStatus: row.to_status as OpsTicketEvent['toStatus'],
    actor: row.actor ? toTicketActor(row.actor) : null,
    body: row.body,
    waitingOn: row.waiting_on,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export function toTicketReference(
  row: z.output<typeof ticketReferenceRowSchema>,
): OpsTicketReference {
  return {
    refType: row.ref_type,
    refId: row.ref_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
