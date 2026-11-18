import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from './pagination';

/**
 * 租户侧审计日志查询（R-AUDIT-01）。
 *
 * 审计表 `public.audit_events` 从平台骨架阶段就存在，成员生命周期、审批与配置写入也一直在记。
 * 缺口从来不是「没有日志」，而是「没有人能看」——本契约只做只读查询，
 * 绝不给前端任何写入/删除入口：审计一旦能改，就不再是可信证据。
 */

export const AUDIT_SORT_FIELDS = ['createdAt', 'action', 'entityType'] as const;

export const auditEventSchema = z.object({
  id: z.string().min(1),
  /** 操作人显示名由服务端拼：actor_id 是内部 id，直接给前端只会逼它再查一次用户表。 */
  actorName: z.string(),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  /** 对象摘要由服务端生成，例如「订单 ORD2026...」；不返回整份 metadata。 */
  summary: z.string(),
  ipSummary: z.string().nullable(),
  deviceSummary: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditListQuerySchema = listQuerySchema(AUDIT_SORT_FIELDS).extend({
  actorId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditListResponseSchema = pagedResponseSchema(auditEventSchema);
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

/** 筛选面板用的可选项，从已有审计行去重而来，不另建字典表。 */
export const auditFacetsResponseSchema = z.object({
  actions: z.array(z.string()),
  entityTypes: z.array(z.string()),
});
export type AuditFacetsResponse = z.infer<typeof auditFacetsResponseSchema>;
