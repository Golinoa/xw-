import { z } from 'zod';
import { listQuerySchema } from './pagination';

/**
 * 线路主数据契约（R-ROUTE-01）。
 *
 * 两条与订单的边界，写在这里以免后来者「顺手」改掉：
 * 1. **订单只保存线路名称快照，不引用线路主数据**。下拉选中线路时，把它的
 *    `name` 拷贝进 `orders.routeName`；此后线路改名、停用、删除都不影响历史订单。
 * 2. `routeType` / `region` / `departureCity` 是自由文本，不是枚举。需求把这些
 *    交给「公司字典」维护（R-SETTING-01），字典落地前写死枚举等于把「公司可维护」
 *    变成「发版才能改」。`days` 是唯一的强类型字段：它可以被校验。
 */

export const ROUTE_SORT_FIELDS = ['createdAt', 'name', 'days'] as const;

export const tourRouteSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  routeType: z.string().optional(),
  region: z.string().optional(),
  departureCity: z.string().optional(),
  days: z.number().int().positive().optional(),
  /** 自组团：整团由本公司带，不拼团。它影响报价口径，所以单独成字段而不是塞进备注。 */
  isSelfGroup: z.boolean(),
  isActive: z.boolean(),
  remark: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TourRoute = z.infer<typeof tourRouteSchema>;

export const createTourRouteRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  routeType: z.string().trim().min(1).max(30).nullable().optional(),
  region: z.string().trim().min(1).max(50).nullable().optional(),
  departureCity: z.string().trim().min(1).max(50).nullable().optional(),
  days: z.number().int().min(1).max(365).nullable().optional(),
  isSelfGroup: z.boolean().optional(),
  remark: z.string().max(2000).nullable().optional(),
});
export type CreateTourRouteRequest = z.infer<typeof createTourRouteRequestSchema>;

/**
 * 改名 / 改属性 / 启停。空 PATCH 直接 400：它只会变成一次改 `updated_at` 的空写。
 *
 * 可空字段用「`undefined` = 不修改，`null` = 清空」区分，与客户契约一致；
 * 否则填错的天数或地区永远清不掉。
 */
export const updateTourRouteRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    routeType: z.string().trim().min(1).max(30).nullable().optional(),
    region: z.string().trim().min(1).max(50).nullable().optional(),
    departureCity: z.string().trim().min(1).max(50).nullable().optional(),
    days: z.number().int().min(1).max(365).nullable().optional(),
    isSelfGroup: z.boolean().optional(),
    isActive: z.boolean().optional(),
    remark: z.string().max(2000).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one field is required',
  });
export type UpdateTourRouteRequest = z.infer<typeof updateTourRouteRequestSchema>;

export const tourRouteListQuerySchema = listQuerySchema(ROUTE_SORT_FIELDS).extend({
  keyword: z.string().trim().max(100).optional(),
  activeOnly: z.enum(['true', 'false']).optional(),
});
export type TourRouteListQuery = z.infer<typeof tourRouteListQuerySchema>;

export const tourRouteParamsSchema = z.object({
  routeId: z.string().min(1).max(64),
});

export const tourRouteListResponseSchema = z.object({
  items: z.array(tourRouteSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

export const tourRouteResponseSchema = z.object({ route: tourRouteSchema });

/** 删除回执。线路被删除后历史订单仍保留名称快照，因此不做引用阻断。 */
export const tourRouteDeletedResponseSchema = z.object({
  deletedRouteId: z.string().min(1),
});
