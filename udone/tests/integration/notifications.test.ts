import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface NotificationList {
  items: Array<{
    id: string;
    type: string;
    title: string;
    read: boolean;
    entityType: string;
    entityId: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

describe('站内通知走真实 PostgREST', () => {
  it('登录人能读到自己的通知列表（初始可为空）', async () => {
    const response = await call<NotificationList>('/api/notifications', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 15 });
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('未读数返回非负整数', async () => {
    const response = await call<{ count: number }>('/api/notifications/unread-count', {
      actor: 'admin',
    });
    expectStatus(response, 200);
    expect(response.body.count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(response.body.count)).toBe(true);
  });

  it('只筛选未读时，返回的行都是未读', async () => {
    const response = await call<NotificationList>('/api/notifications', {
      actor: 'admin',
      query: { unreadOnly: 'true' },
    });
    expectStatus(response, 200);
    expect(response.body.items.every((item) => item.read === false)).toBe(true);
  });

  it('标记已读需要至少一条 id', async () => {
    const response = await call('/api/notifications/read', {
      method: 'PATCH',
      actor: 'admin',
      body: { ids: [] },
    });
    expectStatus(response, 400);
  });

  it('不同角色也能读自己的通知（通知不依赖额外权限码）', async () => {
    const response = await call<NotificationList>('/api/notifications', { actor: 'operator' });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });
});
