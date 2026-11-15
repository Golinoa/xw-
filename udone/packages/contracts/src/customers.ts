import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';

/**
 * 客户主数据契约（R-CUSTOMER-01、R-MASTER-01）。
 *
 * 字段命名遵循 `CONTRACTS.md` §4：小驼峰、缺失用 `.optional()` 而非 `null`、
 * 日期时间为 ISO 8601 字符串。数据库 `snake_case` 列名只在仓储层出现，不上浮到这里。
 *
 * 敏感字段（电话、证件号）在原值与掩码值之间分开暴露：
 * - 列表一律只给 `*Masked`，列表页从不需要原值；
 * - 详情按 `customer.sensitive.read` 权限决定是否给原值，掩码值始终可用。
 * 掩码只影响响应，数据库永远只存原值，不允许把掩码写回覆盖原值（需求 §17.2）。
 */

export const CUSTOMER_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

/** 证件类型。目标站字典未确认前只保留最常用两类，其余归入 `other`，不臆造更多枚举。 */
export const customerIdTypeSchema = z.enum(['id_card', 'passport', 'other']);
export type CustomerIdType = z.infer<typeof customerIdTypeSchema>;

export const customerTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional(),
});
export type CustomerTag = z.infer<typeof customerTagSchema>;

export const customerListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phoneMasked: z.string().optional(),
  emailMasked: z.string().optional(),
  sourceName: z.string().optional(),
  tags: z.array(customerTagSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerListItem = z.infer<typeof customerListItemSchema>;

export const customerDetailSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phone: z.string().optional(),
  phoneMasked: z.string().optional(),
  email: z.string().optional(),
  emailMasked: z.string().optional(),
  idType: customerIdTypeSchema.optional(),
  idNumber: z.string().optional(),
  idNumberMasked: z.string().optional(),
  birthday: z.string().optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  tags: z.array(customerTagSchema),
  remark: z.string().optional(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CustomerDetail = z.infer<typeof customerDetailSchema>;

/**
 * 创建与更新共用的字段形状。
 *
 * 单独抽出来是因为 `z.object(...).refine(...)` 产出的 schema 不能再 `.partial()`，
 * 更新请求必须从同一份形状派生，否则两份字段定义迟早漂移。
 *
 * 可选业务字段都允许显式 `null`：`undefined`/缺失表示「不修改」，`null` 表示「清空」。
 * 没有这个区分，用户清掉一个错误的手机号或备注就永远改不回去。
 */
const customerFieldsShape = {
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(3).max(32).nullable().optional(),
  email: z.string().trim().toLowerCase().pipe(z.email()).nullable().optional(),
  idType: customerIdTypeSchema.nullable().optional(),
  idNumber: z.string().trim().min(1).max(64).nullable().optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthday must be an ISO date (YYYY-MM-DD)')
    .nullable()
    .optional(),
  sourceId: z.string().min(1).max(64).nullable().optional(),
  tagIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  remark: z.string().max(2000).nullable().optional(),
};

/** 证件类型与证件号必须成对出现；`null` 与缺失同义，都算「没有」。 */
function absent(value: string | null | undefined): boolean {
  return value === undefined || value === null;
}

function idNumberPairedWithType(value: { idType?: string | null; idNumber?: string | null }) {
  return absent(value.idType) === absent(value.idNumber);
}

const idPairIssue = {
  message: 'idType and idNumber must be provided together',
  path: ['idNumber'],
};

export const createCustomerRequestSchema = z
  .object(customerFieldsShape)
  .refine(idNumberPairedWithType, idPairIssue);

/**
 * 更新是整体语义：`tagIds` 一旦提供就全量替换关联，不做增量合并——
 * 增量合并会让「清空所有标签」这个动作无法表达。
 *
 * `version` 是乐观锁：客户端回传读取到的版本号，服务端不匹配即 409，
 * 避免两人同时编辑时后写覆盖先写。
 */
export const updateCustomerRequestSchema = z
  .object(customerFieldsShape)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .refine(idNumberPairedWithType, idPairIssue);

export const customerListQuerySchema = listQuerySchema(CUSTOMER_SORT_FIELDS).extend({
  keyword: z.string().trim().max(100).optional(),
  sourceId: z.string().min(1).max(64).optional(),
  tagId: z.string().min(1).max(64).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const customerParamsSchema = z.object({
  customerId: z.string().min(1).max(64),
});

/** 标签选项列表。客户表单需要在下拉里选标签，所以标签读取与客户同属一个切片。 */
export const customerTagListResponseSchema = z.object({
  tags: z.array(customerTagSchema),
});

export const createCustomerTagRequestSchema = z.object({
  name: z.string().trim().min(1).max(30),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex value like #1b2a4a')
    .optional(),
});
export type CreateCustomerTagRequest = z.infer<typeof createCustomerTagRequestSchema>;

export const customerTagResponseSchema = z.object({
  tag: customerTagSchema,
});

export const customerListResponseSchema = pagedResponseSchema(customerListItemSchema);

export const customerResponseSchema = z.object({
  customer: customerDetailSchema,
});

/** 同手机号的其他客户，仅创建响应返回。前端展示为「疑似重复」提示，不阻断保存。 */
export const customerDuplicateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phoneMasked: z.string().optional(),
  createdAt: z.string(),
});

export const createCustomerResponseSchema = z.object({
  customer: customerDetailSchema,
  duplicates: z.array(customerDuplicateSchema),
});

/** 软删除回执。删除后实体仍可被订单引用，所以返回被删 ID 而不是空正文。 */
export const customerDeletedResponseSchema = z.object({
  deletedCustomerId: z.string().min(1),
});

/**
 * 回收站恢复回执。与删除对称：返回被恢复的 ID，
 * 调用方据此刷新列表，不必再猜「恢复的是哪一条」。
 */
export const customerRestoredResponseSchema = z.object({
  restoredCustomerId: z.string().min(1),
});

export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;
export type CustomerResponse = z.infer<typeof customerResponseSchema>;
export type CreateCustomerResponse = z.infer<typeof createCustomerResponseSchema>;
export type CustomerDuplicate = z.infer<typeof customerDuplicateSchema>;
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;
