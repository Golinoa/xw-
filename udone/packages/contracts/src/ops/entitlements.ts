import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';

/**
 * entitlement 域（契约 §3.5 / §5.6，十五条端点：订阅、授权、变更申请、快照）。
 *
 * 这一域的出口形状有一个别处没有的特点：**同一张快照会在三个位置出现**——
 * 订阅详情的 `snapshot`、变更申请的 `proposedSnapshot`、快照列表的 `items`。
 * 三处的字段必须是同一套，否则前端要为「同一个权益」写三种渲染。所以快照的
 * 形状在这里只有一份（`opsEntitlementSnapshotSchema`），列表项就是它，
 * 详情再加 `lines`。
 *
 * 三处口径写在这里，不散到路由：
 *
 * 1. **快照不可变，所以没有任何 `PATCH`/`DELETE`。** 契约 §5.6 的脚注原话是
 *    「一旦写出即不可变」；改权益只能提变更申请、发新快照。类型层面也不给
 *    修改入口，免得有人按 REST 习惯补一个。
 * 2. **`valid_*` 与 `ends_on` 可空。** 永久授权没有 `validTo`、「不定期订阅」
 *    没有 `endsOn`。空值不是缺失，是「无期限」这个业务事实。
 * 3. **`command` 一律可为 null。** 下发命令属 o-t10（`tenant_commands`），
 *    本轮不存在。`suspend`/`resume`/`revoke` 仍返回 202，但 `command` 是
 *    null——状态确实变了、租户侧还没同步，这个「半完成」正是 202 的含义。
 */

/** 订阅与授权共用一套状态（契约 §3.5 就是一张表管两边）。 */
export const OPS_SUBJECT_STATUSES = [
  'draft',
  'pending_approval',
  'active',
  'suspended',
  'revoked',
  'expired',
] as const;
export const opsSubjectStatusSchema = z.enum(OPS_SUBJECT_STATUSES);
export type OpsSubjectStatus = z.infer<typeof opsSubjectStatusSchema>;

export const OPS_ENTITLEMENT_SUBJECT_TYPES = ['subscription', 'license'] as const;
export const opsEntitlementSubjectTypeSchema = z.enum(OPS_ENTITLEMENT_SUBJECT_TYPES);
export type OpsEntitlementSubjectType = z.infer<typeof opsEntitlementSubjectTypeSchema>;

/**
 * 订阅/授权的状态迁移动作（契约 §3.5 的「动作」列，七条边）。
 *
 * `create_draft` 不在里面：它就是 `POST /subscriptions` 本身，没有「在已有
 * 订阅上再建一次草案」这种动作。
 */
export const OPS_SUBJECT_TRANSITION_ACTIONS = [
  'submit',
  'approve',
  'reject',
  'suspend',
  'resume',
  'revoke',
  'mark_expired',
] as const;
export const opsSubjectTransitionActionSchema = z.enum(OPS_SUBJECT_TRANSITION_ACTIONS);
export type OpsSubjectTransitionAction = z.infer<typeof opsSubjectTransitionActionSchema>;

export const OPS_BILLING_CYCLES = ['monthly', 'quarterly', 'yearly', 'multi_year'] as const;
export const opsBillingCycleSchema = z.enum(OPS_BILLING_CYCLES);
export type OpsBillingCycle = z.infer<typeof opsBillingCycleSchema>;

/**
 * 授权方式。
 *
 * `perpetual` 与 `validTo` 是互斥且互补的：永久授权**不允许**有 `validTo`，
 * 期限授权**必须**有。两条都写在表约束里（`CHECK((license_mode='perpetual')
 * = (valid_to IS NULL))`），所以这里的类型不能把 `validTo` 收成必填。
 */
export const OPS_LICENSE_MODES = ['term', 'perpetual'] as const;
export const opsLicenseModeSchema = z.enum(OPS_LICENSE_MODES);
export type OpsLicenseMode = z.infer<typeof opsLicenseModeSchema>;

/** 变更类型（契约 §3.5，九种）。 */
export const OPS_ENTITLEMENT_CHANGE_TYPES = [
  'issue',
  'extend',
  'upgrade',
  'downgrade',
  'quota_change',
  'suspend',
  'resume',
  'expire',
  'revoke',
] as const;
export const opsEntitlementChangeTypeSchema = z.enum(OPS_ENTITLEMENT_CHANGE_TYPES);
export type OpsEntitlementChangeType = z.infer<typeof opsEntitlementChangeTypeSchema>;

/**
 * 变更申请状态（八态）。
 *
 * 契约 §3.5 明写这套状态「PRD 未枚举，属实现必需」，登记为 U-04。
 * `executing` 是给「等租户命令回执」用的中间态——本轮没有命令表，实现直接从
 * `approved` 落到 `executed`，所以 `executing` 在库里查不到，但枚举里必须留着：
 * o-t10 落地后它会重新可达，届时不需要改前端。
 */
export const OPS_CHANGE_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'executing',
  'executed',
  'failed',
  'rejected',
  'cancelled',
] as const;
export const opsChangeRequestStatusSchema = z.enum(OPS_CHANGE_REQUEST_STATUSES);
export type OpsChangeRequestStatus = z.infer<typeof opsChangeRequestStatusSchema>;

export const OPS_CHANGE_REQUEST_ACTIONS = [
  'submit',
  'approve',
  'reject',
  'execute',
  'retry',
  'cancel',
] as const;
export const opsChangeRequestActionSchema = z.enum(OPS_CHANGE_REQUEST_ACTIONS);
export type OpsChangeRequestAction = z.infer<typeof opsChangeRequestActionSchema>;

/** 快照的来源类型（契约 §3.5）。 */
export const OPS_SNAPSHOT_SOURCE_TYPES = ['contract_item', 'change_request'] as const;
export const opsSnapshotSourceTypeSchema = z.enum(OPS_SNAPSHOT_SOURCE_TYPES);
export type OpsSnapshotSourceType = z.infer<typeof opsSnapshotSourceTypeSchema>;

export const OPS_SNAPSHOT_TARGET_SCOPES = ['saas_tenant', 'private_instance'] as const;
export const opsSnapshotTargetScopeSchema = z.enum(OPS_SNAPSHOT_TARGET_SCOPES);
export type OpsSnapshotTargetScope = z.infer<typeof opsSnapshotTargetScopeSchema>;

export const opsEntitlementCustomerSchema = z.object({
  id: z.uuid(),
  customerNo: z.string().min(1),
  name: z.string().min(1),
});
export type OpsEntitlementCustomer = z.infer<typeof opsEntitlementCustomerSchema>;

export const opsEntitlementProductSchema = z.object({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});
export type OpsEntitlementProduct = z.infer<typeof opsEntitlementProductSchema>;

export const opsEntitlementPackageSchema = z.object({
  id: z.uuid(),
  internalName: z.string().nullable(),
  customerName: z.string().nullable(),
});
export type OpsEntitlementPackage = z.infer<typeof opsEntitlementPackageSchema>;

/**
 * 快照里的一行权益。
 *
 * `displayNameSnapshot` 是**发放当时**的字典名称，不是当前字典的名称——这条
 * 是快照存在的理由：三个月后功能改了名，这里仍然显示当初写进授权凭证的那个
 * 名字。前端不要拿它去和字典比对。
 */
export const opsEntitlementSnapshotLineSchema = z.object({
  featureKey: z.string().min(1),
  enabled: z.boolean(),
  quota: z.number().nullable(),
  termMonths: z.number().int().nullable(),
  displayNameSnapshot: z.string().min(1),
});
export type OpsEntitlementSnapshotLine = z.infer<typeof opsEntitlementSnapshotLineSchema>;

/**
 * 快照。`contentHash` 只覆盖 `featureKey` / `enabled` / `quota` /
 * `termMonths` 四个字段，**不含** `displayNameSnapshot`：改名不等于改授权，
 * 否则「同一个套餐改了文案」会变成一次重新发放。
 */
export const opsEntitlementSnapshotSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  sourceType: opsSnapshotSourceTypeSchema,
  sourceId: z.uuid(),
  targetScope: opsSnapshotTargetScopeSchema,
  targetRef: z.uuid().nullable(),
  validFrom: z.iso.date().nullable(),
  validTo: z.iso.date().nullable(),
  contentHash: z.string().length(64),
  lineCount: z.number().int().min(0),
  createdAt: z.string().min(1),
});
export type OpsEntitlementSnapshot = z.infer<typeof opsEntitlementSnapshotSchema>;

/** 详情：列表项 + 明细行。契约 §5.6 的「列表项 = 详情去掉 lines + lineCount」。 */
export const opsEntitlementSnapshotDetailSchema = opsEntitlementSnapshotSchema.extend({
  lines: z.array(opsEntitlementSnapshotLineSchema),
});
export type OpsEntitlementSnapshotDetail = z.infer<typeof opsEntitlementSnapshotDetailSchema>;

export const opsSubscriptionSchema = z.object({
  id: z.uuid(),
  subscriptionNo: z.string().min(1),
  customer: opsEntitlementCustomerSchema,
  contractId: z.uuid(),
  contractNo: z.string().min(1),
  contractItemId: z.uuid(),
  product: opsEntitlementProductSchema.nullable(),
  package: opsEntitlementPackageSchema.nullable(),
  billingCycle: opsBillingCycleSchema,
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable(),
  autoRenewIntent: z.boolean(),
  status: opsSubjectStatusSchema,
  currentSnapshotId: z.uuid().nullable(),
  snapshot: opsEntitlementSnapshotSchema.nullable(),
  version: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsSubscription = z.infer<typeof opsSubscriptionSchema>;

export const opsLicenseSchema = z.object({
  id: z.uuid(),
  licenseNo: z.string().min(1),
  customer: opsEntitlementCustomerSchema,
  contractId: z.uuid(),
  contractNo: z.string().min(1),
  contractItemId: z.uuid(),
  /**
   * 部署实例属 o-t11（`deployment_instances`），本轮是软引用：可以填、可以空，
   * 但不能保证它指向一条真实存在的实例记录。
   */
  deploymentInstanceId: z.uuid().nullable(),
  licenseMode: opsLicenseModeSchema,
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable(),
  /**
   * 维护到期日。与 `validTo` **独立**：契约 §3.5 的「永久授权不得推导为永久
   * 更新」就是这个意思——永久授权 + 一年维护是正常组合。
   */
  maintenanceUntil: z.iso.date().nullable(),
  status: opsSubjectStatusSchema,
  currentSnapshotId: z.uuid().nullable(),
  snapshot: opsEntitlementSnapshotSchema.nullable(),
  version: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsLicense = z.infer<typeof opsLicenseSchema>;

const opsOperatorRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
});
export type OpsEntitlementOperatorRef = z.infer<typeof opsOperatorRefSchema>;

/** 变更单里的「前后值摘要」：一组权益行。形状与快照明细一致。 */
export const opsEntitlementLineSetSchema = z.object({
  lines: z.array(opsEntitlementSnapshotLineSchema),
});
export type OpsEntitlementLineSet = z.infer<typeof opsEntitlementLineSetSchema>;

/**
 * 前后差异。
 *
 * `added` / `removed` 给整行而不是只给 key：界面要显示「新增了一个 5GB 的存储
 * 额度」，只给 key 前端还得再查一次字典。`changed` 只比三个语义字段，不比
 * `displayNameSnapshot`——与 `contentHash` 的口径一致，否则会出现「diff 说有
 * 变化、但哈希没变」的自相矛盾。
 */
export const opsEntitlementDiffSchema = z.object({
  before: opsEntitlementLineSetSchema,
  after: opsEntitlementLineSetSchema,
  added: z.array(opsEntitlementSnapshotLineSchema),
  removed: z.array(opsEntitlementSnapshotLineSchema),
  changed: z.array(
    z.object({
      featureKey: z.string().min(1),
      before: opsEntitlementSnapshotLineSchema,
      after: opsEntitlementSnapshotLineSchema,
    }),
  ),
});
export type OpsEntitlementDiff = z.infer<typeof opsEntitlementDiffSchema>;

export const opsEntitlementChangeRequestSchema = z.object({
  id: z.uuid(),
  subjectType: opsEntitlementSubjectTypeSchema,
  subjectId: z.uuid(),
  subjectNo: z.string().nullable(),
  changeType: opsEntitlementChangeTypeSchema,
  status: opsChangeRequestStatusSchema,
  sourceContractId: z.uuid().nullable(),
  proposedSnapshotId: z.uuid().nullable(),
  proposedSnapshot: opsEntitlementSnapshotSchema.nullable(),
  reason: z.string().min(1),
  beforeSummary: opsEntitlementLineSetSchema,
  afterSummary: opsEntitlementLineSetSchema,
  requestedBy: opsOperatorRefSchema.nullable(),
  approvedBy: opsOperatorRefSchema.nullable(),
  approvedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  commandId: z.uuid().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsEntitlementChangeRequest = z.infer<typeof opsEntitlementChangeRequestSchema>;

/**
 * 下发命令。表属 o-t10，本轮恒为 `null`；形状先定下来，免得 o-t10 落地时
 * 前端要改一次响应类型。
 */
export const opsEntitlementCommandSchema = z.object({
  id: z.uuid(),
  status: z.string().min(1),
});
export type OpsEntitlementCommand = z.infer<typeof opsEntitlementCommandSchema>;

// ── 入站请求 ─────────────────────────────────────────────────────────────────

/**
 * 一条权益输入。
 *
 * 全部字段除 `featureKey` 外都可省略——省略不是「置空」，是「沿用基线」：
 * `enabled` 省略即保持基线值，`quota` 省略即保持基线额度。要真的清空一个
 * 额度得显式传 `null`。
 *
 * `displayNameSnapshot` **不接受**：快照里的名称一律取字典当时的写法，允许
 * 调用方传等于允许伪造证据。
 */
export const opsFeatureInputSchema = z.strictObject({
  featureKey: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional(),
  quota: z.number().min(0).nullable().optional(),
  termMonths: z.number().int().min(1).nullable().optional(),
});
export type OpsFeatureInput = z.infer<typeof opsFeatureInputSchema>;

export const opsSubscriptionCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  contractItemId: z.uuid(),
  billingCycle: opsBillingCycleSchema,
  startsOn: z.iso.date(),
  endsOn: z.iso.date().nullable().optional(),
  autoRenewIntent: z.boolean().optional(),
  features: z.array(opsFeatureInputSchema).max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type OpsSubscriptionCreateRequest = z.infer<typeof opsSubscriptionCreateRequestSchema>;

export const opsSubscriptionListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsSubjectStatusSchema).optional(),
  productId: z.uuid().optional(),
  /**
   * 「N 天内到期」。只找还没到期、但快到期的那批：已过期的不算临期，否则
   * 临期清单会永远堆着历史数据，而它是总览里唯一会被追问的数字。
   */
  expiringInDays: z.coerce.number().int().min(1).max(3650).optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsSubscriptionListQuery = z.infer<typeof opsSubscriptionListQuerySchema>;

export const opsLicenseCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  contractItemId: z.uuid(),
  deploymentInstanceId: z.uuid().nullable().optional(),
  licenseMode: opsLicenseModeSchema,
  validFrom: z.iso.date(),
  validTo: z.iso.date().nullable().optional(),
  maintenanceUntil: z.iso.date().nullable().optional(),
  features: z.array(opsFeatureInputSchema).max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type OpsLicenseCreateRequest = z.infer<typeof opsLicenseCreateRequestSchema>;

export const opsLicenseListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsSubjectStatusSchema).optional(),
  expiringInDays: z.coerce.number().int().min(1).max(3650).optional(),
  deploymentInstanceId: z.uuid().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsLicenseListQuery = z.infer<typeof opsLicenseListQuerySchema>;

/**
 * 状态迁移。
 *
 * `version` 是乐观锁：两个人同时点「审批」，后到的必须看见冲突，否则先批的那个
 * 动作被静默覆盖，审计里看起来只批过一次。可省——省掉就是「不看版本直接改」，
 * 用于后台批处理。
 */
export const opsSubjectTransitionRequestSchema = z.strictObject({
  action: opsSubjectTransitionActionSchema,
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().min(1).optional(),
});
export type OpsSubjectTransitionRequest = z.infer<typeof opsSubjectTransitionRequestSchema>;

/**
 * 提变更申请。
 *
 * `proposedFeatures` 是**增量**，不是全量：只传要改的项，其余沿用当前快照。
 * 传全量会让「客户单独加购的功能」在界面只提交了改动项时被静默删掉——这正是
 * 数据库层 `feature_lines_apply` 以当前快照为基线的原因。
 */
export const opsChangeRequestCreateRequestSchema = z.strictObject({
  changeType: opsEntitlementChangeTypeSchema,
  reason: z.string().trim().min(1).max(500),
  proposedFeatures: z.array(opsFeatureInputSchema).max(200).optional(),
  effectiveOn: z.iso.date().optional(),
});
export type OpsChangeRequestCreateRequest = z.infer<typeof opsChangeRequestCreateRequestSchema>;

export const opsChangeRequestTransitionRequestSchema = z.strictObject({
  action: opsChangeRequestActionSchema,
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().min(1).optional(),
});
export type OpsChangeRequestTransitionRequest = z.infer<
  typeof opsChangeRequestTransitionRequestSchema
>;

export const opsChangeRequestListQuerySchema = z.object({
  subjectType: opsEntitlementSubjectTypeSchema.optional(),
  status: z.array(opsChangeRequestStatusSchema).optional(),
  customerId: z.uuid().optional(),
  requestedBy: z.uuid().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsChangeRequestListQuery = z.infer<typeof opsChangeRequestListQuerySchema>;

export const opsSnapshotListQuerySchema = z.object({
  subjectType: opsEntitlementSubjectTypeSchema.optional(),
  subjectId: z.uuid().optional(),
  validFromFrom: z.iso.date().optional(),
  validFromTo: z.iso.date().optional(),
  sourceType: opsSnapshotSourceTypeSchema.optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsSnapshotListQuery = z.infer<typeof opsSnapshotListQuerySchema>;

// ── 出站响应 ─────────────────────────────────────────────────────────────────

export const opsSubscriptionListResponseSchema = pagedResponseSchema(opsSubscriptionSchema);
export type OpsSubscriptionListResponse = z.infer<typeof opsSubscriptionListResponseSchema>;

export const opsSubscriptionCreateResponseSchema = z.object({
  subscription: opsSubscriptionSchema,
  snapshot: opsEntitlementSnapshotSchema.nullable(),
});
export type OpsSubscriptionCreateResponse = z.infer<typeof opsSubscriptionCreateResponseSchema>;

export const opsSubscriptionDetailResponseSchema = z.object({
  subscription: opsSubscriptionSchema,
  snapshot: opsEntitlementSnapshotDetailSchema.nullable(),
  changeRequests: z.array(opsEntitlementChangeRequestSchema),
  /** 租户映射属 o-t10，本轮恒为 null。 */
  tenantMapping: z.null(),
});
export type OpsSubscriptionDetailResponse = z.infer<typeof opsSubscriptionDetailResponseSchema>;

/** 订阅迁移的响应：`command` 可为 null（命令表属 o-t10）。 */
export const opsSubscriptionTransitionResponseSchema = z.object({
  subscription: opsSubscriptionSchema,
  command: opsEntitlementCommandSchema.nullable(),
});
export type OpsSubscriptionTransitionResponse = z.infer<
  typeof opsSubscriptionTransitionResponseSchema
>;

export const opsLicenseListResponseSchema = pagedResponseSchema(opsLicenseSchema);
export type OpsLicenseListResponse = z.infer<typeof opsLicenseListResponseSchema>;

export const opsLicenseCreateResponseSchema = z.object({
  license: opsLicenseSchema,
  snapshot: opsEntitlementSnapshotSchema.nullable(),
});
export type OpsLicenseCreateResponse = z.infer<typeof opsLicenseCreateResponseSchema>;

export const opsLicenseDetailResponseSchema = z.object({
  license: opsLicenseSchema,
  snapshot: opsEntitlementSnapshotDetailSchema.nullable(),
  changeRequests: z.array(opsEntitlementChangeRequestSchema),
  /** 部署实例属 o-t11，本轮恒为 null。 */
  deployment: z.null(),
});
export type OpsLicenseDetailResponse = z.infer<typeof opsLicenseDetailResponseSchema>;

export const opsLicenseTransitionResponseSchema = z.object({
  license: opsLicenseSchema,
  command: opsEntitlementCommandSchema.nullable(),
});
export type OpsLicenseTransitionResponse = z.infer<typeof opsLicenseTransitionResponseSchema>;

export const opsChangeRequestCreateResponseSchema = z.object({
  changeRequest: opsEntitlementChangeRequestSchema,
  diff: opsEntitlementDiffSchema,
});
export type OpsChangeRequestCreateResponse = z.infer<typeof opsChangeRequestCreateResponseSchema>;

export const opsChangeRequestListResponseSchema = pagedResponseSchema(
  opsEntitlementChangeRequestSchema,
);
export type OpsChangeRequestListResponse = z.infer<typeof opsChangeRequestListResponseSchema>;

export const opsChangeRequestDetailResponseSchema = z.object({
  changeRequest: opsEntitlementChangeRequestSchema,
  diff: opsEntitlementDiffSchema,
  command: opsEntitlementCommandSchema.nullable(),
});
export type OpsChangeRequestDetailResponse = z.infer<typeof opsChangeRequestDetailResponseSchema>;

export const opsChangeRequestTransitionResponseSchema = z.object({
  changeRequest: opsEntitlementChangeRequestSchema,
  diff: opsEntitlementDiffSchema,
  command: opsEntitlementCommandSchema.nullable(),
});
export type OpsChangeRequestTransitionResponse = z.infer<
  typeof opsChangeRequestTransitionResponseSchema
>;

export const opsSnapshotListResponseSchema = pagedResponseSchema(opsEntitlementSnapshotSchema);
export type OpsSnapshotListResponse = z.infer<typeof opsSnapshotListResponseSchema>;

export const opsSnapshotDetailResponseSchema = z.object({
  snapshot: opsEntitlementSnapshotSchema,
  lines: z.array(opsEntitlementSnapshotLineSchema),
});
export type OpsSnapshotDetailResponse = z.infer<typeof opsSnapshotDetailResponseSchema>;
