import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';
import { orderStatusSchema } from './orders';

/**
 * 财务项目与订单财务契约（R-FIN-01、R-ORDER-03、REQUIREMENTS.md §7）。
 *
 * 计算口径统一取自唯一真源第 4 节，任何一处改动必须同步这一节，不允许各页面自算：
 * - 利润 = 应收合计 − 应付合计
 * - 毛利率 = 利润 ÷ 应收合计
 * - 客单价 = 应收合计 ÷ 人数
 * - 收款进度 = 已收 ÷ 应收合计；付款进度 = 已付 ÷ 应付合计
 * - 净现金流 = 已收 − 已付
 *
 * 比率一律用**比值**（0.36）而不是百分数（36），只在展示层乘 100。
 * 比值在分母为 0 时没有意义，返回 `null` 而不是 0——0 会被读成「毛利率为零」，
 * 而实际含义是「还没有应收，算不出来」。
 */

/** 比率保留 4 位小数：0.3636 足以表达百分数的一位小数。 */
function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 金额保留 2 位小数，与 `numeric(14,2)` 对齐。 */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 金额行汇总的输入。应收与应付两侧结构相同，只有「已收/已付」的业务叫法不同，
 * 因此用同一组纯函数计算，避免两边各写一套除法再慢慢漂移。
 */
export interface AmountLines {
  amount: number;
  confirmedAmount: number;
  pendingAmount: number;
}

export interface AmountSummary {
  total: number;
  confirmed: number;
  pending: number;
  /** 尚未确认的金额，含在途。收款进度、对账口径用它。 */
  outstanding: number;
  /** 可再申请的余额，已扣除在途。发起申请前的额度校验用它。 */
  applicable: number;
}

/**
 * 汇总一侧金额。`total` 取明细之和而不是订单表上的合计列：
 * 明细是真源，订单合计只是它的缓存；两者不一致时以明细为准，
 * 由 `recalculate_order_totals()` 负责把缓存修回去。
 */
export function summarizeAmountLines(lines: readonly AmountLines[]): AmountSummary {
  let total = 0;
  let confirmed = 0;
  let pending = 0;
  for (const line of lines) {
    total += line.amount;
    confirmed += line.confirmedAmount;
    pending += line.pendingAmount;
  }
  return {
    total: roundMoney(total),
    confirmed: roundMoney(confirmed),
    pending: roundMoney(pending),
    outstanding: roundMoney(total - confirmed),
    applicable: roundMoney(total - confirmed - pending),
  };
}

export const orderFinanceSummarySchema = z.object({
  orderId: z.string().min(1),
  orderNumber: z.string(),
  status: orderStatusSchema,
  personCount: z.number().int().min(0),
  /** 应收侧。 */
  receivableTotal: z.number(),
  confirmedReceivable: z.number(),
  pendingReceivable: z.number(),
  /** 未收 = 应收合计 − 已收（含在途）。 */
  uncollectedAmount: z.number(),
  /** 可再申请的应收余额（已扣在途）。 */
  applicableReceivable: z.number(),
  /** 应付侧，字段与应收侧一一对应。 */
  payableTotal: z.number(),
  confirmedPayable: z.number(),
  pendingPayable: z.number(),
  unpaidAmount: z.number(),
  applicablePayable: z.number(),
  profit: z.number(),
  /** 利润 ÷ 应收合计；应收为 0 时为 null。亏损为负数。 */
  grossMargin: z.number().nullable(),
  /** 应收合计 ÷ 人数；人数为 0 时为 null。 */
  revenuePerPerson: z.number().nullable(),
  /** 已收 ÷ 应收合计；应收为 0 时为 null。 */
  collectionProgress: z.number().nullable(),
  /** 已付 ÷ 应付合计；应付为 0 时为 null。 */
  paymentProgress: z.number().nullable(),
  /** 已收 − 已付。 */
  netCashflow: z.number(),
});
export type OrderFinanceSummary = z.infer<typeof orderFinanceSummarySchema>;

/**
 * 计算订单财务摘要。纯函数，不碰数据库，便于用真源第 21 节的验收数据直接断言。
 *
 * 刻意不接收订单表上的 `receivableTotal`/`payableTotal`：如果让调用方把缓存值传进来，
 * 迟早会出现「明细改了、合计没重算」时端点返回旧数字的情况。
 */
export function summarizeOrderFinance(input: {
  orderId: string;
  orderNumber: string;
  status: z.infer<typeof orderStatusSchema>;
  personCount: number;
  receivables: readonly AmountLines[];
  payables: readonly AmountLines[];
}): OrderFinanceSummary {
  const receivable = summarizeAmountLines(input.receivables);
  const payable = summarizeAmountLines(input.payables);
  const profit = roundMoney(receivable.total - payable.total);
  const personCount = Math.max(0, input.personCount);

  return {
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    status: input.status,
    personCount,
    receivableTotal: receivable.total,
    confirmedReceivable: receivable.confirmed,
    pendingReceivable: receivable.pending,
    uncollectedAmount: receivable.outstanding,
    applicableReceivable: receivable.applicable,
    payableTotal: payable.total,
    confirmedPayable: payable.confirmed,
    pendingPayable: payable.pending,
    unpaidAmount: payable.outstanding,
    applicablePayable: payable.applicable,
    profit,
    grossMargin: receivable.total > 0 ? roundRatio(profit / receivable.total) : null,
    revenuePerPerson: personCount > 0 ? roundMoney(receivable.total / personCount) : null,
    collectionProgress:
      receivable.total > 0 ? roundRatio(receivable.confirmed / receivable.total) : null,
    paymentProgress: payable.total > 0 ? roundRatio(payable.confirmed / payable.total) : null,
    netCashflow: roundMoney(receivable.confirmed - payable.confirmed),
  };
}

export const orderFinanceResponseSchema = z.object({ finance: orderFinanceSummarySchema });
export type OrderFinanceResponse = z.infer<typeof orderFinanceResponseSchema>;

/**
 * 明细列表排序白名单。只能排明细自己的列：按订单号排序需要跨表，PostgREST 做不到，
 * 与其在前端假装支持再报错，不如直接不接受。
 */
export const FINANCE_SORT_FIELDS = ['createdAt', 'amount', 'availableAmount'] as const;

/** 只看仍有余额的项目（`true`）或只看已结清的项目（`false`）。 */
export const outstandingSchema = z.enum(['true', 'false']);
export type OutstandingFilter = z.infer<typeof outstandingSchema>;

export const financeListQuerySchema = listQuerySchema(FINANCE_SORT_FIELDS).extend({
  orderId: z.string().min(1).max(64).optional(),
  /** 匹配项目名称或订单号。 */
  keyword: z.string().trim().max(100).optional(),
  outstanding: outstandingSchema.optional(),
});
export type FinanceListQuery = z.infer<typeof financeListQuerySchema>;

/** 应付侧多一个供应商维度：结算按供应商汇总（R-SETTLE-01）。 */
export const payableListQuerySchema = financeListQuerySchema.extend({
  supplierId: z.string().min(1).max(64).optional(),
});
export type PayableListQuery = z.infer<typeof payableListQuerySchema>;

export const receivableItemSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  orderNumber: z.string(),
  /** 父订单在调用方数据范围之外时为 null（正常路径不会出现，仅作权限边界兜底）。 */
  orderStatus: orderStatusSchema.nullable(),
  customerName: z.string(),
  /** 项目名称是下单时的快照，不随客户或供应商主数据改名而漂移（R-FIN-01）。 */
  name: z.string(),
  amount: z.number(),
  confirmedAmount: z.number(),
  pendingAmount: z.number(),
  availableAmount: z.number(),
  createdAt: z.string(),
});
export type ReceivableItem = z.infer<typeof receivableItemSchema>;

export const payableItemSchema = receivableItemSchema.extend({
  supplierId: z.string().min(1),
  /** 供应商当前名称，仅用于展示；历史归属以 `supplierId` 为准。 */
  supplierName: z.string(),
  settlement: z.enum(['monthly', 'per_trip']),
});
export type PayableItem = z.infer<typeof payableItemSchema>;

export const receivableListResponseSchema = pagedResponseSchema(receivableItemSchema);
export const payableListResponseSchema = pagedResponseSchema(payableItemSchema);
export type ReceivableListResponse = z.infer<typeof receivableListResponseSchema>;
export type PayableListResponse = z.infer<typeof payableListResponseSchema>;
