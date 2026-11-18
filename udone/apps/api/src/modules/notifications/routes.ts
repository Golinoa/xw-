import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ROUTES,
  markNotificationsReadRequestSchema,
  notificationListQuerySchema,
} from '@erp/contracts';
import { parseJson, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth } from '../../middleware/auth';
import type { NotificationRepository } from './notification-service';
import { notificationRepository } from './notification-service';

/** 站内通知（R-NOTIFY-01）：只读写给当前登录人的通知，不需要额外权限码。 */
export const notificationRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): NotificationRepository {
  return (
    context.env.NOTIFICATION_REPOSITORY ??
    notificationRepository(context.env, context.get('authToken'))
  );
}

notificationRoutes.get(ROUTES.notificationUnreadCount.path, requireAuth(), async (context) => {
  const auth = context.get('auth');
  const count = await repository(context).unreadCount(auth.organizationId, auth.userId);
  return respond(context, 'notificationUnreadCount', { count });
});

notificationRoutes.get(ROUTES.listNotifications.path, requireAuth(), async (context) => {
  const query = parseQuery(context, notificationListQuerySchema);
  const auth = context.get('auth');
  const page = await repository(context).list(query, auth.organizationId, auth.userId);
  return respond(context, 'listNotifications', page);
});

notificationRoutes.patch(ROUTES.markNotificationsRead.path, requireAuth(), async (context) => {
  const body = await parseJson(context, markNotificationsReadRequestSchema);
  const auth = context.get('auth');
  const updated = await repository(context).markRead(body.ids, auth.organizationId, auth.userId);
  return respond(context, 'markNotificationsRead', { updated });
});
