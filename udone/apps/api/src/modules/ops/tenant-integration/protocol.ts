import {
  z,
  type OpsTenantCommand,
  type OpsTenantCommandAttempt,
  type OpsTenantMapping,
} from '@erp/contracts';

/**
 * tenant-integration 域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 这一域没有任何值得「统一形状」的复杂结构——映射与命令各出现两三个位置，
 * 转换函数各写一份就够。真正需要注意的是**信封的失败分支特别多**：一条命令
 * 可能因为十一种原因被拒（幂等冲突、版本过期、映射状态不对、变更单没批……），
 * 每种都要在协议层显式列出来。少列一种的表现不是报错，而是那道守卫变成
 * 503 `ops_rpc_shape_invalid`——看起来像数据库坏了，实际是我漏了一个分支。
 *
 * `request_summary` / `response_summary` 一律 `z.unknown()`：远端契约不在本仓库，
 * 给它们定形状等于猜远端的字段名，第一次对接就会 503。
 */

const customerRefRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

const productRefRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
});

export const mappingRowSchema = z.object({
  id: z.string().min(1),
  mapping_no: z.string().min(1),
  customer: customerRefRowSchema,
  product: productRefRowSchema,
  udone_organization_id: z.string().nullable(),
  external_ref: z.string().nullable(),
  mapping_status: z.enum(['pending', 'active', 'suspended', 'terminated']),
  last_known_state: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  sync_version: z.number().int().min(0),
  version: z.number().int().min(0),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const commandRowSchema = z.object({
  id: z.string().min(1),
  command_no: z.string().min(1),
  mapping_id: z.string().nullable(),
  command_type: z.enum([
    'provision',
    'bind',
    'activate',
    'suspend',
    'resume',
    'sync_entitlement',
    'extend',
    'revoke',
  ]),
  customer_id: z.string().nullable(),
  contract_id: z.string().nullable(),
  change_request_id: z.string().nullable(),
  expected_sync_version: z.number().int().min(0).nullable(),
  reason: z.string().min(1),
  status: z.enum(['pending', 'retrying', 'succeeded', 'failed', 'cancelled']),
  attempt_count: z.number().int().min(0),
  last_error_code: z.string().nullable(),
  last_error_category: z.enum(['transient', 'permanent', 'auth', 'conflict', 'unknown']).nullable(),
  request_summary: z.unknown().nullable(),
  response_summary: z.unknown().nullable(),
  request_id: z.string().nullable(),
  next_retry_at: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.string().min(1),
  completed_at: z.string().nullable(),
  version: z.number().int().min(0),
});

export const attemptRowSchema = z.object({
  id: z.string().min(1),
  command_id: z.string().min(1),
  attempt_no: z.number().int().min(1),
  started_at: z.string().min(1),
  finished_at: z.string().nullable(),
  outcome: z.enum(['succeeded', 'failed', 'timeout']),
  http_status: z.number().int().nullable(),
  error_category: z.enum(['transient', 'permanent', 'auth', 'conflict', 'unknown']).nullable(),
  request_id: z.string().nullable(),
  response_summary: z.unknown().nullable(),
  actor_id: z.string().nullable(),
});

/**
 * 失败分支的构造器。
 *
 * `status` 必须是泛型字面量而不是 `string`：写成 `(status: string)` 时
 * `z.literal(status)` 会退化成 `z.literal(string)`，整个联合类型里每个失败
 * 分支都变成 `{ status: string }`，路由层的 `result.allowed_actions` 之类的
 * 取值会全部报「不存在该属性」——错误信息指向路由，根因在这里。
 */
const failure = <S extends string, T extends z.ZodRawShape = Record<never, never>>(
  status: S,
  extra?: T,
) => z.object({ status: z.literal(status), ...(extra ?? ({} as T)) });

export const mappingListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(mappingRowSchema),
  total: z.number().int().min(0),
});

export const mappingCreateEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), mapping: mappingRowSchema }),
  failure('customer_not_found'),
  failure('product_not_found'),
  failure('tenant_mapping_conflict', { existing_mapping_id: z.string() }),
]);

export const mappingDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    mapping: mappingRowSchema,
    commands: z.array(commandRowSchema),
  }),
  failure('mapping_not_found'),
]);

export const mappingUpdateEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), mapping: mappingRowSchema }),
  failure('mapping_not_found'),
  failure('version_mismatch', { current_version: z.number().int() }),
  failure('mapping_not_pending', { mapping_status: z.string() }),
  failure('organization_required'),
  failure('tenant_mapping_conflict', { existing_mapping_id: z.string() }),
]);

export const commandCreateEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    command: commandRowSchema,
    mapping: mappingRowSchema.nullable(),
    replayed: z.boolean(),
  }),
  failure('mapping_not_found'),
  failure('invalid_command_type'),
  failure('idempotency_conflict', { existing_command_id: z.string() }),
  failure('expected_sync_version_required'),
  failure('sync_version_mismatch', { current_sync_version: z.number().int() }),
  failure('change_request_not_found'),
  failure('change_request_not_approved', { change_request_status: z.string() }),
  failure('mapping_already_bound'),
  failure('mapping_not_bound'),
  failure('mapping_not_active', { mapping_status: z.string() }),
  failure('mapping_not_suspended', { mapping_status: z.string() }),
  failure('reason_required'),
]);

export const commandListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(commandRowSchema),
  total: z.number().int().min(0),
});

export const commandDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    command: commandRowSchema,
    attempts: z.array(attemptRowSchema),
    retryable: z.boolean(),
  }),
  failure('command_not_found'),
]);

export const attemptListEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    items: z.array(attemptRowSchema),
    total: z.number().int().min(0),
  }),
  failure('command_not_found'),
]);

export const commandTransitionEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), command: commandRowSchema }),
  failure('command_not_found'),
  failure('invalid_transition', {
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  failure('version_mismatch', { current_version: z.number().int() }),
  failure('permanent_error'),
  failure('command_attempted', { attempt_count: z.number().int() }),
]);

// ── 转换 ─────────────────────────────────────────────────────────────────────

type MappingRow = z.output<typeof mappingRowSchema>;
type CommandRow = z.output<typeof commandRowSchema>;
type AttemptRow = z.output<typeof attemptRowSchema>;

export function toMapping(row: MappingRow): OpsTenantMapping {
  return {
    id: row.id,
    mappingNo: row.mapping_no,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    product: {
      id: row.product.id,
      code: row.product.code,
      name: row.product.name,
    },
    udoneOrganizationId: row.udone_organization_id,
    externalRef: row.external_ref,
    mappingStatus: row.mapping_status,
    lastKnownState: row.last_known_state,
    lastSyncedAt: row.last_synced_at,
    syncVersion: row.sync_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCommand(row: CommandRow): OpsTenantCommand {
  return {
    id: row.id,
    commandNo: row.command_no,
    mappingId: row.mapping_id,
    commandType: row.command_type,
    customerId: row.customer_id,
    contractId: row.contract_id,
    changeRequestId: row.change_request_id,
    expectedSyncVersion: row.expected_sync_version,
    reason: row.reason,
    status: row.status,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    lastErrorCategory: row.last_error_category,
    requestSummary: row.request_summary,
    responseSummary: row.response_summary,
    requestId: row.request_id,
    nextRetryAt: row.next_retry_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    version: row.version,
  };
}

export function toAttempt(row: AttemptRow): OpsTenantCommandAttempt {
  return {
    id: row.id,
    commandId: row.command_id,
    attemptNo: row.attempt_no,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    httpStatus: row.http_status,
    errorCategory: row.error_category,
    requestId: row.request_id,
    responseSummary: row.response_summary,
    actorId: row.actor_id,
  };
}

/** 未使用的导出会触发 lint，这里显式保留类型别名给调用方用。 */
export type TenantMappingRow = MappingRow;
export type TenantCommandRow = CommandRow;
export type TenantAttemptRow = AttemptRow;
