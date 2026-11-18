import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, AuditEvent } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { AuditRepository } from './audit-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['audit.read'],
  dataScope: 'all',
};
const operator: AuthContext = { ...admin, role: 'operator', permissions: [] };

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'audit-1',
    actorName: '马总',
    action: 'order.status_changed',
    entityType: 'order',
    entityId: 'order-1',
    summary: 'booking → active',
    ipSummary: '203.0.113.0/24',
    deviceSummary: 'Chrome/120',
    requestId: 'req-1',
    createdAt: '2026-11-19T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [event()], total: 1, page: 1, pageSize: 15 }),
    facets: vi
      .fn()
      .mockResolvedValue({ actions: ['order.status_changed'], entityTypes: ['order'] }),
    ...overrides,
  };
}

function setup(repository: AuditRepository, identity: AuthContext = admin) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (ctx, permission) => ctx.permissions.includes(permission)),
    },
    AUDIT_REPOSITORY: repository,
  };
  return { testApp, env };
}

const headers = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };

describe('audit routes', () => {
  it('lists events with audit.read', async () => {
    const list = vi.fn().mockResolvedValue({ items: [event()], total: 1, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/audit-events', { headers }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: AuditEvent[] };
    expect(body.items[0]).toMatchObject({ action: 'order.status_changed' });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }), ORG);
  });

  it('passes filters through to the repository', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request(
      '/api/audit-events?action=order.status_changed&entityType=order&page=2',
      { headers },
      env,
    );
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.status_changed', entityType: 'order', page: 2 }),
      ORG,
    );
  });

  it('returns distinct facets for the filter panel', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request('/api/audit-events/facets', { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actions: ['order.status_changed'],
      entityTypes: ['order'],
    });
  });

  it('refuses reads without audit.read', async () => {
    const list = vi.fn();
    const { testApp, env } = setup(repositoryStub({ list }), operator);
    const response = await testApp.request('/api/audit-events', { headers }, env);
    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});
