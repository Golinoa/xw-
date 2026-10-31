import { z } from 'zod';

/**
 * overview 域（契约 §5.9 第一条、§10 口径映射、T-13）。
 *
 * 一份总览里有七个指标，分属五种权限（customer / contract / tenant /
 * entitlement / ticket / receivable）。所以这个响应的形状不是「一组数字」，
 * 而是**一组数字 + 两张缺席清单**：
 *
 * 1. `restrictedMetrics[]`：因为**没权限**而没算的指标名（T-13 原文
 *    「不含其无权指标，返回 `restrictedMetrics[]` 而非 0 冒充」）。
 *    对应的键在 `metrics` 里**不存在**，而不是 `0`。用 0 冒充是最坏的一种：
 *    页面显示「逾期 0 元」，而真相是「你看不到」。
 * 2. `partialFailures[]`：因为**数据不全**而可能偏低的项（§5.9 的 2026-10-30
 *    形状定稿）。当前只有一种：非 CNY 的待处理收款无法进入 `metrics` 的两个
 *    标量金额。
 *
 * 两者必须分开：前者该提示「找管理员开权限」，后者该提示「去补数据」。合成
 * 一个字段会让前端只能猜。
 *
 * `amounts[]` 按币种分组、**不合并**（§2.2）：不同币种相加是个没有意义的数，
 * 而不是一个近似值。
 */

/**
 * 指标名清单。这是 `restrictedMetrics[]` 的取值域，也是前端判断「某个指标
 * 该不该渲染」的唯一依据——按名字判，不按值判（`0` 与「无权」在前端看起来
 * 太像了）。
 */
export const OPS_OVERVIEW_METRICS = [
  'activeCustomers',
  'activeContracts',
  'runningTenants',
  'activeEntitlements',
  'expiringEntitlements',
  'openTickets',
  'waitingTickets',
  'failedSyncCommands',
  'pendingReceiptAmount',
  'unreconciledAmount',
] as const;
export const opsOverviewMetricSchema = z.enum(OPS_OVERVIEW_METRICS);
export type OpsOverviewMetric = z.infer<typeof opsOverviewMetricSchema>;

/**
 * 因为没权限而整块缺席的**区块**（不是指标）。目前只有 `amounts`：
 * 金额区要 `receivable.read`，而这个权限与其余七个指标都不同源——一个能看到
 * 「7 个运行租户」的人可能一分钱都看不到。
 *
 * 与指标名分开列，是因为前端对两者的处理不一样：指标缺席是少一格数字，金额区
 * 缺席是整张币种表换成「无权限查看」。混在一个词表里会让前端只能按名字猜。
 */
export const OPS_OVERVIEW_RESTRICTED_SECTIONS = ['amounts'] as const;

export const opsOverviewRestrictedSchema = z.union([
  opsOverviewMetricSchema,
  z.enum(OPS_OVERVIEW_RESTRICTED_SECTIONS),
]);
export type OpsOverviewRestricted = z.infer<typeof opsOverviewRestrictedSchema>;

/**
 * `partialFailures[]` 的 `code` 词表。契约 §5.9 举例了三个
 * （`RECEIVABLE_SUMMARY` / `ENTITLEMENT_EXPIRY` / `TENANT_SYNC`），但那一组是
 * 「某个区块整体算不出来」；本实现里那三个区块都是直接查询、没有失败路径，
 * 真正会发生的是下面这一条币种混合。
 *
 * 词表开放（`z.string()`）而不是枚举：旧的 API 客户端遇到新 code 应当照常展示
 * `message`，而不是因为 schema 不认识就整份响应 503。
 */
export const OPS_OVERVIEW_PARTIAL_FAILURE_CODES = ['RECEIPT_CURRENCY_MIX'] as const;

export const opsOverviewAmountSchema = z.object({
  currency: z.string().length(3),
  totalReceivable: z.number(),
  settledReceivable: z.number(),
  overdueReceivable: z.number(),
  upcomingReceivable: z.number(),
});
export type OpsOverviewAmount = z.infer<typeof opsOverviewAmountSchema>;

export const opsOverviewPartialFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  section: z.enum(['metrics', 'amounts']).optional(),
});
export type OpsOverviewPartialFailure = z.infer<typeof opsOverviewPartialFailureSchema>;

/**
 * `metrics` 全字段可选：有权限的指标才有键。**不要**给它们加 `.default(0)`
 * ——那正是「0 冒充」的实现方式。
 */
export const opsOverviewMetricsSchema = z.object({
  activeCustomers: z.number().int().optional(),
  activeContracts: z.number().int().optional(),
  runningTenants: z.number().int().optional(),
  activeEntitlements: z.number().int().optional(),
  expiringEntitlements: z.number().int().optional(),
  openTickets: z.number().int().optional(),
  waitingTickets: z.number().int().optional(),
  failedSyncCommands: z.number().int().optional(),
  pendingReceiptAmount: z.number().optional(),
  unreconciledAmount: z.number().optional(),
});
export type OpsOverviewMetrics = z.infer<typeof opsOverviewMetricsSchema>;

export const opsOverviewResponseSchema = z.object({
  /**
   * 统计时刻（§2.3 要求披露）。同一次响应的所有数字共用一个时刻。
   *
   * `offset: true`：SQL 的 `timestamptz` 出 jsonb 时带的是 `+00:00` 而不是
   * `Z`，默认的 `z.iso.datetime()` 会把它判为非法——那条错误出现在 `respond()`
   * 里，症状是整份总览 500，而看不出是时间格式。两种写法都接受：数据库给什么
   * 就收什么，不在边界上做时区改写。
   */
  statisticsAt: z.iso.datetime({ offset: true }),
  windowDays: z.number().int().min(1).max(365),
  metrics: opsOverviewMetricsSchema,
  amounts: z.array(opsOverviewAmountSchema),
  restrictedMetrics: z.array(opsOverviewRestrictedSchema),
  partialFailures: z.array(opsOverviewPartialFailureSchema),
});
export type OpsOverviewResponse = z.infer<typeof opsOverviewResponseSchema>;

/**
 * `windowDays?`（默认取 settings）。范围与 SQL 层同一条：1–365。
 *
 * 上限 365 写在这里是**第二次**约束（SQL 里也判），不是重复劳动：API 层拒掉
 * 之后请求根本不会到 RPC，而直接调 RPC 的脚本仍会被 SQL 挡住。两处都要有。
 */
export const opsOverviewQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type OpsOverviewQuery = z.infer<typeof opsOverviewQuerySchema>;
