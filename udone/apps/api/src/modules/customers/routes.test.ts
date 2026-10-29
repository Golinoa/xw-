import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { CustomerRecord, CustomerRepository } from './customer-service';
import { CustomerTagInvalidError } from './customer-service';

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['customer.read', 'customer.write', 'customer.sensitive.read'],
  dataScope: 'all',
};

/** 财务只有 customer.read，用来验证掩码与写权限拒绝。 */
const financeIdentity: AuthContext = {
  ...adminIdentity,
  role: 'finance',
  permissions: ['customer.read'],
};

/** 计调员数据范围是 own，用来验证列表会带上本人过滤条件。 */
const operatorIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  dataScope: 'own',
};

function record(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: 'cust-1',
    name: '张三',
    phone: '13800138000',
    email: 'zhangsan@example.com',
    idType: 'id_card',
    idNumber: '110101199001011234',
    birthday: '1990-01-01',
    tags: [{ id: 'tag-1', name: 'VIP', color: '#1b2a4a' }],
    version: 1,
    createdBy: 'user-owner',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<CustomerRepository> = {}): CustomerRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    findById: vi.fn().mockResolvedValue(null),
    findDuplicatesByPhone: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(false),
    assertTagsBelongToOrganization: vi.fn().mockResolvedValue(undefined),
    listTags: vi.fn().mockResolvedValue([]),
    createTag: vi.fn(),
    ...overrides,
  };
}

function setup(repository: CustomerRepository, identity: AuthContext = adminIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    CUSTOMER_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

describe('customer routes', () => {
  it('returns a paged list without exposing raw phone numbers', async () => {
    const repository = repositoryStub({
      list: vi.fn().mockResolvedValue({ items: [record()], total: 42 }),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/customers?page=2&pageSize=20&sort=name',
      {
        headers: authHeaders,
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ total: 42, page: 2, pageSize: 20 });
    expect(body.items).toEqual([
      {
        id: 'cust-1',
        name: '张三',
        phoneMasked: '138****8000',
        emailMasked: 'zh***@example.com',
        tags: [{ id: 'tag-1', name: 'VIP', color: '#1b2a4a' }],
        createdAt: '2026-10-29T00:00:00Z',
        updatedAt: '2026-10-29T00:00:00Z',
      },
    ]);
  });

  it('restricts the list to the caller when the data scope is own', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }), operatorIdentity);

    await testApp.request('/api/customers', { headers: authHeaders }, env);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-owner' }));
  });

  it('rejects a page size outside the allowed options', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/customers?pageSize=7',
      {
        headers: authHeaders,
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('creates a customer and reports same-phone candidates without blocking', async () => {
    const repository = repositoryStub({
      create: vi.fn().mockResolvedValue(record()),
      findDuplicatesByPhone: vi
        .fn()
        .mockResolvedValue([record({ id: 'cust-other', name: '李四' })]),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/customers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三', phone: '13800138000', tagIds: ['tag-1'] }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      customer: { phone?: string; phoneMasked?: string };
      duplicates: Array<{ id: string; phoneMasked?: string }>;
    };
    expect(body.customer.phone).toBe('13800138000');
    expect(body.customer.phoneMasked).toBe('138****8000');
    expect(body.duplicates).toEqual([
      {
        id: 'cust-other',
        name: '李四',
        phoneMasked: '138****8000',
        createdAt: '2026-10-29T00:00:00Z',
      },
    ]);
    expect(repository.assertTagsBelongToOrganization).toHaveBeenCalledWith('org-alpha', ['tag-1']);
  });

  it('rejects a customer without a name', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/customers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000' }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('rejects an identifier supplied without its type', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/customers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三', idNumber: '110101199001011234' }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('rejects tags that do not belong to the organization', async () => {
    const repository = repositoryStub({
      assertTagsBelongToOrganization: vi
        .fn()
        .mockRejectedValue(new CustomerTagInvalidError(['tag-x'])),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/customers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三', tagIds: ['tag-x'] }),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; details?: { invalidTagIds: string[] } };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details?.invalidTagIds).toEqual(['tag-x']);
  });

  it('hides the customer from another tenant as not found', async () => {
    const { testApp, env } = setup(repositoryStub({ findById: vi.fn().mockResolvedValue(null) }));

    const response = await testApp.request(
      '/api/customers/cust-others',
      {
        headers: authHeaders,
      },
      env,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('omits raw sensitive fields for a role without the sensitive permission', async () => {
    const repository = repositoryStub({ findById: vi.fn().mockResolvedValue(record()) });
    const { testApp, env } = setup(repository, financeIdentity);

    const response = await testApp.request('/api/customers/cust-1', { headers: authHeaders }, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      customer: {
        phone?: string;
        phoneMasked?: string;
        idNumber?: string;
        idNumberMasked?: string;
      };
    };
    expect(body.customer.phone).toBeUndefined();
    expect(body.customer.idNumber).toBeUndefined();
    expect(body.customer.phoneMasked).toBe('138****8000');
    expect(body.customer.idNumberMasked).toBe('11**************34');
  });

  it('refuses a write for a read-only role', async () => {
    const { testApp, env } = setup(repositoryStub(), financeIdentity);

    const response = await testApp.request(
      '/api/customers',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三' }),
      },
      env,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('rejects an update built on a stale version', async () => {
    const { testApp, env } = setup(
      repositoryStub({ findById: vi.fn().mockResolvedValue(record({ version: 3 })) }),
    );

    const response = await testApp.request(
      '/api/customers/cust-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三改', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('CONFLICT');
  });

  it('updates a customer and returns the new version', async () => {
    const repository = repositoryStub({
      findById: vi.fn().mockResolvedValue(record({ version: 2 })),
      update: vi.fn().mockResolvedValue(record({ name: '张三改', version: 3 })),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/customers/cust-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三改', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { customer: { name: string; version: number } };
    expect(body.customer).toMatchObject({ name: '张三改', version: 3 });
    expect(repository.update).toHaveBeenCalledWith('org-alpha', 'cust-1', 2, { name: '张三改' });
  });

  it('soft deletes a customer and reports the deleted identifier', async () => {
    const { testApp, env } = setup(repositoryStub({ softDelete: vi.fn().mockResolvedValue(true) }));

    const response = await testApp.request(
      '/api/customers/cust-1',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deletedCustomerId: 'cust-1' });
  });

  it('reports a missing customer on delete instead of a silent success', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/customers/cust-1',
      { method: 'DELETE', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });
});
