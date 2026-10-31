import {
  OPS_DEPLOYMENT_ACTIONS,
  z,
  type OpsDeploymentInstance,
  type OpsDeploymentLicenseRef,
  type OpsDeploymentTicketRef,
  type OpsDeploymentVersionRecord,
} from '@erp/contracts';

/**
 * deployment 域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 这一域的形状比 tenant-integration 浅——两张表、七种信封。需要注意的只有两处：
 *
 * 1. **`allowed_actions` 在信封上，和 `deployment` 平级。** 它不是实例的属性，
 *    是「此刻能对它做什么」。放进实例对象里会让同一条实例在两份快照里带着不同的
 *    `allowedActions` 而其余字段一模一样——那种差异没人会去看，但前端把它当
 *    实例字段缓存起来之后，按钮就会永远停在第一次读到的状态。
 * 2. **`licenses` 与 `tickets` 是**摘要**，不是完整对象。** 详情页要的是「这台
 *    机器挂着什么」，点进去各有端点。所以这里只校验摘要字段，不用完整 schema——
 *    用完整 schema 会让「工单少了一个可选列」把整个详情变成 503。
 */

const customerRefRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

const ownerRowSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    status: z.string().min(1),
  })
  .nullable();

export const deploymentRowSchema = z.object({
  id: z.string().min(1),
  instance_no: z.string().min(1),
  customer: customerRefRowSchema,
  name: z.string().min(1),
  deployment_type: z.enum(['private', 'dedicated']),
  environment_ref: z.string().nullable(),
  current_version: z.string().nullable(),
  status: z.enum(['planned', 'active', 'maintenance', 'retired']),
  go_live_on: z.string().nullable(),
  maintenance_until: z.string().nullable(),
  owner: ownerRowSchema,
  contract_id: z.string().nullable(),
  license_id: z.string().nullable(),
  last_reported_at: z.string().nullable(),
  version: z.number().int().min(0),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const versionRecordRowSchema = z.object({
  id: z.string().min(1),
  instance_id: z.string().min(1),
  from_version: z.string().min(1),
  to_version: z.string().min(1),
  executed_on: z.string().min(1),
  executed_by: z.object({
    id: z.string().min(1),
    display_name: z.string().min(1),
  }),
  result: z.enum(['succeeded', 'failed', 'rolled_back']),
  impact_note: z.string().nullable(),
  rollback_note: z.string().nullable(),
  created_at: z.string().min(1),
});

const licenseRefRowSchema = z.object({
  id: z.string().min(1),
  license_no: z.string().min(1),
  license_mode: z.string().min(1),
  status: z.string().min(1),
  valid_from: z.string().min(1),
  valid_to: z.string().nullable(),
  maintenance_until: z.string().nullable(),
});

const ticketRefRowSchema = z.object({
  id: z.string().min(1),
  ticket_no: z.string().min(1),
  subject: z.string().min(1),
  priority: z.string().min(1),
  status: z.string().min(1),
});

/**
 * 失败分支的构造器。
 *
 * `status` 必须是泛型字面量：写成 `(status: string)` 时 `z.literal(status)` 会
 * 退化成 `z.literal(string)`，整个联合类型里每个分支都变成 `{ status: string }`，
 * 路由层取 `result.allowed_actions` 会全部报「不存在该属性」——报错指向路由，
 * 根因在这一行。
 */
const failure = <S extends string, T extends z.ZodRawShape = Record<never, never>>(
  status: S,
  extra?: T,
) => z.object({ status: z.literal(status), ...(extra ?? ({} as T)) });

export const deploymentListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(deploymentRowSchema),
  total: z.number().int().min(0),
});

export const deploymentCreateEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), deployment: deploymentRowSchema }),
  failure('invalid_deployment_type'),
  failure('name_required'),
  failure('customer_not_found'),
  failure('owner_not_found'),
  failure('license_not_found'),
  failure('license_customer_mismatch'),
  failure('contract_not_found'),
  failure('contract_customer_mismatch'),
  failure('name_taken', { name: z.string() }),
]);

export const deploymentDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    deployment: deploymentRowSchema,
    allowed_actions: z.array(z.enum(OPS_DEPLOYMENT_ACTIONS)),
    versionRecords: z.array(versionRecordRowSchema),
    licenses: z.array(licenseRefRowSchema),
    tickets: z.array(ticketRefRowSchema),
  }),
  failure('not_found'),
]);

export const deploymentUpdateEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), deployment: deploymentRowSchema }),
  failure('not_found'),
  failure('version_mismatch', { current_version: z.number().int() }),
  failure('instance_retired'),
  failure('name_required'),
  failure('invalid_deployment_type'),
  failure('owner_not_found'),
  failure('license_not_found'),
  failure('license_customer_mismatch'),
  failure('contract_not_found'),
  failure('contract_customer_mismatch'),
  failure('go_live_on_required'),
  failure('name_taken', { name: z.string() }),
]);

export const deploymentTransitionEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    deployment: deploymentRowSchema,
    allowed_actions: z.array(z.enum(OPS_DEPLOYMENT_ACTIONS)),
  }),
  failure('not_found'),
  failure('version_mismatch', { current_version: z.number().int() }),
  failure('invalid_transition', {
    current_status: z.string(),
    allowed_actions: z.array(z.enum(OPS_DEPLOYMENT_ACTIONS)),
  }),
  failure('go_live_on_required'),
  failure('reason_required'),
]);

export const versionRecordCreateEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    version_record: versionRecordRowSchema,
    deployment: deploymentRowSchema,
  }),
  failure('not_found'),
  failure('invalid_result'),
  failure('from_version_required'),
  failure('to_version_required'),
  failure('executed_on_required'),
  failure('version_mismatch', {
    current_version: z.string(),
    from_version: z.string(),
  }),
]);

export const versionRecordListEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    items: z.array(versionRecordRowSchema),
    total: z.number().int().min(0),
  }),
  failure('not_found'),
]);

// ── 转换 ─────────────────────────────────────────────────────────────────────

type DeploymentRow = z.output<typeof deploymentRowSchema>;
type VersionRecordRow = z.output<typeof versionRecordRowSchema>;

export function toDeployment(row: DeploymentRow): OpsDeploymentInstance {
  return {
    id: row.id,
    instanceNo: row.instance_no,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    name: row.name,
    deploymentType: row.deployment_type,
    environmentRef: row.environment_ref,
    currentVersion: row.current_version,
    status: row.status,
    goLiveOn: row.go_live_on,
    maintenanceUntil: row.maintenance_until,
    owner: row.owner
      ? { id: row.owner.id, displayName: row.owner.display_name, status: row.owner.status }
      : null,
    contractId: row.contract_id,
    licenseId: row.license_id,
    lastReportedAt: row.last_reported_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toVersionRecord(row: VersionRecordRow): OpsDeploymentVersionRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    executedOn: row.executed_on,
    executedBy: { id: row.executed_by.id, displayName: row.executed_by.display_name },
    result: row.result,
    impactNote: row.impact_note,
    rollbackNote: row.rollback_note,
    createdAt: row.created_at,
  };
}

export function toLicenseRef(row: z.output<typeof licenseRefRowSchema>): OpsDeploymentLicenseRef {
  return {
    id: row.id,
    licenseNo: row.license_no,
    licenseMode: row.license_mode,
    status: row.status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    maintenanceUntil: row.maintenance_until,
  };
}

export function toTicketRef(row: z.output<typeof ticketRefRowSchema>): OpsDeploymentTicketRef {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    subject: row.subject,
    priority: row.priority,
    status: row.status,
  };
}
