import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';
import { opsBillingAllocationSchema, opsBillingReversalSchema } from './billing-shared';

/**
 * billing 域（契约 §3.4 / §5.5 的**前四个**端点：应收计划与展期）。
 *
 * 后三个（收款、核销、退款）属 T-08，不在这里：契约 §5.5 一共 14 个端点，
 * 四个是应收、十个是收款链路。分两批落地是因为收款侧的并发不变量（锁定
 * `receipts` 与全部 `receivables` 行、同事务校验超额）与本域没有共用代码，
 * 合在一起写只会让两边的守卫互相干扰。
 *
 * 金额一律 JSON number（库里 `numeric(14,2)` 经 `jsonb_build_object` 出来就是
 * 数字）。**入站不收 `periodNo` / `currency`**：期号由数组顺序决定，币种从合同
 * 继承——让调用方决定这两项，等于允许「第 2 期」重复出现、允许合同内混币。
 */

/**
 * 应收状态（契约 §3.4 的五档优先级）。
 *
 * `unpaid` 不在里面：它是契约的**保留值**，v1 不返回（U-02：语义与 `overdue`
 * 重叠）。放进枚举会让前端以为能筛它，而库永远不会产出这个值。
 */
export const OPS_RECEIVABLE_STATUSES = [
  'reversed',
  'paid',
  'overdue',
  'partial',
  'upcoming',
] as const;
export const opsReceivableStatusSchema = z.enum(OPS_RECEIVABLE_STATUSES);
export type OpsReceivableStatus = z.infer<typeof opsReceivableStatusSchema>;

/** 排序白名单（契约 §5.5：「排序白名单 `dueDate/amount`」）。 */
export const OPS_RECEIVABLE_SORTS = ['dueDate', 'amount'] as const;
export const opsReceivableSortSchema = z.enum(OPS_RECEIVABLE_SORTS);
export type OpsReceivableSort = z.infer<typeof opsReceivableSortSchema>;

/**
 * 客户摘要：只给 `id` / `customerNo` / `name`。
 *
 * 不带 `maskedPhone` 一类字段——应收列表是财务视角，客户联系方式既不该出现在
 * 这里，也无助于对账；多带一列就等于多一次「为什么这个接口能看到手机号」的追问。
 */
export const opsReceivableCustomerSchema = z.object({
  id: z.uuid(),
  customerNo: z.string(),
  name: z.string(),
});
export type OpsReceivableCustomer = z.infer<typeof opsReceivableCustomerSchema>;

/**
 * 单期应收。列表项与详情里的 `receivable` 用同一个 schema：两处形状不一致时，
 * 「列表能显示、详情打不开」这类缺陷只会出现在类型之外。
 */
export const opsReceivableSchema = z.object({
  id: z.uuid(),
  contractId: z.uuid(),
  contractNo: z.string(),
  customerId: z.uuid(),
  customer: opsReceivableCustomerSchema,
  periodNo: z.number().int().min(1),
  dueDate: z.iso.date(),
  amount: z.number(),
  currency: z.string().length(3),
  allocatedAmount: z.number(),
  reversedAmount: z.number(),
  /** `amount - (allocated - reversed)`，服务端算好；前端不要自己减。 */
  outstanding: z.number(),
  status: opsReceivableStatusSchema,
  note: z.string().nullable().optional(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OpsReceivable = z.infer<typeof opsReceivableSchema>;

/**
 * 汇总。`settled + outstanding = total` 必须恒成立（库里两式互补，与状态无关），
 * 前端拿这四个数直接渲染卡片，不再做二次加减。
 */
export const opsReceivableSummarySchema = z.object({
  totalAmount: z.number(),
  settledAmount: z.number(),
  outstandingAmount: z.number(),
  overdueAmount: z.number(),
});
export type OpsReceivableSummary = z.infer<typeof opsReceivableSummarySchema>;

/** 展期记录：`previousDueDate` 是历史到期日的唯一来源。 */
export const opsReceivableExtensionSchema = z.object({
  id: z.uuid(),
  previousDueDate: z.iso.date(),
  newDueDate: z.iso.date(),
  reason: z.string(),
  createdBy: z.uuid().nullable().optional(),
  createdAt: z.string(),
});
export type OpsReceivableExtension = z.infer<typeof opsReceivableExtensionSchema>;

/**
 * 列表查询。
 *
 * `overdueOnly` 与 `status=overdue` 是同一个判据（库里两处都用派生状态），
 * 保留两个入口是因为列表页的「只看逾期」是一个独立开关，且契约 §5.5 两个都列了。
 */
export const opsReceivableListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  contractId: z.uuid().optional(),
  status: z.array(opsReceivableStatusSchema).optional(),
  dueFrom: z.iso.date().optional(),
  dueTo: z.iso.date().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  sort: opsReceivableSortSchema.default('dueDate'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsReceivableListQuery = z.infer<typeof opsReceivableListQuerySchema>;

/**
 * 生成计划：一次写整份，不提供单期增删。
 *
 * `periods` 至少一期：空数组的语义是「没有收款安排」，而合同一定有金额，
 * 两者必然矛盾，交给 400 比让它静默成功更诚实。
 */
export const opsReceivablePlanCreateRequestSchema = z.strictObject({
  contractId: z.uuid(),
  periods: z
    .array(
      z.strictObject({
        dueDate: z.iso.date(),
        amount: z.number().positive(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});
export type OpsReceivablePlanCreateRequest = z.infer<typeof opsReceivablePlanCreateRequestSchema>;

/**
 * 展期请求。
 *
 * `version` 必填：两个人同时展期同一期时，后到的必须看见冲突，而不是覆盖前一次
 * 的新日期（覆盖后两次展期只剩一条记录，审计上看起来只展期了一次）。
 */
export const opsReceivableExtensionCreateRequestSchema = z.strictObject({
  newDueDate: z.iso.date(),
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().min(1),
});
export type OpsReceivableExtensionCreateRequest = z.infer<
  typeof opsReceivableExtensionCreateRequestSchema
>;

export const opsReceivableListResponseSchema = pagedResponseSchema(opsReceivableSchema).extend({
  summary: opsReceivableSummarySchema,
});
export type OpsReceivableListResponse = z.infer<typeof opsReceivableListResponseSchema>;

export const opsReceivablePlanCreateResponseSchema = z.object({
  items: z.array(opsReceivableSchema),
});
export type OpsReceivablePlanCreateResponse = z.infer<typeof opsReceivablePlanCreateResponseSchema>;

/**
 * 详情。
 *
 * `allocations` / `reversals` 上一轮是松形状（`z.record`）：两张表还没落地，
 * 只能给个「什么东西都收」的壳。T-08 把表建出来之后，松形状就从「宽容」变成
 * 「什么都不校验」——`respond()` 拿它兜底，等于这两块没有任何出站保护。
 * 现在换成与 `GET /receipts/{id}` 完全相同的 schema。
 */
export const opsReceivableDetailResponseSchema = z.object({
  receivable: opsReceivableSchema,
  allocations: z.array(opsBillingAllocationSchema),
  extensions: z.array(opsReceivableExtensionSchema),
  reversals: z.array(opsBillingReversalSchema),
});
export type OpsReceivableDetailResponse = z.infer<typeof opsReceivableDetailResponseSchema>;

export const opsReceivableExtensionCreateResponseSchema = z.object({
  receivable: opsReceivableSchema,
  extension: opsReceivableExtensionSchema,
});
export type OpsReceivableExtensionCreateResponse = z.infer<
  typeof opsReceivableExtensionCreateResponseSchema
>;
