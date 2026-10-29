import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';

/**
 * 订单契约（R-ORDER-01/02/03、REQUIREMENTS.md §17）。
 *
 * 三条不可动摇的规则，写在这里而不是散落到 handler：
 * 1. 金额是 `numeric(14,2)` 语义，最多两位小数；服务端一律重算合计与利润，
 *    绝不采信前端传来的总计。
 * 2. `orderType`（正式/预订单）与 `status`（业务状态）是两个维度，不要合并：
 *    预订单确认出团后类型变 `active`，取消后状态变 `cancelled`，但类型保留。
 * 3. 状态只能通过具名动作迁移，不提供「直接改 status」的入口，否则非法跳转
 *    迟早从某个表单里漏进来。
 */

export const ORDER_TYPES = ['active', 'booking'] as const;
export const orderTypeSchema = z.enum(ORDER_TYPES);
export type OrderType = z.infer<typeof orderTypeSchema>;

export const ORDER_STATUSES = ['booking', 'active', 'completed', 'cancelled'] as const;
export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const ORDER_ACTIONS = ['confirm', 'revert', 'lock', 'unlock', 'cancel', 'restore'] as const;
export const orderActionSchema = z.enum(ORDER_ACTIONS);
export type OrderAction = z.infer<typeof orderActionSchema>;

export const ORDER_SORT_FIELDS = ['createdAt', 'departureDate', 'orderNumber'] as const;

/** `numeric(14,2)`：12 位整数、2 位小数。 */
const MAX_MONEY = 999_999_999_999.99;

/**
 * 金额必须精确到分。用容差而不是 `multipleOf(0.01)`，因为后者在二进制浮点下
 * 会把 `0.07` 判成非法。
 */
export const moneySchema = z
  .number()
  .min(0)
  .max(MAX_MONEY)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: 'amount must not have more than two decimal places',
  });

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be an ISO date (YYYY-MM-DD)');

/** 应收行：只有名称与金额。 */
export const receivableLineInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  amount: moneySchema,
});
export type ReceivableLineInput = z.infer<typeof receivableLineInputSchema>;

/** 应付行必须指明供应商，否则无法进入结算与月结筛选（R-ORDER-01）。 */
export const payableLineInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  amount: moneySchema,
  supplierId: z.string().min(1).max(64),
});
export type PayableLineInput = z.infer<typeof payableLineInputSchema>;

const orderFieldsShape = {
  customerId: z.string().min(1).max(64),
  orderType: orderTypeSchema,
  routeName: z.string().trim().max(100).nullable().optional(),
  departureDate: isoDateSchema.nullable().optional(),
  returnDate: isoDateSchema.nullable().optional(),
  adultCount: z.number().int().min(0).max(999),
  childCount: z.number().int().min(0).max(999),
  remark: z.string().max(2000).nullable().optional(),
};

/** 回团日期不得早于出团日期；两者都缺省时不做限制。 */
function dateOrderValid(value: { departureDate?: string | null; returnDate?: string | null }) {
  if (!value.departureDate || !value.returnDate) return true;
  return value.returnDate >= value.departureDate;
}

const dateOrderIssue = {
  message: 'returnDate must not be earlier than departureDate',
  path: ['returnDate'],
};

export const createOrderRequestSchema = z
  .object({
    ...orderFieldsShape,
    receivables: z.array(receivableLineInputSchema).max(50),
    payables: z.array(payableLineInputSchema).max(50),
  })
  .refine(dateOrderValid, dateOrderIssue);

/**
 * 更新订单：金额行整体替换。
 *
 * 不提供「按行增量合并」——金额行的增删改在业务上是一次完整的重新定价，
 * 增量合并会让「删掉一行」和「把金额改成 0」变得无法区分。
 */
export const updateOrderRequestSchema = z
  .object({
    ...orderFieldsShape,
    receivables: z.array(receivableLineInputSchema).max(50),
    payables: z.array(payableLineInputSchema).max(50),
    version: z.number().int().min(1),
  })
  .refine(dateOrderValid, dateOrderIssue);

export const transitionOrderRequestSchema = z
  .object({
    action: orderActionSchema,
    /** 锁团/解锁必须说明原因，取消同样建议填写；具体必填性由服务端按动作判定。 */
    reason: z.string().trim().max(500).optional(),
    version: z.number().int().min(1),
  })
  .refine(
    (value) =>
      !['lock', 'unlock', 'cancel'].includes(value.action) || Boolean(value.reason?.length),
    { message: 'a reason is required for this action', path: ['reason'] },
  );

export const orderListQuerySchema = listQuerySchema(ORDER_SORT_FIELDS).extend({
  keyword: z.string().trim().max(100).optional(),
  status: orderStatusSchema.optional(),
  orderType: orderTypeSchema.optional(),
  customerId: z.string().min(1).max(64).optional(),
  departureFrom: isoDateSchema.optional(),
  departureTo: isoDateSchema.optional(),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderParamsSchema = z.object({
  orderId: z.string().min(1).max(64),
});

export const orderReceivableSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  amount: z.number(),
  confirmedAmount: z.number(),
  pendingAmount: z.number(),
  /** 剩余可申请金额，由服务端计算，前端不要自己相减。 */
  availableAmount: z.number(),
});
export type OrderReceivable = z.infer<typeof orderReceivableSchema>;

export const orderPayableSchema = orderReceivableSchema.extend({
  supplierId: z.string().min(1),
  supplierName: z.string(),
});
export type OrderPayable = z.infer<typeof orderPayableSchema>;

export const orderListItemSchema = z.object({
  id: z.string().min(1),
  orderNumber: z.string(),
  customerId: z.string().min(1),
  customerName: z.string(),
  orderType: orderTypeSchema,
  status: orderStatusSchema,
  routeName: z.string().optional(),
  departureDate: z.string().optional(),
  returnDate: z.string().optional(),
  adultCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
  personCount: z.number().int().min(0),
  receivableTotal: z.number(),
  payableTotal: z.number(),
  profit: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderListItem = z.infer<typeof orderListItemSchema>;

export const orderDetailSchema = orderListItemSchema.extend({
  /** 取消前的业务状态。没有它，界面上无法说明「恢复」会回到哪个状态。 */
  previousStatus: orderStatusSchema.optional(),
  remark: z.string().optional(),
  /** 锁团原因，解锁后保留最后一次说明，便于追溯。 */
  statusReason: z.string().optional(),
  receivables: z.array(orderReceivableSchema),
  payables: z.array(orderPayableSchema),
  version: z.number().int().min(1),
});
export type OrderDetail = z.infer<typeof orderDetailSchema>;

export const orderListResponseSchema = pagedResponseSchema(orderListItemSchema);
export const orderResponseSchema = z.object({ order: orderDetailSchema });

export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;
export type UpdateOrderRequest = z.infer<typeof updateOrderRequestSchema>;
export type TransitionOrderRequest = z.infer<typeof transitionOrderRequestSchema>;
export type OrderListResponse = z.infer<typeof orderListResponseSchema>;
export type OrderResponse = z.infer<typeof orderResponseSchema>;
