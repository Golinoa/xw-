import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';
import {
  opsBillingAllocationSchema,
  opsBillingReversalSchema,
  opsOperatorRefSchema,
} from './billing-shared';
import { opsReceivableCustomerSchema, opsReceivableSchema } from './receivables';

/**
 * billing 域（契约 §3.4 / §5.5 的**后十个**端点：收款、核销、退款）。
 *
 * 与前半（应收计划与展期）分成两个文件，不是因为端点多，而是因为这里的守卫
 * 是另一种东西：前半守的是「计划合计 = 合同金额」，后半守的是「同一笔钱不能
 * 被核销两次、同一期不能被超额核销、退款不能超过已核销净额」——这些都要在
 * 一个事务里锁行才成立，前端拿到的每个余额字段都是那一刻的快照。
 *
 * 三处口径写在这里、不散到路由里：
 *
 * 1. **金额一律 JSON number，服务端算好余额。** `allocatedAmount` /
 *    `refundableAmount` / `outstanding` 都是派生值，前端不做加减。
 * 2. **状态是封闭枚举。** 收款五态、退款三态，多一个值就意味着后端多一条边，
 *    前端按 switch 渲染按钮时会掉进 default 分支。
 * 3. **`method` 是对象不是字符串。** 契约 §5.5 的列表项写的是 `method`，
 *    查询参数才是 `methodCode`。字典还没落地（U-19），label 先回落成 code。
 */

/** 收款状态（契约 §3.4 的状态机，五态全部可达）。 */
export const OPS_RECEIPT_STATUSES = [
  'recorded',
  'pending_reconcile',
  'reconciled',
  'reversed',
  'refunded',
] as const;
export const opsReceiptStatusSchema = z.enum(OPS_RECEIPT_STATUSES);
export type OpsReceiptStatus = z.infer<typeof opsReceiptStatusSchema>;

/**
 * 退款状态。
 *
 * 只有三态：登记、审核通过、取消。契约没有给退款定义 `reversed`——退款本身
 * 就是反向动作，取消它用的是 `cancel`，不是再退一次。
 */
export const OPS_REFUND_STATUSES = ['recorded', 'approved', 'cancelled'] as const;
export const opsRefundStatusSchema = z.enum(OPS_REFUND_STATUSES);
export type OpsRefundStatus = z.infer<typeof opsRefundStatusSchema>;

/** 收款审核的两个动作。核销与冲正各有独立端点，不在这个枚举里。 */
export const OPS_RECEIPT_TRANSITION_ACTIONS = ['approve', 'reject'] as const;
export const opsReceiptTransitionActionSchema = z.enum(OPS_RECEIPT_TRANSITION_ACTIONS);
export type OpsReceiptTransitionAction = z.infer<typeof opsReceiptTransitionActionSchema>;

/** 退款的裁决动作。 */
export const OPS_REFUND_TRANSITION_ACTIONS = ['approve', 'cancel'] as const;
export const opsRefundTransitionActionSchema = z.enum(OPS_REFUND_TRANSITION_ACTIONS);
export type OpsRefundTransitionAction = z.infer<typeof opsRefundTransitionActionSchema>;

/** 收款方式。`label` 当前等于 `code`（字典未落地），字典落地后只服务端改。 */
export const opsReceiptMethodSchema = z.object({
  code: z.string(),
  label: z.string(),
});
export type OpsReceiptMethod = z.infer<typeof opsReceiptMethodSchema>;

/**
 * 单笔收款。列表项与详情里的 `receipt` 同形——两处不一致时「列表能看、详情
 * 打不开」只会出现在类型之外。
 *
 * `refundableAmount` 是契约 §5.5 列表项之外新增的一列：退款入口要显示「还能退
 * 多少」，不给这个数，前端只能自己拿 `allocatedAmount` 减退款合计，而那正是
 * 服务端已经算过一遍的东西（在途的退款是否计入，前端算不准）。已登记 C-112。
 */
export const opsReceiptSchema = z.object({
  id: z.uuid(),
  receiptNo: z.string(),
  customerId: z.uuid(),
  customer: opsReceivableCustomerSchema,
  contractId: z.uuid().nullable(),
  contractNo: z.string().nullable(),
  transactionDate: z.iso.date(),
  amount: z.number(),
  currency: z.string().length(3),
  method: opsReceiptMethodSchema,
  referenceNo: z.string().nullable(),
  voucherRef: z.string().nullable(),
  status: opsReceiptStatusSchema,
  /** 已核销净额（分配合计 − 撤销合计）。 */
  allocatedAmount: z.number(),
  /** 还能退多少 = 已核销净额 − 未取消的退款合计。 */
  refundableAmount: z.number(),
  recordedBy: opsOperatorRefSchema.nullable(),
  approvedBy: opsOperatorRefSchema.nullable(),
  approvedAt: z.string().nullable(),
  recordedReason: z.string(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OpsReceipt = z.infer<typeof opsReceiptSchema>;

/** 一笔退款。`reason` 必填：没有原因的退款在对账时等于没有解释。 */
export const opsRefundSchema = z.object({
  id: z.uuid(),
  refundNo: z.string(),
  receiptId: z.uuid(),
  receiptNo: z.string(),
  contractId: z.uuid().nullable(),
  customerId: z.uuid(),
  customer: opsReceivableCustomerSchema,
  amount: z.number(),
  currency: z.string().length(3),
  refundDate: z.iso.date(),
  reason: z.string(),
  externalVoucherRef: z.string().nullable(),
  status: opsRefundStatusSchema,
  handledBy: opsOperatorRefSchema.nullable(),
  approvedBy: opsOperatorRefSchema.nullable(),
  approvedAt: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OpsRefund = z.infer<typeof opsRefundSchema>;

/** 明细里撤销一条核销后的返回：分配的新余额 + 那一期的新余额。 */
export const opsReceiptAllocationReverseResponseSchema = z.object({
  allocation: z.object({
    id: z.uuid(),
    amount: z.number(),
    reversedAmount: z.number(),
  }),
  receivable: opsReceivableSchema,
  receipt: opsReceiptSchema,
});
export type OpsReceiptAllocationReverseResponse = z.infer<
  typeof opsReceiptAllocationReverseResponseSchema
>;

// ── 列表查询 ─────────────────────────────────────────────────────────────────

/**
 * 收款列表查询。
 *
 * `status` 是数组（契约 §5.5 的 `status[]`）：`status=recorded&status=reconciled`
 * 两个都要能同时筛。
 */
export const opsReceiptListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  contractId: z.uuid().optional(),
  status: z.array(opsReceiptStatusSchema).optional(),
  methodCode: z.string().trim().min(1).max(60).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsReceiptListQuery = z.infer<typeof opsReceiptListQuerySchema>;

export const opsRefundListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsRefundStatusSchema).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsRefundListQuery = z.infer<typeof opsRefundListQuerySchema>;

// ── 入站请求 ─────────────────────────────────────────────────────────────────

/**
 * 登记收款（契约 §5.5 `POST /receipts`）。
 *
 * `currency` 是必填而不是默认 CNY：默认值会让「美元合同收了一笔没写币种的钱」
 * 悄悄记成人民币，而复合外键这时才发现两边不一致。
 *
 * `reason` 不在契约那张表的关键字段里，但契约 §6.1 把「收款登记」列进
 * **必填 reason** 的高风险动作，所以它是必填的——两处一起读才不会漏。
 */
export const opsReceiptCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  contractId: z.uuid().optional(),
  transactionDate: z.iso.date(),
  amount: z.number().positive(),
  currency: z.string().trim().length(3),
  methodCode: z.string().trim().min(1).max(60),
  referenceNo: z.string().trim().max(120).optional(),
  voucherRef: z.string().trim().max(200).optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsReceiptCreateRequest = z.infer<typeof opsReceiptCreateRequestSchema>;

/**
 * 审核 / 驳回。
 *
 * `version` 必填：两个人同时审同一笔，后到的必须看见冲突。驳回时 `reason`
 * 也是必填——「为什么退回」是这张单子唯一的书面解释。
 */
export const opsReceiptTransitionRequestSchema = z.strictObject({
  action: opsReceiptTransitionActionSchema,
  reason: z.string().trim().min(1).max(500).optional(),
  version: z.number().int().min(1),
});
export type OpsReceiptTransitionRequest = z.infer<typeof opsReceiptTransitionRequestSchema>;

/**
 * 核销（契约 §5.5 `POST /receipts/{id}/allocations`）。
 *
 * 一次可以核销到多期：一笔款抵两期是常态。`amount` 不设上限校验——上限是
 * 「收款可分配额」和「该期余额」两个动态值，只有服务端在锁行之后才算得准；
 * 在 schema 上写死一个数字只会让前端误以为它是真上限。
 */
export const opsReceiptAllocationCreateRequestSchema = z.strictObject({
  allocations: z
    .array(
      z.strictObject({
        receivableId: z.uuid(),
        amount: z.number().positive(),
      }),
    )
    .min(1),
  reason: z.string().trim().max(500).optional(),
});
export type OpsReceiptAllocationCreateRequest = z.infer<
  typeof opsReceiptAllocationCreateRequestSchema
>;

/** 冲正收款。`reason` 必填（契约 §3.4：「需 reason」）。 */
export const opsReceiptReverseRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
});
export type OpsReceiptReverseRequest = z.infer<typeof opsReceiptReverseRequestSchema>;

/**
 * 撤销核销。`amount` 可选：不传 = 全额撤销那条分配。
 *
 * 传了就按传的算，所以部分撤销不需要改原分配行——撤销是另一条流水。
 */
export const opsReceiptAllocationReverseRequestSchema = z.strictObject({
  amount: z.number().positive().optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsReceiptAllocationReverseRequest = z.infer<
  typeof opsReceiptAllocationReverseRequestSchema
>;

/**
 * 登记退款（契约 §5.5 `POST /refunds`）。
 *
 * 不收 `currency` / `customerId`：两者都从原收款继承。让调用方传，等于允许
 * 「给一笔人民币收款退美元」，而退款表的币种列没有任何东西能挡住它。
 */
export const opsRefundCreateRequestSchema = z.strictObject({
  receiptId: z.uuid(),
  contractId: z.uuid().optional(),
  amount: z.number().positive(),
  refundDate: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
  externalVoucherRef: z.string().trim().max(200).optional(),
});
export type OpsRefundCreateRequest = z.infer<typeof opsRefundCreateRequestSchema>;

/** 退款裁决。`reason` 必填：取消一笔退款也需要书面解释。 */
export const opsRefundTransitionRequestSchema = z.strictObject({
  action: opsRefundTransitionActionSchema,
  reason: z.string().trim().min(1).max(500),
});
export type OpsRefundTransitionRequest = z.infer<typeof opsRefundTransitionRequestSchema>;

// ── 出站响应 ─────────────────────────────────────────────────────────────────

/**
 * 重复流水号提示。契约 §5.5 要求 `POST /receipts` 回 `duplicateWarnings[]`，
 * 而同一张表的「关键错误」又列了 409——两者不是同一件事：
 * 完全重复（同客户 + 同流水号 + 同金额 + 同日期）回 409，仅流水号相同回 201
 * 加这个数组。银行流水号在不同批次之间会重号。
 */
export const opsReceiptDuplicateWarningSchema = z.object({
  receiptId: z.uuid(),
  receiptNo: z.string(),
  transactionDate: z.iso.date(),
  amount: z.number(),
  status: opsReceiptStatusSchema,
});
export type OpsReceiptDuplicateWarning = z.infer<typeof opsReceiptDuplicateWarningSchema>;

export const opsReceiptListResponseSchema = pagedResponseSchema(opsReceiptSchema);
export type OpsReceiptListResponse = z.infer<typeof opsReceiptListResponseSchema>;

export const opsReceiptCreateResponseSchema = z.object({
  receipt: opsReceiptSchema,
  duplicateWarnings: z.array(opsReceiptDuplicateWarningSchema),
});
export type OpsReceiptCreateResponse = z.infer<typeof opsReceiptCreateResponseSchema>;

export const opsReceiptDetailResponseSchema = z.object({
  receipt: opsReceiptSchema,
  allocations: z.array(opsBillingAllocationSchema),
  reversals: z.array(opsBillingReversalSchema),
  refunds: z.array(opsRefundSchema),
});
export type OpsReceiptDetailResponse = z.infer<typeof opsReceiptDetailResponseSchema>;

export const opsReceiptTransitionResponseSchema = z.object({
  receipt: opsReceiptSchema,
});
export type OpsReceiptTransitionResponse = z.infer<typeof opsReceiptTransitionResponseSchema>;

/** 核销返回：收款的新余额 + 被核销那几期的新余额。 */
export const opsReceiptAllocationCreateResponseSchema = z.object({
  receipt: opsReceiptSchema,
  receivablesSummary: z.array(opsReceivableSchema),
});
export type OpsReceiptAllocationCreateResponse = z.infer<
  typeof opsReceiptAllocationCreateResponseSchema
>;

export const opsReceiptReverseResponseSchema = z.object({
  receipt: opsReceiptSchema,
  reversal: z.object({ amount: z.number() }),
});
export type OpsReceiptReverseResponse = z.infer<typeof opsReceiptReverseResponseSchema>;

export const opsRefundListResponseSchema = pagedResponseSchema(opsRefundSchema);
export type OpsRefundListResponse = z.infer<typeof opsRefundListResponseSchema>;

export const opsRefundCreateResponseSchema = z.object({
  refund: opsRefundSchema,
});
export type OpsRefundCreateResponse = z.infer<typeof opsRefundCreateResponseSchema>;

/** 退款裁决返回：退款与新状态，以及它可能带动的收款状态（退满 → refunded）。 */
export const opsRefundTransitionResponseSchema = z.object({
  refund: opsRefundSchema,
  receipt: opsReceiptSchema,
});
export type OpsRefundTransitionResponse = z.infer<typeof opsRefundTransitionResponseSchema>;
