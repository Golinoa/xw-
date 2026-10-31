import {
  z,
  type OpsDeploymentVersionReportResponse,
  type OpsExpiringEntitlementReportResponse,
  type OpsReceivableReportResponse,
  type OpsTenantSyncFailureReportResponse,
} from '@erp/contracts';

/**
 * 报表域的出站翻译层（契约 §5.9 四个 `/reports/*`）。
 *
 * 四个报表共用同一套写法：SQL 说列名、这里翻成 JS。看着重复，但每一处的键名
 * 都对得上 SQL 里的 `jsonb_build_object`——多一个、少一个都会被出站 zod 抓到。
 *
 * 两个细节：
 * 1. **`filters_echo` 原样转发**（只翻键）。它是「这张报表怎么算出来的」，
 *    少一个筛选条件，事后就无法复现同一张报表。
 * 2. **`last_attempt_at` 可以是 null**：命令可能在建单时就被判失败，一条
 *    attempt 都没有。那时「最后一次尝试」确实不存在，不是 0 也不是当前时间。
 */

const customerRefRowSchema = z.object({
  id: z.uuid(),
  customer_no: z.string(),
  name: z.string(),
});

const totalsRowSchema = z.object({
  count: z.number().int(),
  total_amount: z.number(),
  settled_amount: z.number(),
  outstanding_amount: z.number(),
  overdue_amount: z.number(),
});

// ── 应收报表 ────────────────────────────────────────────────────────────────

const receivableRowSchema = totalsRowSchema.extend({
  key: z.string(),
  label: z.string(),
});

const receivableFiltersRowSchema = z.object({
  customerId: z.uuid().nullable(),
  contractId: z.uuid().nullable(),
  status: z.array(z.string()).nullable(),
  dueFrom: z.string().nullable(),
  dueTo: z.string().nullable(),
  groupBy: z.string(),
});

const receivableRowEnvelopeSchema = z.object({
  statistics_at: z.string(),
  group_by: z.string(),
  rows: z.array(receivableRowSchema),
  totals: totalsRowSchema,
  filters_echo: receivableFiltersRowSchema,
});

export const receivableReportEnvelopeSchema = z.discriminatedUnion('status', [
  receivableRowEnvelopeSchema.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('invalid_group_by'), value: z.string() }),
]);

// ── 临期权益报表 ────────────────────────────────────────────────────────────

const expiringRowSchema = z.object({
  subject_type: z.string(),
  id: z.uuid(),
  customer: customerRefRowSchema,
  product: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  status: z.string(),
  valid_to: z.string(),
  days_remaining: z.number().int(),
});

const expiringEnvelopeSchema = z.object({
  statistics_at: z.string(),
  window_days: z.number().int(),
  rows: z.array(expiringRowSchema),
});

export const expiringReportEnvelopeSchema = z.discriminatedUnion('status', [
  expiringEnvelopeSchema.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('invalid_window'), value: z.number().int() }),
  z.object({ status: z.literal('invalid_subject_type'), value: z.string() }),
]);

// ── 租户同步失败报表 ────────────────────────────────────────────────────────

const syncRowSchema = z.object({
  command_id: z.uuid(),
  command_no: z.string(),
  mapping: z.object({ id: z.uuid(), mapping_no: z.string() }),
  customer: customerRefRowSchema,
  command_type: z.string(),
  attempt_count: z.number().int(),
  last_error_category: z.string().nullable(),
  last_error_code: z.string().nullable(),
  last_attempt_at: z.string().nullable(),
});

const syncEnvelopeSchema = z.object({
  statistics_at: z.string(),
  rows: z.array(syncRowSchema),
});

export const syncReportEnvelopeSchema = z.discriminatedUnion('status', [
  syncEnvelopeSchema.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('invalid_command_type'), value: z.string() }),
]);

// ── 部署版本分布报表 ────────────────────────────────────────────────────────

const versionRowSchema = z.object({
  version: z.string(),
  instance_count: z.number().int(),
  customers: z.array(customerRefRowSchema),
});

const versionEnvelopeSchema = z.object({
  statistics_at: z.string(),
  rows: z.array(versionRowSchema),
  unknown_version_count: z.number().int(),
});

export const versionReportEnvelopeSchema = z.discriminatedUnion('status', [
  versionEnvelopeSchema.extend({ status: z.literal('ok') }),
]);

function toCustomerRef(row: z.infer<typeof customerRefRowSchema>) {
  return { id: row.id, customerNo: row.customer_no, name: row.name };
}

function toTotals(row: z.infer<typeof totalsRowSchema>) {
  return {
    count: row.count,
    totalAmount: row.total_amount,
    settledAmount: row.settled_amount,
    outstandingAmount: row.outstanding_amount,
    overdueAmount: row.overdue_amount,
  };
}

export function toReceivableReport(
  row: z.infer<typeof receivableRowEnvelopeSchema>,
): OpsReceivableReportResponse {
  return {
    statisticsAt: row.statistics_at,
    groupBy: row.group_by as OpsReceivableReportResponse['groupBy'],
    rows: row.rows.map((entry) => ({ key: entry.key, label: entry.label, ...toTotals(entry) })),
    totals: toTotals(row.totals),
    filtersEcho: {
      customerId: row.filters_echo.customerId,
      contractId: row.filters_echo.contractId,
      status: row.filters_echo.status,
      dueFrom: row.filters_echo.dueFrom,
      dueTo: row.filters_echo.dueTo,
      groupBy: row.filters_echo.groupBy as OpsReceivableReportResponse['groupBy'],
    },
  };
}

export function toExpiringReport(
  row: z.infer<typeof expiringEnvelopeSchema>,
): OpsExpiringEntitlementReportResponse {
  return {
    statisticsAt: row.statistics_at,
    windowDays: row.window_days,
    rows: row.rows.map((entry) => ({
      subjectType:
        entry.subject_type as OpsExpiringEntitlementReportResponse['rows'][number]['subjectType'],
      id: entry.id,
      customer: toCustomerRef(entry.customer),
      product: entry.product,
      status: entry.status,
      validTo: entry.valid_to,
      daysRemaining: entry.days_remaining,
    })),
  };
}

export function toSyncReport(
  row: z.infer<typeof syncEnvelopeSchema>,
): OpsTenantSyncFailureReportResponse {
  return {
    statisticsAt: row.statistics_at,
    rows: row.rows.map((entry) => ({
      commandId: entry.command_id,
      commandNo: entry.command_no,
      mapping: { id: entry.mapping.id, mappingNo: entry.mapping.mapping_no },
      customer: toCustomerRef(entry.customer),
      commandType:
        entry.command_type as OpsTenantSyncFailureReportResponse['rows'][number]['commandType'],
      attemptCount: entry.attempt_count,
      lastErrorCategory: entry.last_error_category,
      lastErrorCode: entry.last_error_code,
      lastAttemptAt: entry.last_attempt_at,
    })),
  };
}

export function toVersionReport(
  row: z.infer<typeof versionEnvelopeSchema>,
): OpsDeploymentVersionReportResponse {
  return {
    statisticsAt: row.statistics_at,
    rows: row.rows.map((entry) => ({
      version: entry.version,
      instanceCount: entry.instance_count,
      customers: entry.customers.map(toCustomerRef),
    })),
    unknownVersionCount: row.unknown_version_count,
  };
}
