import { z } from 'zod';

/**
 * 列表分页与排序的唯一契约。
 *
 * 需求 §18.3 定死默认每页 15 条、可选 10/20/30/50/100；§19.1 要求列表请求带
 * `page`/`pageSize`/`sort`。此前各端点没有统一分页契约（`CONTRACTS.md` §9.4 记为遗留项），
 * 客户主数据是第一个列表功能，按约定在此一次性定死，后续列表一律复用。
 *
 * 排序字段只能走调用方给出的白名单：PostgREST 的 `order` 参数位于标识符位置，
 * 无法像值一样参数化绑定，只能从固定集合里选（`DATABASE_STANDARDS.md` §2）。
 */

/**
 * 允许的每页条数。默认值 15 必须同时出现在这里：`pageSizeSchema` 只认白名单，
 * 如果把 15 排除在外，客户端回传自己的默认值就会被 400 拒绝。
 */
export const PAGE_SIZE_OPTIONS = [15, 10, 20, 30, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 15;

export const sortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** 查询串里的值都是字符串，必须显式转型后再校验。 */
export const pageNumberSchema = z.coerce.number().int().min(1);

export const pageSizeSchema = z.coerce
  .number()
  .int()
  .refine((value) => (PAGE_SIZE_OPTIONS as readonly number[]).includes(value), {
    message: `pageSize must be one of ${PAGE_SIZE_OPTIONS.join(', ')}`,
  });

/**
 * 生成某个列表端点的查询契约。
 *
 * 默认排序取白名单首项并降序，是列表页最常见的「最新在前」语义；
 * 需要升序的端点由调用方显式声明默认值，不在服务层偷偷改。
 */
export function listQuerySchema<const T extends readonly [string, ...string[]]>(sortable: T) {
  return z.object({
    page: pageNumberSchema.default(1),
    pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
    sort: z.enum(sortable).default(sortable[0]),
    order: sortOrderSchema.default('desc'),
  });
}

/**
 * 分页响应外壳。`total` 是满足同一筛选条件的总条数，不是当前页条数——
 * 前端分页器与「筛选后共 N 条」文案都依赖它。
 */
export function pagedResponseSchema<I extends z.ZodType>(item: I) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  });
}
