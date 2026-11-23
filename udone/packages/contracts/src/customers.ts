import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
  listQuerySchema,
} from './pagination';

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

/**
 * 客户来源。两级结构：`parentId` 为空是根来源，否则是它下面的子来源。
 *
 * 用「扁平 + parentId」而不是嵌套树：前端按 parentId 分组即可，
 * 而契约一旦嵌套，任何一层的增删都要改递归 schema。
 */
export const customerSourceSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type CustomerSource = z.infer<typeof customerSourceSchema>;

export const customerSourceListResponseSchema = z.object({
  sources: z.array(customerSourceSchema),
});

/**
 * 来源列表查询。**默认只回启用项**（服务端 `includeInactive !== '1'` 时追加
 * `is_active=is.true`），所以「客户来源管理页」必须显式传 `includeInactive=1`：
 * 否则在页面上点一次「停用」，这一行就从列表里消失，再也恢复不了。
 *
 * 用 `.default({})` 而不是必填对象：客户表单只要启用项，调用方不传参数是正常用法，
 * 不能让「不传」变成契约违例（旧前端就是这么调的）。
 */
export const customerSourceListQuerySchema = z
  .object({ includeInactive: z.enum(['0', '1']).optional() })
  .default({});

export const customerSourceParamsSchema = z.object({
  sourceId: z.string().min(1).max(64),
});

export const createCustomerSourceRequestSchema = z.object({
  name: z.string().trim().min(1).max(30),
  /** 不传或 null 表示建根来源。 */
  parentId: z.string().min(1).max(64).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type CreateCustomerSourceRequest = z.infer<typeof createCustomerSourceRequestSchema>;

/**
 * 改名 / 调序 / 停用。**刻意不允许改 parentId**：
 * 改父级要额外校验「目标不是自己的后代」，否则会造出环；
 * 而来源层级是低频结构，删掉重建比在线改层级更安全。
 */
export const updateCustomerSourceRequestSchema = z.object({
  name: z.string().trim().min(1).max(30).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateCustomerSourceRequest = z.infer<typeof updateCustomerSourceRequestSchema>;

export const customerSourceResponseSchema = z.object({
  source: customerSourceSchema,
});

/** 删除回执。与客户删除保持同一形状：返回被删 ID，不做空正文。 */
export const customerSourceDeletedResponseSchema = z.object({
  deletedSourceId: z.string().min(1),
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

export const customerTagParamsSchema = z.object({
  tagId: z.string().min(1).max(64),
});

/**
 * 改名 / 改色。两个字段都可选，但至少给一个 —— 空 PATCH 没有语义，
 * 放过去只会变成一次改 `updated_at` 的空操作。
 *
 * `color: null` 表示清空颜色，与「不传 = 不修改」区分开。
 */
export const updateCustomerTagRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(30).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a hex value like #1b2a4a')
      .nullable()
      .optional(),
  })
  .refine((value) => value.name !== undefined || value.color !== undefined, {
    message: 'at least one of name or color is required',
  });
export type UpdateCustomerTagRequest = z.infer<typeof updateCustomerTagRequestSchema>;

export const customerTagDeletedResponseSchema = z.object({
  deletedTagId: z.string().min(1),
});

/**
 * 批量打标。`addTagIds` 与 `removeTagIds` 分别表达「加上」与「去掉」，
 * 同一个标签同时出现在两边属于歧义输入，直接拒绝而不是猜一个优先级。
 *
 * 上限 200 位客户：这个端点是给列表勾选用的，超过这个量级应当走导入而不是点选。
 */
export const batchCustomerTagsRequestSchema = z
  .object({
    customerIds: z.array(z.string().min(1).max(64)).min(1).max(200),
    addTagIds: z.array(z.string().min(1).max(64)).max(50).optional(),
    removeTagIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .refine((value) => (value.addTagIds?.length ?? 0) + (value.removeTagIds?.length ?? 0) > 0, {
    message: 'at least one tag to add or remove is required',
  })
  .refine(
    (value) => {
      const add = new Set(value.addTagIds ?? []);
      return !(value.removeTagIds ?? []).some((tagId) => add.has(tagId));
    },
    { message: 'a tag cannot be added and removed in the same request' },
  );
export type BatchCustomerTagsRequest = z.infer<typeof batchCustomerTagsRequestSchema>;

export const batchCustomerTagsResponseSchema = z.object({
  updatedCustomerIds: z.array(z.string().min(1)),
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

/**
 * 回收站条目。
 *
 * 不复用 `customerListItemSchema`：列表项带的是 `updatedAt`（最近编辑），
 * 回收站关心的是 `deletedAt`（什么时候删的）；混用字段会让前端以为能按编辑时间排序。
 * 敏感字段同样只给掩码——回收站不需要原值，能少暴露一次就少一次。
 */
export const customerRecycleBinItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phoneMasked: z.string().optional(),
  emailMasked: z.string().optional(),
  sourceName: z.string().optional(),
  tags: z.array(customerTagSchema),
  createdAt: z.string(),
  deletedAt: z.string(),
});
export type CustomerRecycleBinItem = z.infer<typeof customerRecycleBinItemSchema>;

/**
 * 回收站查询：只有分页与关键字。
 *
 * 不给排序白名单——回收站唯一的合理顺序是「最近删的在前」（`deleted_at desc`），
 * 让调用方选排序只会多一个需要校验的入口。
 */
export const customerRecycleBinQuerySchema = z.object({
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
  keyword: z.string().trim().max(100).optional(),
});
export type CustomerRecycleBinQuery = z.infer<typeof customerRecycleBinQuerySchema>;

export const customerRecycleBinResponseSchema = pagedResponseSchema(customerRecycleBinItemSchema);
export type CustomerRecycleBinResponse = z.infer<typeof customerRecycleBinResponseSchema>;

export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;
export type CustomerResponse = z.infer<typeof customerResponseSchema>;
export type CreateCustomerResponse = z.infer<typeof createCustomerResponseSchema>;
export type CustomerDuplicate = z.infer<typeof customerDuplicateSchema>;
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;
