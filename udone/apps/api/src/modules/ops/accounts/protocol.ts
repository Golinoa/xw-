import {
  z,
  type OpsAuditEvent,
  type OpsOperator,
  type OpsOperatorStatus,
  type OpsRole,
  type OpsRoleStatus,
} from '@erp/contracts';

/**
 * RPC 返回值的形状（数据库列名）与出口形状（契约字段名）之间的那一层。
 *
 * 中间这一层的作用不是「转换一下」，而是**让列改名变成一次失败**：
 * 直接 `as OpsOperator` 断言的话，`display_name` 改成 `displayName` 之后
 * 前端拿到的是 `undefined`，而 `undefined` 在渲染层等于空字符串——看起来像
 * 「这个人没填名字」。有了这里的 zod 校验，同样的迁移会让 `rpc_shape_invalid`
 * 出现在日志里，请求 503。
 *
 * 另外这一层还兜住一件事：`jsonb` 的键是 SQL 里手写的字符串。函数签名变了、
 * RPC 调错了名字、上游返回了错误对象，都表现为「形状不对」，而不是静默的 undefined。
 */
export const operatorRowSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  display_name: z.string().nullable(),
  status: z.enum(['invited', 'active', 'disabled']),
  mfa_required: z.boolean(),
  version: z.number().int(),
  last_login_at: z.string().nullable(),
  roles: z.array(z.object({ code: z.string().min(1), name: z.string().min(1) })),
});

export type OperatorRow = z.infer<typeof operatorRowSchema>;

export function toOperator(row: OperatorRow): OpsOperator {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status as OpsOperatorStatus,
    mfaRequired: row.mfa_required,
    version: row.version,
    roles: row.roles.map((role) => ({ code: role.code, name: role.name })),
    lastLoginAt: row.last_login_at,
  };
}

export const roleRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  is_system: z.boolean(),
  status: z.enum(['active', 'disabled']),
  permissions: z.array(z.string()),
});

export type RoleRow = z.infer<typeof roleRowSchema>;

export function toRole(row: RoleRow): OpsRole {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    status: row.status as OpsRoleStatus,
    permissions: row.permissions,
  };
}

export const auditEventRowSchema = z.object({
  id: z.string().min(1),
  actor: z
    .object({
      id: z.string().min(1),
      display_name: z.string().nullable(),
    })
    .nullable(),
  action: z.string().min(1),
  entity_type: z.string().min(1),
  entity_id: z.string().nullable(),
  reason: z.string().nullable(),
  before_summary: z.unknown(),
  after_summary: z.unknown(),
  request_id: z.string().nullable(),
  created_at: z.string().min(1),
});

export type AuditEventRow = z.infer<typeof auditEventRowSchema>;

export function toAuditEvent(row: AuditEventRow): OpsAuditEvent {
  return {
    id: row.id,
    actor: row.actor === null ? null : { id: row.actor.id, displayName: row.actor.display_name },
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    beforeSummary: row.before_summary,
    afterSummary: row.after_summary,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** `{items,total}` 的两个读端点共用这个外壳。 */
export function pagedEnvelope<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
  });
}

export const operatorListEnvelopeSchema = pagedEnvelope(operatorRowSchema);
export type OperatorListEnvelope = z.infer<typeof operatorListEnvelopeSchema>;

export const roleListEnvelopeSchema = z.object({
  items: z.array(roleRowSchema),
});
export type RoleListEnvelope = z.infer<typeof roleListEnvelopeSchema>;

export const auditEventListEnvelopeSchema = pagedEnvelope(auditEventRowSchema);
export type AuditEventListEnvelope = z.infer<typeof auditEventListEnvelopeSchema>;

/**
 * 邀请的信封。
 *
 * `invitation_expires_at` 是 `timestamptz` 经 `jsonb_build_object` 序列化后的字符串；
 * 这里只校验它是非空字符串，不校验格式——格式由 Postgres 决定，钉死一套格式等于
 * 把「Postgres 版本升级」变成一次接口破坏。
 */
export const inviteEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    operator: operatorRowSchema,
    invitation_expires_at: z.string().min(1),
  }),
  z.object({ status: z.literal('email_exists') }),
  z.object({ status: z.literal('roles_required') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('unknown_role'), codes: z.array(z.string()) }),
]);

export type InviteEnvelope = z.infer<typeof inviteEnvelopeSchema>;

export const operatorUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    operator: operatorRowSchema,
    permissions_changed: z.object({
      added: z.array(z.string()),
      removed: z.array(z.string()),
    }),
  }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('last_role') }),
  z.object({ status: z.literal('last_admin') }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('unknown_role'), codes: z.array(z.string()) }),
]);

export type OperatorUpdateEnvelope = z.infer<typeof operatorUpdateEnvelopeSchema>;

export const roleCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), role: roleRowSchema }),
  z.object({ status: z.literal('role_code_exists') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('unknown_permission'), codes: z.array(z.string()) }),
]);

export type RoleCreateEnvelope = z.infer<typeof roleCreateEnvelopeSchema>;

export const roleUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    role: roleRowSchema,
    before_permissions: z.array(z.string()),
    after_permissions: z.array(z.string()),
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('last_admin') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('unknown_permission'), codes: z.array(z.string()) }),
]);

export type RoleUpdateEnvelope = z.infer<typeof roleUpdateEnvelopeSchema>;
