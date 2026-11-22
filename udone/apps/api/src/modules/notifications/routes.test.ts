import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, Notification } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { NotificationRepository } from './notification-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const identity: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'operator',
  sessionId: 'session-1',
  permissions: [],
  dataScope: 'all',
};

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1',
    type: 'application_approved',
    title: '申请已通过',
    body: '收款申请 ¥3000 已审批通过',
    entityType: 'finance_application',
    entityId: 'app-1',
    read: false,
    createdAt: '2026-11-19T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<NotificationRepository> = {}): NotificationRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [notification()], total: 1, page: 1, pageSize: 15 }),
    unreadCount: vi.fn().mockResolvedValue(1),
    markRead: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function setup(repository: NotificationRepository) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn().mockResolvedValue(false),
    },
    NOTIFICATION_REPOSITORY: repository,
  };
  return { testApp, env };
}

const headers = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

describe('notification routes', () => {
  it('lists notifications scoped to the current user', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({ items: [notification()], total: 1, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/notifications', { headers }, env);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), ORG, USER);
  });

  it('passes unreadOnly through', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/notifications?unreadOnly=true', { headers }, env);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ unreadOnly: true }), ORG, USER);
  });

  // 同 reports：查询串里的 'false' 是字符串，`z.coerce.boolean()` 会把它变成 true，
  // 结果是「关掉『只看未读』，列表还是只剩未读」。
  it('reads unreadOnly=false as false', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/notifications?unreadOnly=false', { headers }, env);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ unreadOnly: false }), ORG, USER);
  });

  it('returns the unread count', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request('/api/notifications/unread-count', { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1 });
  });

  it('marks selected notifications as read', async () => {
    const markRead = vi.fn().mockResolvedValue(2);
    const { testApp, env } = setup(repositoryStub({ markRead }));
    const response = await testApp.request(
      '/api/notifications/read',
      { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ ids: ['n1', 'n2'] }) },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 2 });
    expect(markRead).toHaveBeenCalledWith(['n1', 'n2'], ORG, USER);
  });

  it('rejects an empty id list', async () => {
    const markRead = vi.fn();
    const { testApp, env } = setup(repositoryStub({ markRead }));
    const response = await testApp.request(
      '/api/notifications/read',
      { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ ids: [] }) },
      env,
    );
    expect(response.status).toBe(400);
    expect(markRead).not.toHaveBeenCalled();
  });
});
