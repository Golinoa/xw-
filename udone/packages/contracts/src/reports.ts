import { z } from 'zod';

/**
 * 租户报表（R-REPORT-01）。
 *
 * 所有数字都来自数据库的 `tenant_report()` / `tenant_supplier_report()`，
 * 页面、仪表盘、导出共用同一函数——这里只定义形状，不做任何汇总。
 */

export const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  includeCancelled: z.coerce.boolean().default(false),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportOverviewSchema = z.object({
  orderCount: z.number().int().min(0),
  receivableTotal: z.number(),
  payableTotal: z.number(),
  profit: z.number(),
});

export const reportFinanceSchema = z.object({
  confirmedIn: z.number(),
  pendingIn: z.number(),
  confirmedOut: z.number(),
  pendingOut: z.number(),
});

export const reportResponseSchema = z.object({
  dateField: z.literal('createdAt'),
  from: z.string(),
  to: z.string(),
  includeCancelled: z.boolean(),
  overview: reportOverviewSchema,
  finance: reportFinanceSchema,
  byStatus: z.record(z.string(), z.number()),
});
export type ReportResponse = z.infer<typeof reportResponseSchema>;

export const supplierReportItemSchema = z.object({
  supplierId: z.string().min(1),
  supplierName: z.string(),
  orderCount: z.number().int().min(0),
  payableAmount: z.number(),
  confirmedAmount: z.number(),
});

export const supplierReportResponseSchema = z.object({
  items: z.array(supplierReportItemSchema),
});
export type SupplierReportResponse = z.infer<typeof supplierReportResponseSchema>;
