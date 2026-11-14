/**
 * 权益域类型（entitlement）。
 *
 * 真源：`Docs/ops-api-contract.md` §3.5（数据模型/状态机）与 §5.6（端点）。
 * 规则：
 * 1. 字段名严格照抄契约，不得自行改名；数据库列 `quota_value` 对外字段是 `quota`
 *    （§5.6 响应与 §5.4 权益预览一致），本文件只使用 `quota`；
 * 2. 契约未给出的形态（`before_summary`/`after_summary` 是 jsonb、列表快照摘要在
 *    §5.6 未列出）显式标注「契约推导」，并由渲染层做降级，不允许整页返工；
 * 3. 额度 `quota`（`numeric(14,2)`）只做类型与格式化，**前端不做任何额度运算**；
 *    列表里的额度摘要取服务端字段（`snapshotSummary`），不在浏览器求和。
 */

/** 订阅/授权状态（契约 §3.5 状态机；与 PRD §8 同一枚举）。 */
export type EntitlementStatus =
  | 'active'
  | 'draft'
  | 'expired'
  | 'pending_approval'
  | 'revoked'
  | 'suspended';

/** 计费周期（契约 §3.5 `billing_cycle`）。 */
export type BillingCycle = 'monthly' | 'multi_year' | 'quarterly' | 'yearly';

/** 授权方式（契约 §3.5 `license_mode`）。永久授权 ≠ 永久更新。 */
export type LicenseMode = 'perpetual' | 'term';

/** 快照来源类型（契约 §3.5 `source_type`）。 */
export type SnapshotSourceType = 'change_request' | 'contract_item';

/** 快照目标范围（契约 §3.5 `target_scope`）。 */
export type SnapshotTargetScope = 'private_instance' | 'saas_tenant';

/** 变更主体（契约 §3.5 `subject_type`）。 */
export type EntitlementSubjectType = 'license' | 'subscription';

/** 变更类型（契约 §3.5 `change_type`，九个值，不得增删）。 */
export type ChangeRequestType =
  | 'downgrade'
  | 'expire'
  | 'extend'
  | 'issue'
  | 'quota_change'
  | 'resume'
  | 'revoke'
  | 'suspend'
  | 'upgrade';

/** 变更申请状态（契约 §3.5「变更申请状态机（推导）」，登记为 U-04）。 */
export type ChangeRequestStatus =
  | 'approved'
  | 'cancelled'
  | 'draft'
  | 'executed'
  | 'executing'
  | 'failed'
  | 'pending_approval'
  | 'rejected';

/** 订阅/授权草稿期的状态动作（契约 §3.5 前三行）。 */
export type EntitlementTransitionAction = 'approve' | 'reject' | 'submit';

/** 变更申请状态动作（契约 §5.6 transition 端点）。 */
export type ChangeRequestTransitionAction =
  | 'approve'
  | 'cancel'
  | 'execute'
  | 'reject'
  | 'retry';

/** 分页查询公共参数（契约 §2.4）。 */
export interface EntitlementListQuery {
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  sort?: string;
}

/** 分页响应公共形态（契约 §2.4）。 */
export interface EntitlementPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** 操作者引用：契约表格列是 `uuid`，展示需要姓名，两种形态都要能渲染。 */
export type EntitlementActorRef = string | { displayName?: string; id: string };

/** 客户引用（契约 §5.6 内嵌 `customer{...}`）。 */
export interface EntitlementCustomerRef {
  customerNo?: string;
  id: string;
  name: string;
}

/** 产品引用（契约 §5.6 内嵌 `product{...}`）。 */
export interface EntitlementProductRef {
  code?: string;
  id: string;
  name: string;
}

/** 部署实例引用（授权详情 `deployment?`）。 */
export interface EntitlementDeploymentRef {
  id: string;
  instanceNo?: string;
  name: string;
  status?: string;
}

/**
 * 快照摘要（列表行内展示「功能键数、额度摘要」）。
 *
 * 契约推导：§5.6 列表条目未列快照字段，但 PRD §6.6 要求列表可见当前权益。
 * 摘要是**服务端计算**的计数与额度合计，前端只格式化——避免在浏览器做额度累加。
 */
export interface SnapshotSummary {
  enabledCount: number;
  featureCount: number;
  /** 服务端给出的额度合计；无额度型功能键时为 `null`。 */
  quotaTotal: null | number;
}

/** 快照行（契约 §3.5 `entitlement_snapshot_lines`，仅 INSERT）。 */
export interface EntitlementSnapshotLine {
  displayNameSnapshot: string;
  enabled: boolean;
  featureKey: string;
  /** `numeric(14,2)`，非额度型功能键为 `null`。 */
  quota: null | number;
  termMonths: null | number;
}

/** 权益快照（契约 §3.5 `entitlement_snapshots`，仅 INSERT，发放后不可覆写）。 */
export interface EntitlementSnapshot {
  contentHash: string;
  createdAt?: string;
  createdBy?: EntitlementActorRef;
  id: string;
  lines: EntitlementSnapshotLine[];
  sourceId: string;
  sourceType: SnapshotSourceType;
  targetRef?: null | string;
  targetScope: SnapshotTargetScope;
  validFrom?: null | string;
  validTo?: null | string;
}

/** 快照历史条目（只读，按 `createdAt` 倒序由服务端返回）。 */
export interface EntitlementSnapshotSummary {
  contentHash: string;
  createdAt: string;
  createdBy?: EntitlementActorRef;
  id: string;
  lineCount?: number;
  snapshotSummary?: SnapshotSummary;
  sourceId: string;
  sourceType: SnapshotSourceType;
  targetScope: SnapshotTargetScope;
  validFrom?: null | string;
  validTo?: null | string;
}

/** 快照历史查询（契约推导端点 `GET /entitlement-snapshots`，见 endpoints.ts）。 */
export interface SnapshotListQuery extends EntitlementListQuery {
  customerId?: string;
  sourceId?: string;
  sourceType?: SnapshotSourceType;
  targetScope?: SnapshotTargetScope;
}

export type SnapshotListResult =
  EntitlementPagedResult<EntitlementSnapshotSummary>;

// ---------------------------------------------------------------- 订阅

/** SaaS 订阅（契约 §3.5 `ops.subscriptions` + §5.6 列表条目）。 */
export interface Subscription {
  autoRenewIntent: boolean;
  billingCycle: BillingCycle;
  contractId?: null | string;
  contractItemId?: null | string;
  currentSnapshotId?: null | string;
  customer: EntitlementCustomerRef;
  endsOn?: null | string;
  id: string;
  product?: EntitlementProductRef | null;
  snapshotSummary?: null | SnapshotSummary;
  startsOn: string;
  status: EntitlementStatus;
  subscriptionNo: string;
  /** 乐观锁版本：任何状态动作必须回传。 */
  version?: number;
}

export interface SubscriptionListQuery extends EntitlementListQuery {
  billingCycle?: BillingCycle;
  customerId?: string;
  /** 到期日下界（契约推导，等价于「到期区间」筛选）。 */
  endsFrom?: string;
  /** 到期日上界（契约推导）。 */
  endsTo?: string;
  /** 契约字段：N 天内到期。 */
  expiringInDays?: number;
  productId?: string;
  status?: EntitlementStatus[];
}

export type SubscriptionListResult = EntitlementPagedResult<Subscription>;

export interface SubscriptionDetail {
  changeRequests: EntitlementChangeRequest[];
  /** 契约推导：快照历史（§3.5 仅 INSERT，历史可回溯）。缺失时页面回退到列表端点。 */
  snapshots?: EntitlementSnapshotSummary[];
  snapshot: EntitlementSnapshot | null;
  subscription: Subscription;
  tenantMapping?: null | {
    id: string;
    mappingNo?: string;
    mappingStatus: string;
  };
}

/** 提交给服务端的权益行（创建草稿 / 变更申请共用）。 */
export interface EntitlementFeatureInput {
  displayName?: string;
  enabled: boolean;
  featureKey: string;
  quota?: null | number;
  termMonths?: null | number;
}

export interface CreateSubscriptionInput {
  autoRenewIntent?: boolean;
  billingCycle: BillingCycle;
  customerId: string;
  contractItemId: string;
  endsOn?: string;
  features: EntitlementFeatureInput[];
  startsOn: string;
}

export interface CreateSubscriptionResult {
  snapshot: { id: string };
  subscription: Subscription;
}

export interface EntitlementTransitionInput {
  action: EntitlementTransitionAction;
  reason?: string;
  version: number;
}

export interface EntitlementTransitionResult {
  /** 服务端可能回带 `allowedActions`（契约 §3.5：非法迁移统一携带可选动作）。 */
  subscription: {
    allowedActions?: string[];
    status: EntitlementStatus;
    version: number;
  };
}

// ---------------------------------------------------------------- 私有授权

/** 私有化授权（契约 §3.5 `ops.private_licenses`）。 */
export interface License {
  contractId?: null | string;
  contractItemId?: null | string;
  currentSnapshotId?: null | string;
  customer: EntitlementCustomerRef;
  deployment?: EntitlementDeploymentRef | null;
  deploymentInstanceId?: null | string;
  id: string;
  licenseMode: LicenseMode;
  licenseNo: string;
  /** 维护期到期日（与永久授权无关，单独展示）。 */
  maintenanceUntil?: null | string;
  snapshotSummary?: null | SnapshotSummary;
  status: EntitlementStatus;
  validFrom: string;
  validTo?: null | string;
  version?: number;
}

export interface LicenseListQuery extends EntitlementListQuery {
  customerId?: string;
  deploymentInstanceId?: string;
  endsFrom?: string;
  endsTo?: string;
  expiringInDays?: number;
  licenseMode?: LicenseMode;
  status?: EntitlementStatus[];
}

export type LicenseListResult = EntitlementPagedResult<License>;

export interface LicenseDetail {
  changeRequests: EntitlementChangeRequest[];
  deployment?: EntitlementDeploymentRef | null;
  license: License;
  snapshots?: EntitlementSnapshotSummary[];
  snapshot: EntitlementSnapshot | null;
}

export interface CreateLicenseInput {
  customerId: string;
  contractItemId: string;
  deploymentInstanceId: string;
  features: EntitlementFeatureInput[];
  licenseMode: LicenseMode;
  maintenanceUntil?: string;
  validFrom: string;
  /** `license_mode='perpetual'` 时必须留空（契约 §3.5 CHECK）。 */
  validTo?: string;
}

export interface CreateLicenseResult {
  license: License;
  snapshot: { id: string };
}

// ---------------------------------------------------------------- 变更申请

/** 权益摘要（`before_summary` / `after_summary` 的结构契约未定义，按功能键渲染）。 */
export interface EntitlementSummary {
  features?: EntitlementSummaryFeature[];
  note?: string;
  validFrom?: null | string;
  validTo?: null | string;
}

export interface EntitlementSummaryFeature {
  displayName?: string;
  enabled: boolean;
  featureKey: string;
  quota?: null | number;
  termMonths?: null | number;
}

/** 前后值对比（契约 §5.6 `diff{before,after}`）。 */
export interface EntitlementDiff {
  after: EntitlementSummary;
  before: EntitlementSummary;
}

/** 租户命令摘要（`execute` 返回 202 + `command`）。 */
export interface TenantCommandRef {
  id: string;
  status: string;
}

/** 变更申请（契约 §3.5 `ops.entitlement_change_requests`）。 */
export interface EntitlementChangeRequest {
  afterSummary?: EntitlementSummary;
  approvedAt?: null | string;
  approvedBy?: EntitlementActorRef | null;
  beforeSummary?: EntitlementSummary;
  changeType: ChangeRequestType;
  commandId?: null | string;
  createdAt?: string;
  executedAt?: null | string;
  id: string;
  proposedSnapshotId?: null | string;
  reason: string;
  requestedBy?: EntitlementActorRef | null;
  sourceContractId?: null | string;
  status: ChangeRequestStatus;
  subjectId: string;
  subjectType: EntitlementSubjectType;
  /** 乐观锁版本：审批/执行/重试/取消都必须回传。 */
  version?: number;
}

export interface ChangeRequestListQuery extends EntitlementListQuery {
  changeType?: ChangeRequestType;
  customerId?: string;
  requestedBy?: string;
  status?: ChangeRequestStatus[];
  subjectType?: EntitlementSubjectType;
}

export type ChangeRequestListResult =
  EntitlementPagedResult<EntitlementChangeRequest>;

export interface ChangeRequestDetail {
  changeRequest: EntitlementChangeRequest;
  command?: null | TenantCommandRef;
  diff: EntitlementDiff;
}

export interface CreateChangeRequestInput {
  changeType: ChangeRequestType;
  effectiveOn?: string;
  proposedFeatures: EntitlementFeatureInput[];
  reason: string;
}

export interface CreateChangeRequestResult {
  changeRequest: EntitlementChangeRequest;
  diff: EntitlementDiff;
}

export interface ChangeRequestTransitionInput {
  action: ChangeRequestTransitionAction;
  /** 审批/驳回/执行/重试/取消均需原因（契约 §5.6 请求体 `reason` 必填）。 */
  reason: string;
  version: number;
}

export interface ChangeRequestTransitionResult {
  changeRequest: {
    allowedActions?: string[];
    status: ChangeRequestStatus;
    version?: number;
  };
  /** `execute` 返回 202 时带回命令引用；其余动作可能为空。 */
  command?: null | TenantCommandRef;
}
