import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { SupplierRecord, SupplierRepository } from './supplier-service';
import { SupplierNameConflictError, sanitizeSupplierKeyword } from './supplier-service';

const operatorIdentity: AuthContext = {
  userId: 'user-ops',
  organizationId: 'org-alpha',
  role: 'operator',
  sessionId: 'session-1',
  permissions: ['supplier.read', 'supplier.write'],
  dataScope: 'own',
};

/** 财务能读供应商但要下单才写，用来验证写权限的边界。 */
const financeIdentity: AuthContext = {
  ...operatorIdentity,
  role: 'finance',
  permissions: ['supplier.read'],
};

function supplier(overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: 'sup-1',
    name: '北京地接社',
    type: 'transport',
    contactName: '王经理',
    phone: '13800138000',
    settlement: 'monthly',
    isActive: true,
    remark: undefined,
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<SupplierRepository> = {}): SupplierRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(supplier({ name: '新名字' })),
    delete: vi.fn().mockResolvedValue('not_found'),
    ...overrides,
  };
}

function setup(repository: SupplierRepository, identity: AuthContext = operatorIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    SUPPLIER_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

describe('supplier routes', () => {
  it('lists within the caller organization and echoes pagination', async () => {
    const list = vi.fn().mockResolvedValue({ items: [supplier()], total: 41 });
    const { testApp, env } = setup(repositoryStub({ list }));

    const response = await testApp.request(
      '/api/suppliers?page=3&pageSize=20',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(41);
    expect(body.page).toBe(3);
    expect(body.pageSize).toBe(20);
    // 组织永远取自登录态，不接受查询串传入 —— 否则换个 ?organizationId= 就能跨租户读。
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-alpha' }));
  });

  it('passes keyword, settlement and activeOnly through to the repository', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }));

    await testApp.request(
      '/api/suppliers?keyword=地接&settlement=monthly&activeOnly=false',
      { headers: authHeaders },
      env,
    );

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: '地接', settlement: 'monthly', activeOnly: false }),
    );
  });

  it('treats a missing activeOnly as active-only', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }));

    await testApp.request('/api/suppliers', { headers: authHeaders }, env);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ activeOnly: true }));
  });

  it('creates a supplier and answers 201', async () => {
    const create = vi.fn().mockResolvedValue(supplier());
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/suppliers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '北京地接社', type: 'transport', settlement: 'monthly' }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      'org-alpha',
      expect.objectContaining({ name: '北京地接社', type: 'transport', settlement: 'monthly' }),
    );
  });

  it('reports a duplicate name as 409 CONFLICT', async () => {
    const create = vi.fn().mockRejectedValue(new SupplierNameConflictError());
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/suppliers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '北京地接社', type: 'transport', settlement: 'monthly' }),
      },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses writes for a finance account, which may only read', async () => {
    const create = vi.fn();
    const { testApp, env } = setup(repositoryStub({ create }), financeIdentity);

    const response = await testApp.request(
      '/api/suppliers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '北京地接社', type: 'transport', settlement: 'monthly' }),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('deletes a supplier that nothing references', async () => {
    const remove = vi.fn().mockResolvedValue('deleted');
    const { testApp, env } = setup(repositoryStub({ delete: remove }));

    const response = await testApp.request(
      '/api/suppliers/sup-1',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deletedSupplierId: 'sup-1' });
  });

  it('maps a referenced supplier to 409 OBJECT_REFERENCED, not CONFLICT', async () => {
    // 名字撞了和被引用了是两件事：前者改个名字就行，后者得先去处置应付行。
    const remove = vi.fn().mockResolvedValue('in_use');
    const { testApp, env } = setup(repositoryStub({ delete: remove }));

    const response = await testApp.request(
      '/api/suppliers/sup-1',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'OBJECT_REFERENCED' });
  });

  it('answers 404 when the supplier is not there', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/suppliers/sup-missing',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });
});

describe('supplier keyword sanitizing', () => {
  it('turns PostgREST operators into plain spaces', () => {
    expect(sanitizeSupplierKeyword('地接,(北京)*')).toBe('地接 北京');
  });

  it('never lets a bare percent behave as a wildcard', () => {
    // 不清洗的话 `ilike.*%*` 会命中整张表，等于把「搜索」变成「导出全部供应商」。
    expect(sanitizeSupplierKeyword('%')).toBe('');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(sanitizeSupplierKeyword('  北京   地接  ')).toBe('北京 地接');
  });
});

describe('supplier update', () => {
  it('改名只提交改动的字段，不顺手清空联系人与备注', async () => {
    const repository = repositoryStub();
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      `/api/suppliers/${supplier().id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新名字' }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(repository.update).toHaveBeenCalledWith('org-alpha', supplier().id, { name: '新名字' });
  });

  it('停用单独一次请求', async () => {
    const repository = repositoryStub({
      update: vi.fn().mockResolvedValue(supplier({ isActive: false })),
    });
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      `/api/suppliers/${supplier().id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ supplier: { isActive: false } });
  });

  it('空 PATCH 被契约挡在 400', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request(
      `/api/suppliers/${supplier().id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(response.status).toBe(400);
  });

  it('改到不存在的供应商返回 404', async () => {
    const repository = repositoryStub({ update: vi.fn().mockResolvedValue('not_found') });
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      `/api/suppliers/${supplier().id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '新名字' }),
      },
      env,
    );
    expect(response.status).toBe(404);
  });
});
