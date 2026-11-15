import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, TourRoute } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { TourRouteRepository } from './route-service';
import { TourRouteNameConflictError } from './route-service';

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['route.read', 'route.write'],
  dataScope: 'all',
};

/** 财务只有 route.read：能选线路、不能维护线路。 */
const financeIdentity: AuthContext = {
  ...adminIdentity,
  role: 'finance',
  permissions: ['route.read'],
};

function route(overrides: Partial<TourRoute> = {}): TourRoute {
  return {
    id: 'route-1',
    name: '云南六日游',
    routeType: '境内跟团',
    region: '云南',
    departureCity: '杭州',
    days: 6,
    isSelfGroup: false,
    isActive: true,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<TourRouteRepository> = {}): TourRouteRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function setup(repository: TourRouteRepository, identity: AuthContext = adminIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    ROUTE_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

describe('route master data routes', () => {
  it('returns a paged list of active routes by default', async () => {
    const list = vi.fn().mockResolvedValue({ items: [route()], total: 42 });
    const { testApp, env } = setup(repositoryStub({ list }));

    const response = await testApp.request(
      '/api/routes?page=2&pageSize=20&sort=name',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 42, page: 2, pageSize: 20 });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-alpha', activeOnly: true, sort: 'name' }),
    );
  });

  it('includes inactive routes only when the caller asks explicitly', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }));

    await testApp.request('/api/routes?activeOnly=false', { headers: authHeaders }, env);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ activeOnly: false }));
  });

  it('creates a route and returns it', async () => {
    const create = vi.fn().mockResolvedValue(route());
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/routes',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '云南六日游', days: 6 }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      'org-alpha',
      expect.objectContaining({ name: '云南六日游', days: 6 }),
    );
  });

  it('reports a duplicate name as 409 instead of 500', async () => {
    const create = vi.fn().mockRejectedValue(new TourRouteNameConflictError());
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/routes',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '云南六日游' }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('CONFLICT');
  });

  it('rejects an empty patch because it would only touch updated_at', async () => {
    const update = vi.fn().mockResolvedValue(route());
    const { testApp, env } = setup(repositoryStub({ update }));

    const response = await testApp.request(
      '/api/routes/route-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('renames a route and keeps the cleared fields explicit', async () => {
    const update = vi.fn().mockResolvedValue(route({ name: '云南七日游', region: undefined }));
    const { testApp, env } = setup(repositoryStub({ update }));

    const response = await testApp.request(
      '/api/routes/route-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '云南七日游', region: null }),
      },
      env,
    );

    expect(response.status).toBe(200);
    // null 与「不传」必须区分：前者是清空，后者是不修改。
    expect(update).toHaveBeenCalledWith('org-alpha', 'route-1', {
      name: '云南七日游',
      region: null,
    });
  });

  it('returns 404 when the route to update is gone', async () => {
    const { testApp, env } = setup(repositoryStub({ update: vi.fn().mockResolvedValue(null) }));

    const response = await testApp.request(
      '/api/routes/route-x',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    );

    expect(response.status).toBe(404);
  });

  it('deletes a route without checking references', async () => {
    const remove = vi.fn().mockResolvedValue(true);
    const { testApp, env } = setup(repositoryStub({ remove }));

    const response = await testApp.request(
      '/api/routes/route-1',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedRouteId: 'route-1' });
  });

  it('returns 404 when deleting a route from another organization', async () => {
    const { testApp, env } = setup(repositoryStub({ remove: vi.fn().mockResolvedValue(false) }));

    const response = await testApp.request(
      '/api/routes/route-x',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });

  it('lets a read-only role list routes but not create one', async () => {
    const { testApp, env } = setup(repositoryStub(), financeIdentity);

    const listResponse = await testApp.request('/api/routes', { headers: authHeaders }, env);
    expect(listResponse.status).toBe(200);

    const createResponse = await testApp.request(
      '/api/routes',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '云南六日游' }),
      },
      env,
    );
    expect(createResponse.status).toBe(403);
    expect(((await createResponse.json()) as { code: string }).code).toBe('FORBIDDEN');
  });
});
