import { z } from 'zod';
import { queryBooleanSchema } from './http';
import { listQuerySchema, pagedResponseSchema } from './pagination';

/**
 * 站内通知（R-NOTIFY-01）。
 *
 * 只做租户内通知：审批待办、驳回、结算确认。短信/邮件/企微明确不在首期。
 * 实体跳转由前端按 entityType + entityId 拼路由，契约只给稳定字段，
 * 不给完整业务对象——通知面板不该成为第二个「订单详情」数据源。
 */

export const NOTIFICATION_TYPES = [
  'approval_pending',
  'application_approved',
  'application_rejected',
  'settlement_confirmed',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const NOTIFICATION_SORT_FIELDS = ['createdAt'] as const;

export const notificationSchema = z.object({
  id: z.string().min(1),
  type: notificationTypeSchema,
  title: z.string(),
  body: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = listQuerySchema(NOTIFICATION_SORT_FIELDS).extend({
  unreadOnly: queryBooleanSchema.default(false),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = pagedResponseSchema(notificationSchema);
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const notificationUnreadResponseSchema = z.object({ count: z.number().int().min(0) });
export type NotificationUnreadResponse = z.infer<typeof notificationUnreadResponseSchema>;

/** 标记已读只接受 id 列表，不做「全部已读」——那会让用户错过没看到的通知。 */
export const markNotificationsReadRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadRequestSchema>;

export const markNotificationsReadResponseSchema = z.object({ updated: z.number().int().min(0) });
export type MarkNotificationsReadResponse = z.infer<typeof markNotificationsReadResponseSchema>;
