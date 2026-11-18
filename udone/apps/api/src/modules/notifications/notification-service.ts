import type { Notification, NotificationListQuery, NotificationListResponse } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

const COLUMNS = 'id,notification_type,title,body,entity_type,entity_id,read_at,created_at';

type NotificationRow = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: string;
  read_at: string | null;
  created_at: string;
};

export interface NotificationRepository {
  list(
    filter: NotificationListQuery,
    organizationId: string,
    userId: string,
  ): Promise<NotificationListResponse>;
  unreadCount(organizationId: string, userId: string): Promise<number>;
  markRead(ids: string[], organizationId: string, userId: string): Promise<number>;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.notification_type as Notification['type'],
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

export function notificationRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): NotificationRepository {
  const client = createRestClient(environment, token);

  return {
    async list(filter, organizationId, userId) {
      // recipient_id 不用查询参数传：RLS 已经把「只能看自己的」写死了，
      // 这里再传一次只是重复，反而给越权留了口子。
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${organizationId}`);
      query.set('recipient_id', `eq.${userId}`);
      query.set('select', COLUMNS);
      query.set('order', `created_at.${filter.order}`);
      query.set('limit', String(filter.pageSize));
      query.set('offset', String((filter.page - 1) * filter.pageSize));
      if (filter.unreadOnly) query.set('read_at', 'is.null');

      const page = await client.restPage<NotificationRow>(`notifications?${query.toString()}`, {
        organizationId,
      });
      return {
        items: page.rows.map(toNotification),
        total: page.total,
        page: filter.page,
        pageSize: filter.pageSize,
      };
    },

    async unreadCount(organizationId, userId) {
      const page = await client.restPage<{ id: string }>(
        `notifications?organization_id=eq.${organizationId}&recipient_id=eq.${userId}&read_at=is.null&select=id`,
        { organizationId },
      );
      return page.total;
    },

    async markRead(ids, organizationId, userId) {
      const query = new URLSearchParams();
      query.set('organization_id', `eq.${organizationId}`);
      query.set('recipient_id', `eq.${userId}`);
      query.set('id', `in.(${ids.join(',')})`);
      query.set('read_at', 'is.null');
      const rows = await client.rest<Array<{ id: string }>>(`notifications?${query.toString()}`, {
        method: 'PATCH',
        organizationId,
        body: { read_at: new Date().toISOString() },
      });
      return rows.length;
    },
  };
}
