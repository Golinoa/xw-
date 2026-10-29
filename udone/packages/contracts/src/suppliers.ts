import { z } from 'zod';
import { listQuerySchema } from './pagination';

/**
 * 供应商契约（R-SUPPLIER-01）。
 *
 * 本切片只交付「列表 + 新建」，因为订单的应付行必须能引用一个真实供应商；
 * 编辑、停用、删除引用校验（OBJECT_REFERENCED）随后补，不在这里假装已经支持。
 */

export const SUPPLIER_SORT_FIELDS = ['createdAt', 'name'] as const;

/** 供应商类型由公司维护，这里只固化最常见的几类，其余归入 `other`。 */
export const supplierTypeSchema = z.enum(['hotel', 'transport', 'restaurant', 'ticket', 'other']);
export type SupplierType = z.infer<typeof supplierTypeSchema>;

/** 月结与非月结参与结算筛选（R-SUPPLIER-01）。 */
export const supplierSettlementSchema = z.enum(['monthly', 'per_trip']);
export type SupplierSettlement = z.infer<typeof supplierSettlementSchema>;

export const supplierSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: supplierTypeSchema,
  contactName: z.string().optional(),
  phone: z.string().optional(),
  settlement: supplierSettlementSchema,
  isActive: z.boolean(),
  remark: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Supplier = z.infer<typeof supplierSchema>;

export const createSupplierRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: supplierTypeSchema,
  contactName: z.string().trim().max(50).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  settlement: supplierSettlementSchema.default('per_trip'),
  remark: z.string().max(2000).nullable().optional(),
});
export type CreateSupplierRequest = z.infer<typeof createSupplierRequestSchema>;

export const supplierListQuerySchema = listQuerySchema(SUPPLIER_SORT_FIELDS).extend({
  keyword: z.string().trim().max(100).optional(),
  settlement: supplierSettlementSchema.optional(),
  activeOnly: z.enum(['true', 'false']).optional(),
});

export const supplierListResponseSchema = z.object({
  items: z.array(supplierSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});

export const supplierResponseSchema = z.object({ supplier: supplierSchema });

export const supplierParamsSchema = z.object({
  supplierId: z.string().min(1).max(64),
});
