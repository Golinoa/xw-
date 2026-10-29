import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, PayableItem, ReceivableItem } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { OrderRecord, OrderRepository } from '../orders/order-service';
import type { FinanceRepository } from './finance-service';

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read', 'order.write', 'customer.read', 'customer.write'],
  dataScope: 'all',
};

const operatorIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  dataScope: 'own',
};

/** 财务角色只有读权限，是「能看不能改」的那一类账号。 */
const financeIdentity: AuthContext = {
  ...adminIdentity,
  role: 'finance',
  permissions: ['order.read', 'organization.read'],
};

/** 没有任何订单读权限：财务明细也不该对他开放。 */
const outsiderIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  permissions: ['customer.read'],
};

/**
 * 真源第 21 节的验收数据：2 成人 1 儿童、应收 7,500、应付 4,800、
 * 一笔收款 3,000、一笔付款 4,800 → 利润 2,700、毛利率 36%、客单价 2,500、
 * 净现金流 −1,800、收款进度 40%、付款进度 100%。
 */
function acceptanceOrder(): OrderRecord {
  return {
    id: 'order-accept',
    orderNumber: 'SO-20261029-000009',
    orderType: 'active',
    status: 'active',
    customerId: 'cust-1',
    customerName: '张三',
    adultCount: 2,
    childCount: 1,
    personCount: 3,
    receivableTotal: 7500,
    payableTotal: 4800,
    profit: 2700,
    receivables: [
      {
        id: 'rec-1',
        name: '团费',
        amount: 7500,
        confirmedAmount: 3000,
        pendingAmount: 0,
        availableAmount: 4500,
      },
    ],
    payables: [
      {
        id: 'pay-1',
        name: '地接',
        amount: 4800,
        confirmedAmount: 4800,
        pendingAmount: 0,
        availableAmount: 0,
        supplierId: 'sup-1',
        supplierName: '某地接社',
      },
    ],
    version: 2,
    createdBy: 'user-owner',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
  };
}

function receivable(overrides: Partial<ReceivableItem> = {}): ReceivableItem {
  return {
    id: 'rec-1',
    orderId: 'order-accept',
    orderNumber: 'SO-20261029-000009',
    orderStatus: 'active',
    customerName: '张三',
    name: '团费',
    amount: 7500,
    confirmedAmount: 3000,
    pendingAmount: 0,
    availableAmount: 4500,
    createdAt: '2026-10-29T00:00:00Z',
    ...overrides,
  };
}

function payable(overrides: Partial<PayableItem> = {}): PayableItem {
  return {
    ...receivable({ id: 'pay-1', name: '地接' }),
    supplierId: 'sup-1',
    supplierName: '某地接社',
    settlement: 'monthly',
    ...overrides,
  };
}

function orderRepositoryStub(overrides: Partial<OrderRepository> = {}): OrderRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    transition: vi.fn(),
    ...overrides,
  };
}

function financeRepositoryStub(overrides: Partial<FinanceRepository> = {}): FinanceRepository {
  return {
    listReceivables: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listPayables: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    ...overrides,
  };
}

function setup(options: {
  orders?: OrderRepository;
  finance?: FinanceRepository;
  identity?: AuthContext;
}) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(options.identity ?? adminIdentity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    ORDER_REPOSITORY: options.orders ?? orderRepositoryStub(),
    FINANCE_REPOSITORY: options.finance ?? financeRepositoryStub(),
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

describe('order finance summary', () => {
  it('matches the acceptance figures from the source spec', async () => {
    const orders = orderRepositoryStub({ findById: vi.fn().mockResolvedValue(acceptanceOrder()) });
    const { testApp, env } = setup({ orders });

    const response = await testApp.request(
      '/api/orders/order-accept/finance',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { finance: Record<string, number | null> };
    expect(body.finance).toMatchObject({
      orderNumber: 'SO-20261029-000009',
      receivableTotal: 7500,
      confirmedReceivable: 3000,
      uncollectedAmount: 4500,
      applicableReceivable: 4500,
      payableTotal: 4800,
      confirmedPayable: 4800,
      unpaidAmount: 0,
      profit: 2700,
      grossMargin: 0.36,
      revenuePerPerson: 2500,
      collectionProgress: 0.4,
      paymentProgress: 1,
      netCashflow: -1800,
    });
  });

  it('returns 404 when the order is outside the caller scope', async () => {
    const { testApp, env } = setup({ orders: orderRepositoryStub() });

    const response = await testApp.request(
      '/api/orders/missing/finance',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('rejects callers without order.read', async () => {
    const orders = orderRepositoryStub({ findById: vi.fn().mockResolvedValue(acceptanceOrder()) });
    const { testApp, env } = setup({ orders, identity: outsiderIdentity });

    const response = await testApp.request(
      '/api/orders/order-accept/finance',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(403);
  });

  it('lets the finance role read the summary', async () => {
    const orders = orderRepositoryStub({ findById: vi.fn().mockResolvedValue(acceptanceOrder()) });
    const { testApp, env } = setup({ orders, identity: financeIdentity });

    const response = await testApp.request(
      '/api/orders/order-accept/finance',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
  });
});

describe('receivable and payable lists', () => {
  it('returns a paged receivable list', async () => {
    const finance = financeRepositoryStub({
      listReceivables: vi.fn().mockResolvedValue({ items: [receivable()], total: 12 }),
    });
    const { testApp, env } = setup({ finance });

    const response = await testApp.request(
      '/api/receivables?page=2&pageSize=20',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      page: number;
      pageSize: number;
      items: Array<{ name: string; amount: number }>;
    };
    expect(body).toMatchObject({ total: 12, page: 2, pageSize: 20 });
    expect(body.items[0]).toMatchObject({ name: '团费', amount: 7500 });
  });

  it('forwards filters to the repository', async () => {
    const listReceivables = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup({ finance: financeRepositoryStub({ listReceivables }) });

    await testApp.request(
      '/api/receivables?orderId=order-accept&outstanding=true&keyword=张三&sort=amount&order=asc',
      { headers: authHeaders },
      env,
    );

    expect(listReceivables).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-accept',
        outstanding: 'true',
        keyword: '张三',
        sort: 'amount',
        order: 'asc',
        organizationId: 'org-alpha',
      }),
    );
  });

  it('does not leak the owner filter into line queries', async () => {
    // 明细没有 created_by，范围只能由 RLS 顺着父订单判定；应用层不该伪造一个 ownerUserId。
    const listReceivables = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup({
      finance: financeRepositoryStub({ listReceivables }),
      identity: operatorIdentity,
    });

    await testApp.request('/api/receivables', { headers: authHeaders }, env);

    expect(listReceivables).toHaveBeenCalledWith(
      expect.not.objectContaining({ ownerUserId: expect.anything() }),
    );
  });

  it('rejects a page size outside the shared whitelist', async () => {
    const { testApp, env } = setup({});

    const response = await testApp.request(
      '/api/receivables?pageSize=999',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(400);
  });

  it('returns payable items with supplier settlement', async () => {
    const finance = financeRepositoryStub({
      listPayables: vi.fn().mockResolvedValue({ items: [payable()], total: 1 }),
    });
    const { testApp, env } = setup({ finance });

    const response = await testApp.request('/api/payables', { headers: authHeaders }, env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      supplierId: 'sup-1',
      supplierName: '某地接社',
      settlement: 'monthly',
    });
  });

  it('forwards the supplier filter to the payable query', async () => {
    const listPayables = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup({ finance: financeRepositoryStub({ listPayables }) });

    await testApp.request('/api/payables?supplierId=sup-9', { headers: authHeaders }, env);

    expect(listPayables).toHaveBeenCalledWith(expect.objectContaining({ supplierId: 'sup-9' }));
  });

  it('rejects receivable access without order.read', async () => {
    const { testApp, env } = setup({ identity: outsiderIdentity });

    const response = await testApp.request('/api/receivables', { headers: authHeaders }, env);

    expect(response.status).toBe(403);
  });
});
