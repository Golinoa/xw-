import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { OrderRecord, OrderRepository } from './order-service';
import { OrderCustomerInvalidError } from './order-service';

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read', 'order.write', 'customer.read', 'customer.write'],
  dataScope: 'all',
};

const financeIdentity: AuthContext = {
  ...adminIdentity,
  role: 'finance',
  permissions: ['order.read', 'customer.read'],
};

const operatorIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  dataScope: 'own',
};

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'order-1',
    orderNumber: 'SO-20261029-000001',
    orderType: 'active',
    status: 'active',
    customerId: 'cust-1',
    customerName: '张三',
    adultCount: 2,
    childCount: 1,
    personCount: 3,
    receivableTotal: 12000,
    payableTotal: 9000,
    profit: 3000,
    receivables: [
      {
        id: 'rec-1',
        name: '团费',
        amount: 12000,
        confirmedAmount: 0,
        pendingAmount: 0,
        availableAmount: 12000,
      },
    ],
    payables: [
      {
        id: 'pay-1',
        name: '地接',
        amount: 9000,
        confirmedAmount: 0,
        pendingAmount: 0,
        availableAmount: 9000,
        supplierId: 'sup-1',
        supplierName: '某地接社',
      },
    ],
    version: 2,
    createdBy: 'user-owner',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<OrderRepository> = {}): OrderRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    transition: vi.fn(),
    ...overrides,
  };
}

function setup(repository: OrderRepository, identity: AuthContext = adminIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    ORDER_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

const createBody = {
  customerId: 'cust-1',
  orderType: 'active',
  adultCount: 2,
  childCount: 1,
  receivables: [{ name: '团费', amount: 12000.5 }],
  payables: [{ name: '地接', amount: 9000, supplierId: 'sup-1' }],
};

describe('order routes', () => {
  it('returns a paged order list', async () => {
    const repository = repositoryStub({
      list: vi.fn().mockResolvedValue({ items: [order()], total: 7 }),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/orders?page=1&pageSize=15&status=active',
      {
        headers: authHeaders,
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      items: Array<{ orderNumber: string; profit: number; personCount: number }>;
    };
    expect(body.total).toBe(7);
    expect(body.items[0]).toMatchObject({
      orderNumber: 'SO-20261029-000001',
      profit: 3000,
      personCount: 3,
    });
  });

  it('restricts the list to the caller when the data scope is own', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }), operatorIdentity);

    await testApp.request('/api/orders', { headers: authHeaders }, env);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'user-owner' }));
  });

  it('creates an order and returns server-side totals', async () => {
    const repository = repositoryStub({ create: vi.fn().mockResolvedValue(order()) });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      order: { receivableTotal: number; profit: number; receivables: unknown[] };
    };
    // 合计来自服务端（数据库重算），不是请求里的行金额相加。
    expect(body.order.receivableTotal).toBe(12000);
    expect(body.order.profit).toBe(3000);
    expect(body.order.receivables).toHaveLength(1);
  });

  it('rejects an amount with more than two decimals', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...createBody,
          receivables: [{ name: '团费', amount: 0.001 }],
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('rejects a return date earlier than the departure date', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...createBody,
          departureDate: '2026-11-10',
          returnDate: '2026-11-01',
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('reports a customer outside the organization as a validation error', async () => {
    const repository = repositoryStub({
      create: vi.fn().mockRejectedValue(new OrderCustomerInvalidError()),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('maps an illegal status transition to ORDER_STATE_CONFLICT', async () => {
    const repository = repositoryStub({
      transition: vi.fn().mockResolvedValue({ ok: false, errorCode: 'ORDER_STATE_CONFLICT' }),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/orders/order-1/transition',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('ORDER_STATE_CONFLICT');
  });

  it('requires a reason before locking an order', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/orders/order-1/transition',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lock', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('maps a stale version to CONFLICT', async () => {
    const repository = repositoryStub({
      transition: vi.fn().mockResolvedValue({ ok: false, errorCode: 'VERSION_CONFLICT' }),
    });
    const { testApp, env } = setup(repository);

    const response = await testApp.request(
      '/api/orders/order-1/transition',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('CONFLICT');
  });

  it('refuses a write for the finance role', async () => {
    const { testApp, env } = setup(repositoryStub(), financeIdentity);

    const response = await testApp.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(403);
  });
});
