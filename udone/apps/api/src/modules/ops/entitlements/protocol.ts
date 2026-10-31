import {
  z,
  type OpsEntitlementChangeRequest,
  type OpsEntitlementDiff,
  type OpsEntitlementSnapshot,
  type OpsEntitlementSnapshotDetail,
  type OpsEntitlementSnapshotLine,
  type OpsLicense,
  type OpsSubscription,
} from '@erp/contracts';

/**
 * entitlement 域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 与其它域同构，但这一域有一处特别：**快照会出现在四个位置**（订阅详情的
 * `snapshot`、授权的 `snapshot`、变更单的 `proposedSnapshot`、快照列表的
 * `items`），而四个位置在库里是同一个 `ops.snapshot_summary_json`。所以这里
 * 也只写一份 `toSnapshot`——四处各自解析一次的话，「快照列表多了一个字段、
 * 详情没有」这种漂移会只有一处报 503，另外三处静默少字段。
 *
 * 另一个坑是**变更单的 before/after 是**库里存的 jsonb，键名跟快照明细一样是
 * snake_case，但它们不是经 `snapshot_lines_json` 出来的（那是发放那一刻的），
 * 而是当事快照的副本。两者形状相同、来源不同，所以共用 `snapshotLineRowSchema`。
 */
export const entitlementOperatorRefRowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
});

export const entitlementCustomerRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

export const entitlementProductRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
});

export const entitlementPackageRowSchema = z.object({
  id: z.string().min(1),
  internal_name: z.string().nullable(),
  customer_name: z.string().nullable(),
});

export const snapshotLineRowSchema = z.object({
  feature_key: z.string().min(1),
  enabled: z.boolean(),
  quota_value: z.number().nullable(),
  term_months: z.number().int().nullable(),
  display_name_snapshot: z.string().min(1),
});

export const snapshotRowSchema = z.object({
  id: z.string().min(1),
  customer_id: z.string().min(1),
  source_type: z.enum(['contract_item', 'change_request']),
  source_id: z.string().min(1),
  target_scope: z.enum(['saas_tenant', 'private_instance']),
  target_ref: z.string().nullable(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  content_hash: z.string().length(64),
  line_count: z.number().int().min(0),
  created_at: z.string().min(1),
});

export const snapshotDetailRowSchema = snapshotRowSchema.extend({
  lines: z.array(snapshotLineRowSchema),
});

export const subscriptionRowSchema = z.object({
  id: z.string().min(1),
  subscription_no: z.string().min(1),
  customer: entitlementCustomerRowSchema,
  contract_id: z.string().min(1),
  contract_no: z.string().min(1),
  contract_item_id: z.string().min(1),
  product: entitlementProductRowSchema.nullable(),
  package: entitlementPackageRowSchema.nullable(),
  billing_cycle: z.enum(['monthly', 'quarterly', 'yearly', 'multi_year']),
  starts_on: z.string().min(1),
  ends_on: z.string().nullable(),
  auto_renew_intent: z.boolean(),
  status: z.enum(['draft', 'pending_approval', 'active', 'suspended', 'revoked', 'expired']),
  current_snapshot_id: z.string().nullable(),
  snapshot: snapshotRowSchema.nullable(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const licenseRowSchema = z.object({
  id: z.string().min(1),
  license_no: z.string().min(1),
  customer: entitlementCustomerRowSchema,
  contract_id: z.string().min(1),
  contract_no: z.string().min(1),
  contract_item_id: z.string().min(1),
  deployment_instance_id: z.string().nullable(),
  license_mode: z.enum(['term', 'perpetual']),
  valid_from: z.string().min(1),
  valid_to: z.string().nullable(),
  maintenance_until: z.string().nullable(),
  status: z.enum(['draft', 'pending_approval', 'active', 'suspended', 'revoked', 'expired']),
  current_snapshot_id: z.string().nullable(),
  snapshot: snapshotRowSchema.nullable(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

/** 库里 `before_summary` / `after_summary` 的形状：`{lines: [...]}`。 */
export const lineSetRowSchema = z.object({
  lines: z.array(snapshotLineRowSchema),
});

export const changeRequestRowSchema = z.object({
  id: z.string().min(1),
  subject_type: z.enum(['subscription', 'license']),
  subject_id: z.string().min(1),
  subject_no: z.string().nullable(),
  change_type: z.enum([
    'issue',
    'extend',
    'upgrade',
    'downgrade',
    'quota_change',
    'suspend',
    'resume',
    'expire',
    'revoke',
  ]),
  status: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'executing',
    'executed',
    'failed',
    'rejected',
    'cancelled',
  ]),
  source_contract_id: z.string().nullable(),
  proposed_snapshot_id: z.string().nullable(),
  proposed_snapshot: snapshotRowSchema.nullable(),
  reason: z.string().min(1),
  before_summary: lineSetRowSchema,
  after_summary: lineSetRowSchema,
  requested_by: entitlementOperatorRefRowSchema.nullable(),
  approved_by: entitlementOperatorRefRowSchema.nullable(),
  approved_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  command_id: z.string().nullable(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const diffRowSchema = z.object({
  before: lineSetRowSchema,
  after: lineSetRowSchema,
  added: z.array(snapshotLineRowSchema),
  removed: z.array(snapshotLineRowSchema),
  changed: z.array(
    z.object({
      feature_key: z.string().min(1),
      before: snapshotLineRowSchema,
      after: snapshotLineRowSchema,
    }),
  ),
});

export const entitlementCommandRowSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
});

// ── 信封 ─────────────────────────────────────────────────────────────────────

export const subscriptionListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(subscriptionRowSchema),
  total: z.number().int().min(0),
});

/**
 * 建订阅 / 建授权 / 改权益的失败分支合成一个联合。
 *
 * 三个写入口共用同一套「权益行」校验（`feature_lines_apply`），所以它们的
 * 失败原因也是同一批：`feature_unknown` / `feature_duplicate` /
 * `feature_key_required` / `feature_invalid`。每个都带 `feature_key`——表单
 * 要把输入框标红，只给一句 message 是定位不到哪一行的。
 */
const featureLineFailureSchema = z.union([
  z.object({ status: z.literal('feature_unknown'), feature_key: z.string() }),
  z.object({ status: z.literal('feature_duplicate') }),
  z.object({ status: z.literal('feature_key_required') }),
  z.object({ status: z.literal('feature_invalid'), feature_key: z.string() }),
]);

export const subscriptionCreateEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    subscription: subscriptionRowSchema,
    snapshot: snapshotRowSchema.nullable(),
  }),
  z.object({ status: z.literal('contract_item_not_found') }),
  z.object({ status: z.literal('customer_mismatch'), contract_customer_id: z.string() }),
  z.object({ status: z.literal('contract_not_active'), contract_status: z.string() }),
  z.object({ status: z.literal('sales_mode_mismatch'), sales_mode: z.string() }),
  z.object({ status: z.literal('invalid_billing_cycle') }),
  z.object({ status: z.literal('start_date_required') }),
  z.object({ status: z.literal('invalid_period') }),
  z.object({ status: z.literal('duplicate_subscription') }),
  featureLineFailureSchema,
]);

export const licenseCreateEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    license: licenseRowSchema,
    snapshot: snapshotRowSchema.nullable(),
  }),
  z.object({ status: z.literal('contract_item_not_found') }),
  z.object({ status: z.literal('customer_mismatch'), contract_customer_id: z.string() }),
  z.object({ status: z.literal('contract_not_active'), contract_status: z.string() }),
  z.object({ status: z.literal('sales_mode_mismatch'), sales_mode: z.string() }),
  z.object({ status: z.literal('invalid_license_mode') }),
  z.object({ status: z.literal('perpetual_with_valid_to') }),
  z.object({ status: z.literal('term_requires_valid_to') }),
  z.object({ status: z.literal('valid_from_required') }),
  z.object({ status: z.literal('invalid_period') }),
  z.object({ status: z.literal('invalid_maintenance_period') }),
  z.object({ status: z.literal('duplicate_license') }),
  featureLineFailureSchema,
]);

/**
 * 迁移的信封。
 *
 * 订阅与授权共用同一个函数，返回值只差键名（`subscription` / `license`）。
 * 所以这里是两个 union 而不是一个带 `subject` 的联合——出口形状必须是确定的
 * 类型，让前端拿 `res.subscription` 时不必先判 `subjectType`。
 */
const subjectTransitionFailureSchema = z.union([
  z.object({ status: z.literal('subscription_not_found') }),
  z.object({ status: z.literal('license_not_found') }),
  z.object({ status: z.literal('invalid_subject_type') }),
  z.object({ status: z.literal('invalid_action') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('approval_required'), current_status: z.string() }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('snapshot_required') }),
  z.object({ status: z.literal('not_expired'), expiry_date: z.string().nullable() }),
]);

export const subscriptionTransitionEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), subscription: subscriptionRowSchema }),
  subjectTransitionFailureSchema,
]);

export const licenseTransitionEnvelopeSchema = z.union([
  z.object({ status: z.literal('ok'), license: licenseRowSchema }),
  subjectTransitionFailureSchema,
]);

export const subscriptionDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    subscription: subscriptionRowSchema,
    snapshot: snapshotDetailRowSchema.nullable(),
    change_requests: z.array(changeRequestRowSchema),
    tenant_mapping: z.null(),
  }),
  z.object({ status: z.literal('subscription_not_found') }),
]);

export const licenseDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    license: licenseRowSchema,
    snapshot: snapshotDetailRowSchema.nullable(),
    change_requests: z.array(changeRequestRowSchema),
    deployment: z.null(),
  }),
  z.object({ status: z.literal('license_not_found') }),
]);

export const licenseListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(licenseRowSchema),
  total: z.number().int().min(0),
});

const changeRequestFailureSchema = z.union([
  z.object({ status: z.literal('subscription_not_found') }),
  z.object({ status: z.literal('license_not_found') }),
  z.object({ status: z.literal('invalid_subject_type') }),
  z.object({ status: z.literal('invalid_change_type') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('subject_not_active'), current_status: z.string() }),
  featureLineFailureSchema,
]);

export const changeRequestCreateEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    change_request: changeRequestRowSchema,
    diff: diffRowSchema,
  }),
  changeRequestFailureSchema,
]);

export const changeRequestTransitionEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    change_request: changeRequestRowSchema,
    diff: diffRowSchema,
  }),
  z.object({ status: z.literal('change_request_not_found') }),
  z.object({ status: z.literal('invalid_action') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('approval_required'), current_status: z.string() }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('segregation_of_duty') }),
]);

export const changeRequestListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(changeRequestRowSchema),
  total: z.number().int().min(0),
});

export const changeRequestDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    change_request: changeRequestRowSchema,
    diff: diffRowSchema,
    command: entitlementCommandRowSchema.nullable(),
  }),
  z.object({ status: z.literal('change_request_not_found') }),
]);

export const snapshotListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(snapshotRowSchema),
  total: z.number().int().min(0),
});

export const snapshotDetailEnvelopeSchema = z.union([
  z.object({
    status: z.literal('ok'),
    snapshot: snapshotRowSchema,
    lines: z.array(snapshotLineRowSchema),
  }),
  z.object({ status: z.literal('snapshot_not_found') }),
]);

// ── 转换 ─────────────────────────────────────────────────────────────────────

type SnapshotLineRow = z.output<typeof snapshotLineRowSchema>;
type SnapshotRow = z.output<typeof snapshotRowSchema>;
type SubscriptionRow = z.output<typeof subscriptionRowSchema>;
type LicenseRow = z.output<typeof licenseRowSchema>;
type ChangeRequestRow = z.output<typeof changeRequestRowSchema>;
type DiffRow = z.output<typeof diffRowSchema>;

export function toSnapshotLine(row: SnapshotLineRow): OpsEntitlementSnapshotLine {
  return {
    featureKey: row.feature_key,
    enabled: row.enabled,
    quotaValue: row.quota_value,
    termMonths: row.term_months,
    displayNameSnapshot: row.display_name_snapshot,
  };
}

export function toSnapshot(row: SnapshotRow): OpsEntitlementSnapshot {
  return {
    id: row.id,
    customerId: row.customer_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    targetScope: row.target_scope,
    targetRef: row.target_ref,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    contentHash: row.content_hash,
    lineCount: row.line_count,
    createdAt: row.created_at,
  };
}

export function toSnapshotDetail(
  row: z.output<typeof snapshotDetailRowSchema>,
): OpsEntitlementSnapshotDetail {
  return { ...toSnapshot(row), lines: row.lines.map(toSnapshotLine) };
}

export function toSubscription(row: SubscriptionRow): OpsSubscription {
  return {
    id: row.id,
    subscriptionNo: row.subscription_no,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    contractId: row.contract_id,
    contractNo: row.contract_no,
    contractItemId: row.contract_item_id,
    product: row.product
      ? { id: row.product.id, code: row.product.code, name: row.product.name }
      : null,
    package: row.package
      ? {
          id: row.package.id,
          internalName: row.package.internal_name,
          customerName: row.package.customer_name,
        }
      : null,
    billingCycle: row.billing_cycle,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    autoRenewIntent: row.auto_renew_intent,
    status: row.status,
    currentSnapshotId: row.current_snapshot_id,
    snapshot: row.snapshot ? toSnapshot(row.snapshot) : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toLicense(row: LicenseRow): OpsLicense {
  return {
    id: row.id,
    licenseNo: row.license_no,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    contractId: row.contract_id,
    contractNo: row.contract_no,
    contractItemId: row.contract_item_id,
    deploymentInstanceId: row.deployment_instance_id,
    licenseMode: row.license_mode,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    maintenanceUntil: row.maintenance_until,
    status: row.status,
    currentSnapshotId: row.current_snapshot_id,
    snapshot: row.snapshot ? toSnapshot(row.snapshot) : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toChangeRequest(row: ChangeRequestRow): OpsEntitlementChangeRequest {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectNo: row.subject_no,
    changeType: row.change_type,
    status: row.status,
    sourceContractId: row.source_contract_id,
    proposedSnapshotId: row.proposed_snapshot_id,
    proposedSnapshot: row.proposed_snapshot ? toSnapshot(row.proposed_snapshot) : null,
    reason: row.reason,
    beforeSummary: { lines: row.before_summary.lines.map(toSnapshotLine) },
    afterSummary: { lines: row.after_summary.lines.map(toSnapshotLine) },
    requestedBy: row.requested_by
      ? { id: row.requested_by.id, displayName: row.requested_by.display_name }
      : null,
    approvedBy: row.approved_by
      ? { id: row.approved_by.id, displayName: row.approved_by.display_name }
      : null,
    approvedAt: row.approved_at,
    executedAt: row.executed_at,
    commandId: row.command_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toDiff(row: DiffRow): OpsEntitlementDiff {
  return {
    before: { lines: row.before.lines.map(toSnapshotLine) },
    after: { lines: row.after.lines.map(toSnapshotLine) },
    added: row.added.map(toSnapshotLine),
    removed: row.removed.map(toSnapshotLine),
    changed: row.changed.map((entry) => ({
      featureKey: entry.feature_key,
      before: toSnapshotLine(entry.before),
      after: toSnapshotLine(entry.after),
    })),
  };
}
