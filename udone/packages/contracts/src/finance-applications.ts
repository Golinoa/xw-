import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';
import { isoDateSchema, moneySchema } from './orders';

/**
 * 收付款申请与审批契约（R-FIN-02 / R-FIN-03 / R-APPROVAL-02）。
 *
 * 这一份契约描述的是「钱怎么进来、怎么出去」的**审批过程**，不是余额本身：
 * 余额口径在 `finance.ts` 的纯函数里，两边不重叠。刻意不在这里放
 * `confirmedAmount` 之类的计算字段——申请只携带自己那一笔的金额，
 * 汇总永远由服务端和前端各自从同一份 `summarizeAmountLines` 得到。
 *
 * 三条从数据库层继承下来的规则，写在这里是为了让越界请求在边界就被挡住：
 * 1. 一笔申请只能挂在一行金额明细上，收款挂应收、付款挂应付，不存在
 *    「挂订单」的写法。跨订单或跨租户的明细 id 在库里不成立，这里先按
 *    `kind` 与 `lineId` 的必填把话说明白。
 * 2. 待审占用额度但不计入已收/已付。所以「可申请余额」必须先扣掉在途，
 *    前端提交前用 `applicableReceivable` / `applicablePayable` 做上限，
 *    服务端再用函数里的 `available_amount` 复核。
 * 3. 驳回必须写意见，撤回与撤销终审必须写原因。库函数各自返回
 *    `REASON_REQUIRED`，这里用 refine 提前拦一次——边界返回 400 比让用户
 *    点完按钮再看 409 好得多，而库里的那一道仍然保留（防御不做减法）。
 */

export const FINANCE_APPLICATION_KINDS = ['receipt', 'payment'] as const;
export const financeApplicationKindSchema = z.enum(FINANCE_APPLICATION_KINDS);
export type FinanceApplicationKind = z.infer<typeof financeApplicationKindSchema>;

export const FINANCE_APPLICATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export const financeApplicationStatusSchema = z.enum(FINANCE_APPLICATION_STATUSES);
export type FinanceApplicationStatus = z.infer<typeof financeApplicationStatusSchema>;

/** 收款方式。与 `finance_applications.method` 的 CHECK 一一对应。 */
export const PAYMENT_METHODS = ['cash', 'bank', 'alipay', 'wechat', 'other'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/**
 * 审批级次上限。当前写死两级（财务 → 管理员），与库函数里的 `current_step`
 * CHECK 同源。R-APPROVAL-01 的流程配置表落地后，这个常量要跟着配置走。
 */
export const FINANCE_APPLICATION_FINAL_STEP = 2;

/** 审批动作。`undo` 只对已终审通过的申请有效，且要求管理员权限。 */
export const FINANCE_APPLICATION_ACTIONS = ['approve', 'reject', 'withdraw', 'undo'] as const;
export const financeApplicationActionSchema = z.enum(FINANCE_APPLICATION_ACTIONS);
export type FinanceApplicationAction = z.infer<typeof financeApplicationActionSchema>;

export const FINANCE_APPLICATION_SORT_FIELDS = ['createdAt', 'amount', 'occurredOn'] as const;

/** 路径参数。与其它资源的 params schema 保持同一上限。 */
export const financeApplicationParamsSchema = z.object({
  applicationId: z.string().trim().min(1).max(64),
});

/** 备注、凭证、流水号都是可选文本：空串在库层是合法值，但空串没有信息量。 */
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/**
 * 创建申请。
 *
 * `amount` 复用订单契约里的 `moneySchema` 再加一道 `> 0`：库上写的是
 * `CHECK (amount > 0)`，允许 0 元的申请只会在函数里撞上 `AMOUNT_INVALID`，
 * 那是一次没有必要的往返。两位小数的精度校验也来自同一个 schema，
 * 不另写一份浮点判断。
 */
export const createFinanceApplicationRequestSchema = z.object({
  kind: financeApplicationKindSchema,
  orderId: z.string().min(1).max(64),
  /** 收款对应应收明细 id，付款对应应付明细 id。 */
  lineId: z.string().min(1).max(64),
  amount: moneySchema.refine((value) => value > 0, {
    message: 'amount must be greater than zero',
  }),
  method: paymentMethodSchema,
  occurredOn: isoDateSchema,
  referenceNo: optionalText(64),
  /**
   * 凭证地址。当前没有上传能力，这里只做长度约束、不校验 URL 形态：
   * 未来接对象存储时可能存相对路径，用 `.url()` 会把它判成非法。
   */
  voucherUrl: optionalText(500),
  remark: z.string().trim().max(500).optional(),
});
export type CreateFinanceApplicationRequest = z.infer<typeof createFinanceApplicationRequestSchema>;

/**
 * 审批（通过或驳回）。
 *
 * 驳回必须带意见：`reject` 不给理由，创建人只能看到状态变成「已驳回」，
 * 既不知道改哪里也不知道该找谁——这是审批流最常见的无效沟通。
 */
export const decideFinanceApplicationRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    opinion: z.string().trim().max(500).optional(),
    /** 乐观锁版本号。审批是并发最集中的动作，两个人同时点通过必须有一个失败。 */
    version: z.number().int().min(1),
  })
  .refine((value) => value.action !== 'reject' || (value.opinion ?? '').length > 0, {
    message: 'reject requires an opinion',
    path: ['opinion'],
  });
export type DecideFinanceApplicationRequest = z.infer<typeof decideFinanceApplicationRequestSchema>;

/** 撤回（创建人）与撤销终审（管理员）都要写原因，两者请求体形状相同。 */
export const financeApplicationReasonRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
});
export type FinanceApplicationReasonRequest = z.infer<typeof financeApplicationReasonRequestSchema>;

/**
 * 单条申请。
 *
 * 没有 `createdByName` 这种字段，不是漏了：`profiles` 只有
 * `profiles_select_self` 一条读策略，服务端拿用户令牌读不到同事的显示名。
 * 要显示姓名得先决定「是否允许同租户互看姓名」，那是权限设计问题，
 * 不该由一张列表顺手决定。在此之前前端用 `createdBy` 与当前用户比对，
 * 显示「你提交」或「其他成员提交」。
 */
export const financeApplicationItemSchema = z.object({
  id: z.string().min(1),
  kind: financeApplicationKindSchema,
  status: financeApplicationStatusSchema,
  /** 1 = 待财务审批，2 = 待管理员终审。 */
  currentStep: z.number().int().min(1).max(FINANCE_APPLICATION_FINAL_STEP),
  orderId: z.string().min(1),
  orderNumber: z.string(),
  customerName: z.string(),
  lineId: z.string().min(1),
  /** 明细行名称的快照，不随订单编辑而漂移。 */
  lineName: z.string(),
  amount: z.number(),
  method: paymentMethodSchema,
  occurredOn: z.string(),
  referenceNo: z.string().nullable(),
  voucherUrl: z.string().nullable(),
  remark: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().min(1),
});
export type FinanceApplicationItem = z.infer<typeof financeApplicationItemSchema>;

/** 审批轨迹。只追加，撤销与重审都是新的一行，不覆盖历史。 */
export const financeApplicationActionItemSchema = z.object({
  id: z.string().min(1),
  step: z.number().int().min(1).max(FINANCE_APPLICATION_FINAL_STEP),
  action: financeApplicationActionSchema,
  opinion: z.string().nullable(),
  fromStatus: financeApplicationStatusSchema,
  toStatus: financeApplicationStatusSchema,
  actorId: z.string().nullable(),
  createdAt: z.string(),
});
export type FinanceApplicationActionItem = z.infer<typeof financeApplicationActionItemSchema>;

export const financeApplicationListQuerySchema = listQuerySchema(
  FINANCE_APPLICATION_SORT_FIELDS,
).extend({
  kind: financeApplicationKindSchema.optional(),
  status: financeApplicationStatusSchema.optional(),
  orderId: z.string().min(1).max(64).optional(),
  /** 匹配订单号、客户名或明细行名称。 */
  keyword: z.string().trim().max(100).optional(),
});
export type FinanceApplicationListQuery = z.infer<typeof financeApplicationListQuerySchema>;

export const financeApplicationListResponseSchema = pagedResponseSchema(
  financeApplicationItemSchema,
);
export type FinanceApplicationListResponse = z.infer<typeof financeApplicationListResponseSchema>;

export const financeApplicationResponseSchema = z.object({
  application: financeApplicationItemSchema,
});
export type FinanceApplicationResponse = z.infer<typeof financeApplicationResponseSchema>;

/** 详情比列表多一段轨迹：审批人需要看到前一级为什么通过，而不是只看当前状态。 */
export const financeApplicationDetailResponseSchema = z.object({
  application: financeApplicationItemSchema,
  actions: z.array(financeApplicationActionItemSchema),
});
export type FinanceApplicationDetailResponse = z.infer<
  typeof financeApplicationDetailResponseSchema
>;
