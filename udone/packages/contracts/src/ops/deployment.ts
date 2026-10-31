import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';

/**
 * deployment 域（契约 §3.7 / §5.8，七个端点：私有化部署实例与升级记录）。
 *
 * 这一域对外只有一句话需要说清：**当前版本不是一个可以随手改的字段**。
 *
 * 三处口径：
 *
 * 1. **`currentVersion` 只在登记一条 `succeeded` 的升级记录时前进**（D-07）。
 *    `failed` 与 `rolled_back` 都保持原值。所以更新请求的 schema 里**没有**
 *    `currentVersion`——不是漏了，是不允许：它能被 PATCH 改的话，
 *    `fromVersion` 与当前版本的比对就永远能绕过，历史变成装饰。
 * 2. **`lastReportedAt` 是派生值**（D-04）：取最近一条升级记录的 `createdAt`，
 *    不是心跳。没有升级记录时是 `null`，而不是 `createdAt`——「从没上报过」
 *    与「刚刚建好」必须分得开，否则列表里所有新实例都会显示「今天上报过」。
 * 3. **`allowedActions` 在信封上、不在实例里。** 它是「此刻能对它做什么」，
 *    不是实例的属性；放进实例对象会让同一条实例在两份快照里带着不同的
 *    `allowedActions`，而那两份快照的其余字段一模一样。
 */

export const OPS_DEPLOYMENT_TYPES = ['private', 'dedicated'] as const;
export const opsDeploymentTypeSchema = z.enum(OPS_DEPLOYMENT_TYPES);
export type OpsDeploymentType = z.infer<typeof opsDeploymentTypeSchema>;

export const OPS_DEPLOYMENT_STATUSES = ['planned', 'active', 'maintenance', 'retired'] as const;
export const opsDeploymentStatusSchema = z.enum(OPS_DEPLOYMENT_STATUSES);
export type OpsDeploymentStatus = z.infer<typeof opsDeploymentStatusSchema>;

export const OPS_DEPLOYMENT_VERSION_RESULTS = ['succeeded', 'failed', 'rolled_back'] as const;
export const opsDeploymentVersionResultSchema = z.enum(OPS_DEPLOYMENT_VERSION_RESULTS);
export type OpsDeploymentVersionResult = z.infer<typeof opsDeploymentVersionResultSchema>;

/**
 * 实例状态机的四条边（契约 §3.7）。`retired` 是终态，没有出边。
 *
 * 顺序与 §3.7 的表格一致，前端按它渲染按钮的顺序；`retire` 排在最后，因为它是
 * 唯一一条从任何非终态都能走、且不可撤销的边。
 */
export const OPS_DEPLOYMENT_ACTIONS = [
  'go_live',
  'start_maintenance',
  'end_maintenance',
  'retire',
] as const;
export const opsDeploymentActionSchema = z.enum(OPS_DEPLOYMENT_ACTIONS);
export type OpsDeploymentAction = z.infer<typeof opsDeploymentActionSchema>;

// ── 出站形状 ─────────────────────────────────────────────────────────────────

export const opsDeploymentCustomerRefSchema = z.object({
  id: z.uuid(),
  customerNo: z.string().min(1),
  name: z.string().min(1),
});
export type OpsDeploymentCustomerRef = z.infer<typeof opsDeploymentCustomerRefSchema>;

/**
 * 负责人摘要。不带邮箱：`deployment.read` 是售后与只读角色都有的低危权限，
 * 而邮箱要 `operator.read`——一列负责人名字不该顺手把邮箱带出去。
 */
export const opsDeploymentOwnerRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
  status: z.string().min(1),
});
export type OpsDeploymentOwnerRef = z.infer<typeof opsDeploymentOwnerRefSchema>;

export const opsDeploymentInstanceSchema = z.object({
  id: z.uuid(),
  instanceNo: z.string().min(1),
  customer: opsDeploymentCustomerRefSchema,
  name: z.string().min(1),
  deploymentType: opsDeploymentTypeSchema,
  /** 客户环境的**名称**（例如 `bj-prod-01`），永远不是连接串。 */
  environmentRef: z.string().nullable(),
  /** 唯一由「登记 + succeeded」推进的字段。 */
  currentVersion: z.string().nullable(),
  status: opsDeploymentStatusSchema,
  goLiveOn: z.string().nullable(),
  maintenanceUntil: z.string().nullable(),
  owner: opsDeploymentOwnerRefSchema.nullable(),
  contractId: z.uuid().nullable(),
  licenseId: z.uuid().nullable(),
  /** 派生：最近一条升级记录的 `createdAt`（D-04）。没有记录时是 null。 */
  lastReportedAt: z.string().nullable(),
  version: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsDeploymentInstance = z.infer<typeof opsDeploymentInstanceSchema>;

export const opsDeploymentOperatorRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1),
});
export type OpsDeploymentOperatorRef = z.infer<typeof opsDeploymentOperatorRefSchema>;

export const opsDeploymentVersionRecordSchema = z.object({
  id: z.uuid(),
  instanceId: z.uuid(),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  executedOn: z.string().min(1),
  /** 从会话里取，不接受入参：升级记录必须能追到人。 */
  executedBy: opsDeploymentOperatorRefSchema,
  result: opsDeploymentVersionResultSchema,
  impactNote: z.string().nullable(),
  rollbackNote: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type OpsDeploymentVersionRecord = z.infer<typeof opsDeploymentVersionRecordSchema>;

/** 详情里的授权摘要。完整授权走 `GET /licenses/{licenseId}`。 */
export const opsDeploymentLicenseRefSchema = z.object({
  id: z.uuid(),
  licenseNo: z.string().min(1),
  licenseMode: z.string().min(1),
  status: z.string().min(1),
  validFrom: z.string().min(1),
  validTo: z.string().nullable(),
  maintenanceUntil: z.string().nullable(),
});
export type OpsDeploymentLicenseRef = z.infer<typeof opsDeploymentLicenseRefSchema>;

/** 详情里的工单摘要。完整工单走 `GET /tickets/{ticketId}`。 */
export const opsDeploymentTicketRefSchema = z.object({
  id: z.uuid(),
  ticketNo: z.string().min(1),
  subject: z.string().min(1),
  priority: z.string().min(1),
  status: z.string().min(1),
});
export type OpsDeploymentTicketRef = z.infer<typeof opsDeploymentTicketRefSchema>;

// ── 入站请求 ─────────────────────────────────────────────────────────────────

export const opsDeploymentCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  deploymentType: opsDeploymentTypeSchema,
  environmentRef: z.string().trim().min(1).max(120).optional(),
  /** 登记初始版本是可选的：先建台账、上线时再登记第一条升级记录也合法。 */
  currentVersion: z.string().trim().min(1).max(40).optional(),
  goLiveOn: z.iso.date().optional(),
  maintenanceUntil: z.iso.date().optional(),
  ownerOperatorId: z.uuid().optional(),
  licenseId: z.uuid().optional(),
  contractId: z.uuid().optional(),
});
export type OpsDeploymentCreateRequest = z.infer<typeof opsDeploymentCreateRequestSchema>;

/**
 * PATCH 的字段全部可选，且**可空**——`null` 是「清空这一列」，不传是「别动」。
 * 两者在 SQL 里长得一样，所以到 RPC 时靠「键在不在 patch 里」区分。
 *
 * `currentVersion` 不在这里（见文件头的第 1 条）。
 */
export const opsDeploymentUpdateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  deploymentType: opsDeploymentTypeSchema.optional(),
  environmentRef: z.string().trim().min(1).max(120).nullable().optional(),
  goLiveOn: z.iso.date().nullable().optional(),
  maintenanceUntil: z.iso.date().nullable().optional(),
  ownerOperatorId: z.uuid().nullable().optional(),
  licenseId: z.uuid().nullable().optional(),
  contractId: z.uuid().nullable().optional(),
  version: z.number().int().min(0),
});
export type OpsDeploymentUpdateRequest = z.infer<typeof opsDeploymentUpdateRequestSchema>;

export const opsDeploymentTransitionRequestSchema = z.strictObject({
  action: opsDeploymentActionSchema,
  /** `retire` 必填。放这里而不是拆两个端点：一条边一个端点会让状态机的形状散在路由表里。 */
  reason: z.string().trim().max(500).optional(),
  /** 只对 `go_live` 有意义。实例上已经有上线日期时可以不传。 */
  goLiveOn: z.iso.date().optional(),
  version: z.number().int().min(0),
});
export type OpsDeploymentTransitionRequest = z.infer<typeof opsDeploymentTransitionRequestSchema>;

export const opsDeploymentVersionRecordCreateRequestSchema = z.strictObject({
  fromVersion: z.string().trim().min(1).max(40),
  toVersion: z.string().trim().min(1).max(40),
  executedOn: z.iso.date(),
  result: opsDeploymentVersionResultSchema,
  impactNote: z.string().trim().max(1000).optional(),
  rollbackNote: z.string().trim().max(1000).optional(),
});
export type OpsDeploymentVersionRecordCreateRequest = z.infer<
  typeof opsDeploymentVersionRecordCreateRequestSchema
>;

export const opsDeploymentListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsDeploymentStatusSchema).optional(),
  deploymentType: opsDeploymentTypeSchema.optional(),
  currentVersion: z.string().trim().max(40).optional(),
  /** 早于等于这一天的实例。没有维护到期日的实例不进结果集。 */
  maintenanceUntilBefore: z.iso.date().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsDeploymentListQuery = z.infer<typeof opsDeploymentListQuerySchema>;

/**
 * 升级记录列表只有分页。没有 `result` 筛选：一次升级的记录通常个位数，
 * 「只看失败的」这件事在详情页里翻两屏就完了，多一个筛选值就多一份要维护的
 * 白名单（`GET /deployments` 那边已经有四个了）。
 */
export const opsDeploymentVersionRecordListQuerySchema = z.object({
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsDeploymentVersionRecordListQuery = z.infer<
  typeof opsDeploymentVersionRecordListQuerySchema
>;

// ── 出站响应 ─────────────────────────────────────────────────────────────────

export const opsDeploymentListResponseSchema = pagedResponseSchema(opsDeploymentInstanceSchema);
export type OpsDeploymentListResponse = z.infer<typeof opsDeploymentListResponseSchema>;

export const opsDeploymentCreateResponseSchema = z.object({
  deployment: opsDeploymentInstanceSchema,
});
export type OpsDeploymentCreateResponse = z.infer<typeof opsDeploymentCreateResponseSchema>;

export const opsDeploymentDetailResponseSchema = z.object({
  deployment: opsDeploymentInstanceSchema,
  allowedActions: z.array(opsDeploymentActionSchema),
  versionRecords: z.array(opsDeploymentVersionRecordSchema),
  licenses: z.array(opsDeploymentLicenseRefSchema),
  tickets: z.array(opsDeploymentTicketRefSchema),
});
export type OpsDeploymentDetailResponse = z.infer<typeof opsDeploymentDetailResponseSchema>;

export const opsDeploymentUpdateResponseSchema = z.object({
  deployment: opsDeploymentInstanceSchema,
});
export type OpsDeploymentUpdateResponse = z.infer<typeof opsDeploymentUpdateResponseSchema>;

/** 迁移之后把「接下来还能做什么」一起回：前端不必再查一次详情才能重画按钮。 */
export const opsDeploymentTransitionResponseSchema = z.object({
  deployment: opsDeploymentInstanceSchema,
  allowedActions: z.array(opsDeploymentActionSchema),
});
export type OpsDeploymentTransitionResponse = z.infer<typeof opsDeploymentTransitionResponseSchema>;

export const opsDeploymentVersionRecordCreateResponseSchema = z.object({
  versionRecord: opsDeploymentVersionRecordSchema,
  /** 登记之后的实例：`currentVersion` 可能已经变了，调用方不必回查。 */
  deployment: opsDeploymentInstanceSchema,
});
export type OpsDeploymentVersionRecordCreateResponse = z.infer<
  typeof opsDeploymentVersionRecordCreateResponseSchema
>;

export const opsDeploymentVersionRecordListResponseSchema = pagedResponseSchema(
  opsDeploymentVersionRecordSchema,
);
export type OpsDeploymentVersionRecordListResponse = z.infer<
  typeof opsDeploymentVersionRecordListResponseSchema
>;
