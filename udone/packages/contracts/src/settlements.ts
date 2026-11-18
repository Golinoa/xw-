import { z } from 'zod';
import { listQuerySchema } from './pagination';
import { isoDateSchema, moneySchema } from './orders';
import { paymentMethodSchema } from './finance-applications';
import { orderStatusSchema } from './orders';

/**
 * 批量结算契约（R-SETTLE-01）。
 *
 * 结算批次是**对账凭证**，不是付款流水：它回答「这家供应商这个月结多少、结了哪几笔」，
 * 真正出钱仍然走 `finance-applications` 的付款申请与审批（需求明确要求不重复生成流水）。
 * 所以这里既没有付款状态，也没有凭证地址 —— 有的话就会出现两套付款进度。
 *
 * 两条口径写在这里，避免后来者在页面里自己算：
 * 1. 每条应付明细的累计已确认结算金额不得超过应付金额（部分结算允许，超结不允许）；
 * 2. 周期是自然月，只到月，不到日。`periodMonth` 形如 `2026-11`，落库时转成当月 1 号。
 */

export const SETTLEMENT_STATUSES = ['draft', 'confirmed', 'cancelled'] as const;
export const settlementStatusSchema = z.enum(SETTLEMENT_STATUSES);
export type SettlementStatus = z.infer<typeof settlementStatusSchema>;

export const SETTLEMENT_SORT_FIELDS = ['createdAt', 'periodMonth', 'totalAmount'] as const;

/**
 * 自然月。`2026-11` 这种写作前端 `<a-month-picker>` 直接给得出，
 * 也避免了「用户传了 2026-11-15 该算哪个月」的歧义 —— 这里直接拒绝。
 */
export const settlementPeriodMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'periodMonth must look like YYYY-MM');

export const settlementBatchSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  /** 供应商名称在响应里带回：列表页与凭证都需要「结给谁」，不该让前端自己再拼。 */
  supplierName: z.string(),
  periodMonth: settlementPeriodMonthSchema,
  method: paymentMethodSchema,
  status: settlementStatusSchema,
  totalAmount: z.number(),
  itemCount: z.number().int().min(0),
  note: z.string().optional(),
  /** 作废原因；已确认批次作废时必填，是日后回答「这批结算为什么没了」的唯一依据。 */
  cancelReason: z.string().optional(),
  confirmedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SettlementBatch = z.infer<typeof settlementBatchSchema>;

export const settlementItemSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  /** 订单号是快照：订单被删后凭证仍要能读。 */
  orderNumber: z.string(),
  payableId: z.string().min(1),
  payableName: z.string(),
  amount: z.number(),
  /** 是否已被某个已确认批次锁定。作废批次后回到 false。 */
  confirmed: z.boolean(),
});
export type SettlementItem = z.infer<typeof settlementItemSchema>;

export const settlementBatchDetailSchema = settlementBatchSchema.extend({
  items: z.array(settlementItemSchema),
});
export type SettlementBatchDetail = z.infer<typeof settlementBatchDetailSchema>;

/** 提交前二次展示的待结算项：一条应付明细一行。 */
export const settlementCandidateSchema = z.object({
  payableId: z.string().min(1),
  orderId: z.string().min(1),
  orderNumber: z.string(),
  orderStatus: orderStatusSchema,
  payableName: z.string(),
  supplierId: z.string().min(1),
  /** 应付金额（含已付/在途）。 */
  payableAmount: z.number(),
  /** 已确认结算的累计金额。 */
  settledAmount: z.number(),
  /** 还能结多少 = 应付金额 − 已确认结算。为 0 的不会再出现在候选里。 */
  remainingAmount: z.number(),
});
export type SettlementCandidate = z.infer<typeof settlementCandidateSchema>;

export const settlementCandidateListQuerySchema = z.object({
  supplierId: z.string().trim().min(1).max(64),
});

/** 候选一次最多返回多少行：单供应商未结明细不该有几千条，超了说明该先结前面的月。 */
export const SETTLEMENT_CANDIDATE_LIMIT = 500;

export const settlementCandidateListResponseSchema = z.object({
  items: z.array(settlementCandidateSchema),
});

export const settlementListQuerySchema = listQuerySchema(SETTLEMENT_SORT_FIELDS).extend({
  supplierId: z.string().trim().min(1).max(64).optional(),
  status: settlementStatusSchema.optional(),
  periodMonth: settlementPeriodMonthSchema.optional(),
});
export type SettlementListQuery = z.infer<typeof settlementListQuerySchema>;

export const settlementListResponseSchema = z.object({
  items: z.array(settlementBatchSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

export const settlementParamsSchema = z.object({
  batchId: z.string().min(1).max(64),
});

export const settlementBatchResponseSchema = z.object({ settlement: settlementBatchSchema });
export const settlementBatchDetailResponseSchema = z.object({
  settlement: settlementBatchDetailSchema,
});

/**
 * 创建草稿批次。
 *
 * 明细一次给全，不做「先建空批次再逐条加」：后者在进程被回收时会留下
 * 「有批次没明细」的半截数据，而批次总额恰恰是明细之和。
 */
export const createSettlementRequestSchema = z.object({
  supplierId: z.string().trim().min(1).max(64),
  periodMonth: settlementPeriodMonthSchema,
  method: paymentMethodSchema,
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        payableId: z.string().trim().min(1).max(64),
        amount: moneySchema.refine((value) => value > 0, {
          message: 'amount must be greater than zero',
        }),
      }),
    )
    .min(1, 'at least one item is required'),
});
export type CreateSettlementRequest = z.infer<typeof createSettlementRequestSchema>;

/** 作废。已确认批次必须写原因（库函数同样校验，这里只是提前拦一次）。 */
export const cancelSettlementRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelSettlementRequest = z.infer<typeof cancelSettlementRequestSchema>;

export const settlementTransitionResponseSchema = z.object({
  settlementId: z.string().min(1),
  status: settlementStatusSchema,
  totalAmount: z.number(),
});

/** 把 `2026-11` 变成落库用的当月 1 号。日期由服务层统一算，页面不自己拼日期。 */
export function settlementPeriodStart(periodMonth: string): string {
  return `${periodMonth}-01`;
}

/** 反过来：`2026-11-01` → `2026-11`。库里可能出现非 1 号的脏数据时也能读。 */
export function settlementPeriodMonthOf(periodStart: string): string {
  return periodStart.slice(0, 7);
}

/** 依据 ISO 日期字符串判断是不是当月 1 号，供 pgTAP 之外的调用方复用。 */
export const settlementPeriodStartSchema = isoDateSchema;
