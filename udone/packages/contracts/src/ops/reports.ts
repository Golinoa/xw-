import { z } from 'zod';
import { opsTenantCommandTypeSchema } from './tenant-integration';

/** * 报表域（契约 §5.9 的四个 `/reports/*`、§10 口径映射、T-13）。
 *
 * 报表与列表的区别不在数据量，在**可信度**：列表是「一条一条看」，报表是
 * 「拿这个数去开会」。所以四份响应都带 `statisticsAt`——没有它，两张报表之间
 * 差 3 分钟就无法判断是「数据变了」还是「算错了」。
 *
 * 应收报表还额外带 `filtersEcho`：它让「这张报表是怎么算出来的」跟着数字一起走。
 * 导出文件里没有这一块，事后就无法复现同一张报表——而财务复核恰恰总是事后。
 *
 * 三个「契约没写死、实现选了」的默认值（都写在这里，前端按它做默认筛选）：
 * - `groupBy` 缺省 `customer`：报表的默认读者是商务，最常问「哪些客户欠钱」；
 * - `subjectType` 缺省「两种都要」：最常问「这个月有什么要到期」；
 * - `status`（部署版本）缺省「active + maintenance」：`planned` 没上线、
 *   `retired` 已下线，混进去就是把历史包袱当现状。
 */

export const OPS_REPORT_GROUP_BY = ['customer', 'contract', 'dueMonth'] as const;
export const opsReportGroupBySchema = z.enum(OPS_REPORT_GROUP_BY);
export type OpsReportGroupBy = z.infer<typeof opsReportGroupBySchema>;

export const OPS_REPORT_SUBJECT_TYPES = ['subscription', 'licence'] as const;
export const opsReportSubjectTypeSchema = z.enum(OPS_REPORT_SUBJECT_TYPES);
export type OpsReportSubjectType = z.infer<typeof opsReportSubjectTypeSchema>;

/** 有效实例的状态：版本分布只看这两个。 */
export const OPS_DEPLOYMENT_LIVE_STATUSES = ['active', 'maintenance'] as const;
export const opsDeploymentLiveStatusSchema = z.enum(OPS_DEPLOYMENT_LIVE_STATUSES);

const customerRefSchema = z.object({
  id: z.uuid(),
  customerNo: z.string().min(1),
  name: z.string().min(1),
});

const amountTotalsSchema = z.object({
  count: z.number().int(),
  totalAmount: z.number(),
  settledAmount: z.number(),
  outstandingAmount: z.number(),
  overdueAmount: z.number(),
});

// ── 应收报表 ────────────────────────────────────────────────────────────────

export const opsReceivableReportQuerySchema = z.object({
  customerId: z.uuid().optional(),
  contractId: z.uuid().optional(),
  /** 可重复：`?status=overdue&status=partial`。 */
  status: z.array(z.string().min(1)).optional(),
  dueFrom: z.iso.date().optional(),
  dueTo: z.iso.date().optional(),
  groupBy: opsReportGroupBySchema.optional(),
});
export type OpsReceivableReportQuery = z.infer<typeof opsReceivableReportQuerySchema>;

export const opsReceivableReportRowSchema = amountTotalsSchema.extend({
  /** 机器用：customerId / contractId / `2026-11`。 */
  key: z.string().min(1),
  /** 给人看：客户名 / 合同号 / `2026 年 11 月`。 */
  label: z.string().min(1),
});

export const opsReceivableReportResponseSchema = z.object({
  statisticsAt: z.iso.datetime({ offset: true }),
  groupBy: opsReportGroupBySchema,
  rows: z.array(opsReceivableReportRowSchema),
  totals: amountTotalsSchema,
  filtersEcho: z.object({
    customerId: z.uuid().nullable(),
    contractId: z.uuid().nullable(),
    status: z.array(z.string()).nullable(),
    dueFrom: z.iso.date().nullable(),
    dueTo: z.iso.date().nullable(),
    groupBy: opsReportGroupBySchema,
  }),
});
export type OpsReceivableReportResponse = z.infer<typeof opsReceivableReportResponseSchema>;

// ── 临期权益报表 ────────────────────────────────────────────────────────────

export const opsExpiringEntitlementReportQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  subjectType: opsReportSubjectTypeSchema.optional(),
});
export type OpsExpiringEntitlementReportQuery = z.infer<
  typeof opsExpiringEntitlementReportQuerySchema
>;

export const opsExpiringEntitlementReportRowSchema = z.object({
  subjectType: opsReportSubjectTypeSchema,
  id: z.uuid(),
  customer: customerRefSchema,
  /** 授权不挂产品（`private_licenses` 没有 product_id），所以这里可以是 null。 */
  product: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  status: z.string().min(1),
  validTo: z.iso.date(),
  /** 派生值：每天在变，不落库。到期当天是 0，不是 1。 */
  daysRemaining: z.number().int(),
});

export const opsExpiringEntitlementReportResponseSchema = z.object({
  statisticsAt: z.iso.datetime({ offset: true }),
  windowDays: z.number().int().min(1).max(365),
  rows: z.array(opsExpiringEntitlementReportRowSchema),
});
export type OpsExpiringEntitlementReportResponse = z.infer<
  typeof opsExpiringEntitlementReportResponseSchema
>;

// ── 租户同步失败报表 ────────────────────────────────────────────────────────

export const opsTenantSyncFailureReportQuerySchema = z.object({
  commandType: opsTenantCommandTypeSchema.optional(),
  createdFrom: z.iso.date().optional(),
});
export type OpsTenantSyncFailureReportQuery = z.infer<typeof opsTenantSyncFailureReportQuerySchema>;

export const opsTenantSyncFailureReportRowSchema = z.object({
  commandId: z.uuid(),
  commandNo: z.string().min(1),
  mapping: z.object({ id: z.uuid(), mappingNo: z.string().min(1) }),
  customer: customerRefSchema,
  commandType: opsTenantCommandTypeSchema,
  attemptCount: z.number().int(),
  /**
   * `transient` / `permanent`。**可空**：命令可能在建单时就被判失败，
   * 一条 attempt 都没有——那种情况下「错误类别」确实还没有。
   */
  lastErrorCategory: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  /** 最后一次尝试的开始时刻（来自 attempts），不是建单时刻。 */
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
});

export const opsTenantSyncFailureReportResponseSchema = z.object({
  statisticsAt: z.iso.datetime({ offset: true }),
  rows: z.array(opsTenantSyncFailureReportRowSchema),
});
export type OpsTenantSyncFailureReportResponse = z.infer<
  typeof opsTenantSyncFailureReportResponseSchema
>;

// ── 部署版本分布报表 ────────────────────────────────────────────────────────

export const opsDeploymentVersionReportQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsDeploymentLiveStatusSchema).optional(),
});
export type OpsDeploymentVersionReportQuery = z.infer<typeof opsDeploymentVersionReportQuerySchema>;

export const opsDeploymentVersionReportRowSchema = z.object({
  version: z.string().min(1),
  instanceCount: z.number().int(),
  customers: z.array(customerRefSchema),
});

export const opsDeploymentVersionReportResponseSchema = z.object({
  statisticsAt: z.iso.datetime({ offset: true }),
  rows: z.array(opsDeploymentVersionReportRowSchema),
  /** 没有登记版本的实例单列：混进某个版本号里会让「1.4.0 有 5 台」变成假话。 */
  unknownVersionCount: z.number().int(),
});
export type OpsDeploymentVersionReportResponse = z.infer<
  typeof opsDeploymentVersionReportResponseSchema
>;
