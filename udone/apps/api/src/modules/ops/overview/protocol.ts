import {
  OPS_OVERVIEW_METRICS,
  OPS_OVERVIEW_RESTRICTED_SECTIONS,
  z,
  type OpsOverviewAmount,
  type OpsOverviewPartialFailure,
  type OpsOverviewResponse,
  type OpsOverviewRestricted,
} from '@erp/contracts';

/**
 * overview 域的出站翻译层（契约 §5.9）。
 *
 * SQL 说的是列名（snake_case），API 说的是 JS（camelCase），转换只在这里发生一次
 * ——与其余十个域同一条规矩。这张表也是唯一需要跟着 SQL 改的地方：多一个指标，
 * 这里就多一行，漏一行会被 typecheck 与出站 zod 同时抓到。
 *
 * 两个细节值得写下来：
 *
 * 1. **`restricted_metrics[]` 里的名字也要翻译。** 它是「哪些指标没算」，
 *    前端拿它去比对自己的字段名（camelCase）。只翻译 `metrics` 的键、不翻译
 *    这个数组，得到的效果是「有个指标叫 active_customers 被限制了」，而前端
 *    永远匹配不上——页面会安静地少一格，不报错。
 * 2. **缺席的指标不许补 0。** SQL 里没权限的指标连键都不出现；这里用
 *    `.optional()` 接住，转出去之后仍然是「没有这个键」。补 0 就等于把
 *    `restrictedMetrics` 的意义抹掉：`0` 与「无权」在界面上长得一样。
 */

const metricsRowSchema = z.object({
  active_customers: z.number().int().optional(),
  active_contracts: z.number().int().optional(),
  running_tenants: z.number().int().optional(),
  active_entitlements: z.number().int().optional(),
  expiring_entitlements: z.number().int().optional(),
  open_tickets: z.number().int().optional(),
  waiting_tickets: z.number().int().optional(),
  failed_sync_commands: z.number().int().optional(),
  pending_receipt_amount: z.number().optional(),
  unreconciled_amount: z.number().optional(),
});

const amountRowSchema = z.object({
  currency: z.string(),
  total_receivable: z.number(),
  settled_receivable: z.number(),
  overdue_receivable: z.number(),
  upcoming_receivable: z.number(),
});

const partialFailureRowSchema = z.object({
  code: z.string(),
  message: z.string(),
  section: z.string().optional(),
});

const overviewRowSchema = z.object({
  statistics_at: z.string(),
  window_days: z.number().int(),
  metrics: metricsRowSchema,
  amounts: z.array(amountRowSchema),
  restricted_metrics: z.array(z.string()),
  partial_failures: z.array(partialFailureRowSchema),
});

export const overviewEnvelopeSchema = z.discriminatedUnion('status', [
  overviewRowSchema.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('invalid_window'), value: z.number().int() }),
]);

export type OpsOverviewEnvelope = z.infer<typeof overviewEnvelopeSchema>;

/** snake_case 指标名 → camelCase 指标名。缺席的名字原样保留，便于排障。 */
const METRIC_NAMES: Record<string, OpsOverviewRestricted> = {
  active_customers: 'activeCustomers',
  active_contracts: 'activeContracts',
  running_tenants: 'runningTenants',
  active_entitlements: 'activeEntitlements',
  expiring_entitlements: 'expiringEntitlements',
  open_tickets: 'openTickets',
  waiting_tickets: 'waitingTickets',
  failed_sync_commands: 'failedSyncCommands',
  pending_receipt_amount: 'pendingReceiptAmount',
  unreconciled_amount: 'unreconciledAmount',
  // 金额区是「区块」不是「指标」，但在同一个数组里传：两者都是「因为没权限而
  // 缺席」，前端只需要一条提示逻辑。名字两边一致（`amounts`），不做改写在
  // 这里反而更清楚。
  amounts: 'amounts',
};

/**
 * `restricted_metrics[]` 的翻译。
 *
 * 未登记的名字**丢掉**而不是 503：这个数组是「哪些指标没算」，其中出现一个
 * 契约包不认识的名字，说明 SQL 那边先改了、契约包没跟上——此时把整份总览
 * 打成 503 会让运营连「看得到的部分」都看不到，代价远大于收益。
 *
 * 但静默丢弃也不能成为常态，所以留了一道对账（见文件末尾两个常量）：
 * `METRIC_NAMES` 与契约包的 `OPS_OVERVIEW_METRICS` 数量必须相等，由单测断言。
 * 也就是说，多一个指标会在 CI 里红，而不是在这里静默消失。
 */
function toMetricNames(names: string[]): OpsOverviewRestricted[] {
  const known: OpsOverviewRestricted[] = [];
  for (const name of names) {
    const mapped = METRIC_NAMES[name];
    if (mapped) known.push(mapped);
  }
  return known;
}

function toAmount(row: z.infer<typeof amountRowSchema>): OpsOverviewAmount {
  return {
    currency: row.currency,
    totalReceivable: row.total_receivable,
    settledReceivable: row.settled_receivable,
    overdueReceivable: row.overdue_receivable,
    upcomingReceivable: row.upcoming_receivable,
  };
}

function toPartialFailure(row: z.infer<typeof partialFailureRowSchema>): OpsOverviewPartialFailure {
  return {
    code: row.code,
    message: row.message,
    ...(row.section === 'metrics' || row.section === 'amounts' ? { section: row.section } : {}),
  };
}

export function toOverview(row: z.infer<typeof overviewRowSchema>): OpsOverviewResponse {
  return {
    statisticsAt: row.statistics_at,
    windowDays: row.window_days,
    metrics: {
      // 逐个显式翻译而不是 `Object.entries` 循环：循环会把 `undefined` 也写成
      // 键（`{activeCustomers: undefined}`），出站 zod 的 `.optional()` 收下它，
      // 序列化时又被 JSON 丢掉——「看不见的键」在排障时最难查。
      ...(row.metrics.active_customers === undefined
        ? {}
        : { activeCustomers: row.metrics.active_customers }),
      ...(row.metrics.active_contracts === undefined
        ? {}
        : { activeContracts: row.metrics.active_contracts }),
      ...(row.metrics.running_tenants === undefined
        ? {}
        : { runningTenants: row.metrics.running_tenants }),
      ...(row.metrics.active_entitlements === undefined
        ? {}
        : { activeEntitlements: row.metrics.active_entitlements }),
      ...(row.metrics.expiring_entitlements === undefined
        ? {}
        : { expiringEntitlements: row.metrics.expiring_entitlements }),
      ...(row.metrics.open_tickets === undefined ? {} : { openTickets: row.metrics.open_tickets }),
      ...(row.metrics.waiting_tickets === undefined
        ? {}
        : { waitingTickets: row.metrics.waiting_tickets }),
      ...(row.metrics.failed_sync_commands === undefined
        ? {}
        : { failedSyncCommands: row.metrics.failed_sync_commands }),
      ...(row.metrics.pending_receipt_amount === undefined
        ? {}
        : { pendingReceiptAmount: row.metrics.pending_receipt_amount }),
      ...(row.metrics.unreconciled_amount === undefined
        ? {}
        : { unreconciledAmount: row.metrics.unreconciled_amount }),
    },
    amounts: row.amounts.map(toAmount),
    restrictedMetrics: toMetricNames(row.restricted_metrics),
    partialFailures: row.partial_failures.map(toPartialFailure),
  };
}

/**
 * 指标名清单的对账用。
 *
 * `METRIC_NAMES` 里除指标之外还装着 `amounts`（那个「因为没权限而整块缺席」的
 * 区块），所以先把它减掉再与契约包比数量。多一个指标、少一个指标都会在这里
 * 被单测抓到——这是「翻译表可以静默丢名字」的唯一保险。
 */
export const OVERVIEW_METRIC_COUNT =
  Object.keys(METRIC_NAMES).length - OPS_OVERVIEW_RESTRICTED_SECTIONS.length;
export const OVERVIEW_METRIC_CONTRACT_COUNT = OPS_OVERVIEW_METRICS.length;
