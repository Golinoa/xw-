import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, SettlementBatch, SettlementBatchDetail } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { SettlementRepository } from './settlement-service';
import { SettlementForbiddenError } from './settlement-service';

const financeIdentity: AuthContext = {
  userId: 'user-finance',
  organizationId: 'org-alpha',
  role: 'finance',
  sessionId: 'session-1',
  permissions: ['order.read', 'finance.write', 'finance.approve'],
  dataScope: 'all',
};

/** 没有 finance.write 的角色：结算页应当连读都读不到。 */
const readerOnlyIdentity: AuthContext = {
  ...financeIdentity,
  role: 'operator',
  permissions: ['order.read'],
};

function batch(overrides: Partial<SettlementBatch> = {}): SettlementBatch {
  return {
    id: 'settlement-1',
    supplierId: 'supplier-1',
    supplierName: '结算地接社',
    periodMonth: '2026-11',
    method: 'bank',
    status: 'draft',
    totalAmount: 4000,
    itemCount: 1,
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:00Z',
    ...overrides,
  };
}

function detail(overrides: Partial<SettlementBatchDetail> = {}): SettlementBatchDetail {
  return {
    ...batch(),
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        orderNumber: 'OD-2026-0001',
        payableId: 'payable-1',
        payableName: '地接',
        amount: 4000,
        confirmed: false,
      },
    ],
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<SettlementRepository> = {}): SettlementRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    candidates: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function setup(repository: SettlementRepository, identity: AuthContext = financeIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    SETTLEMENT_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

describe('settlement routes', () => {
  it('passes the supplier, status and period filters through to the repository', async () => {
    const list = vi.fn().mockResolvedValue({ items: [batch()], total: 1 });
    const { testApp, env } = setup(repositoryStub({ list }));

    const response = await testApp.request(
      '/api/settlements?supplierId=supplier-1&status=confirmed&periodMonth=2026-11&page=2&pageSize=20',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, page: 2, pageSize: 20 });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-alpha',
        supplierId: 'supplier-1',
        status: 'confirmed',
        periodMonth: '2026-11',
      }),
    );
  });

  it('rejects a period that is not a natural month', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { testApp, env } = setup(repositoryStub({ list }));

    const response = await testApp.request(
      '/api/settlements?periodMonth=2026-11-15',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns the created batch with its items in one response', async () => {
    const create = vi.fn().mockResolvedValue({ batchId: 'settlement-1' });
    const get = vi.fn().mockResolvedValue(detail());
    const { testApp, env } = setup(repositoryStub({ create, get }));

    const response = await testApp.request(
      '/api/settlements',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          supplierId: 'supplier-1',
          periodMonth: '2026-11',
          method: 'bank',
          items: [{ payableId: 'payable-1', amount: 4000 }],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { settlement: SettlementBatchDetail };
    expect(body.settlement.items).toHaveLength(1);
    expect(create).toHaveBeenCalledWith(
      'org-alpha',
      expect.objectContaining({ supplierId: 'supplier-1', periodMonth: '2026-11' }),
    );
  });

  it('rejects an empty item list before calling the repository', async () => {
    const create = vi.fn();
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/settlements',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          supplierId: 'supplier-1',
          periodMonth: '2026-11',
          method: 'bank',
          items: [],
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('maps a duplicate month to 409 CONFLICT, not a 500', async () => {
    const { testApp, env } = setup(
      repositoryStub({ create: vi.fn().mockResolvedValue({ error: 'BATCH_EXISTS' }) }),
    );

    const response = await testApp.request(
      '/api/settlements',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          supplierId: 'supplier-1',
          periodMonth: '2026-11',
          method: 'bank',
          items: [{ payableId: 'payable-1', amount: 1 }],
        }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('CONFLICT');
  });

  it('uses the settlement-specific code when the amount exceeds the remaining balance', async () => {
    const { testApp, env } = setup(
      repositoryStub({
        create: vi.fn().mockResolvedValue({ error: 'AMOUNT_EXCEEDS_AVAILABLE' }),
      }),
    );

    const response = await testApp.request(
      '/api/settlements',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          supplierId: 'supplier-1',
          periodMonth: '2026-11',
          method: 'bank',
          items: [{ payableId: 'payable-1', amount: 5000 }],
        }),
      },
      env,
    );

    expect(response.status).toBe(409);
    // 不复用 FINANCE_AMOUNT_EXCEEDS_AVAILABLE：那个文案说的是「可申请余额」。
    expect(((await response.json()) as { code: string }).code).toBe(
      'SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE',
    );
  });

  it('reports a payable from another supplier as a validation error', async () => {
    const { testApp, env } = setup(
      repositoryStub({ create: vi.fn().mockResolvedValue({ error: 'SUPPLIER_MISMATCH' }) }),
    );

    const response = await testApp.request(
      '/api/settlements',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          supplierId: 'supplier-1',
          periodMonth: '2026-11',
          method: 'bank',
          items: [{ payableId: 'payable-x', amount: 1 }],
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('confirms a batch and echoes the confirmed total', async () => {
    const confirm = vi.fn().mockResolvedValue({ status: 'confirmed', totalAmount: 4000 });
    const { testApp, env } = setup(repositoryStub({ confirm }));

    const response = await testApp.request(
      '/api/settlements/settlement-1/confirm',
      { method: 'POST', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settlementId: 'settlement-1',
      status: 'confirmed',
      totalAmount: 4000,
    });
  });

  it('reports confirming twice as a settlement state conflict', async () => {
    const { testApp, env } = setup(
      repositoryStub({ confirm: vi.fn().mockResolvedValue({ error: 'STATE_CONFLICT' }) }),
    );

    const response = await testApp.request(
      '/api/settlements/settlement-1/confirm',
      { method: 'POST', headers: authHeaders },
      env,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('SETTLEMENT_STATE_CONFLICT');
  });

  it('turns the database 42501 into 403 instead of 500', async () => {
    const { testApp, env } = setup(
      repositoryStub({ cancel: vi.fn().mockRejectedValue(new SettlementForbiddenError()) }),
    );

    const response = await testApp.request(
      '/api/settlements/settlement-1/cancel',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ reason: '结错了' }),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('FORBIDDEN');
  });

  it('cancels a draft and returns the (unchanged) total for the receipt', async () => {
    const cancel = vi.fn().mockResolvedValue({ status: 'cancelled' });
    const get = vi.fn().mockResolvedValue(detail({ status: 'cancelled', cancelReason: '结错了' }));
    const { testApp, env } = setup(repositoryStub({ cancel, get }));

    const response = await testApp.request(
      '/api/settlements/settlement-1/cancel',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ reason: '结错了' }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('org-alpha', 'settlement-1', '结错了');
    expect(await response.json()).toMatchObject({ status: 'cancelled', totalAmount: 4000 });
  });

  it('returns 404 for a batch outside the organization', async () => {
    const { testApp, env } = setup(repositoryStub({ get: vi.fn().mockResolvedValue(null) }));

    const response = await testApp.request(
      '/api/settlements/settlement-x',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });

  it('lists settlement candidates for the chosen supplier', async () => {
    const candidates = vi.fn().mockResolvedValue([
      {
        payableId: 'payable-1',
        orderId: 'order-1',
        orderNumber: 'OD-2026-0001',
        orderStatus: 'booking',
        payableName: '地接',
        supplierId: 'supplier-1',
        payableAmount: 4000,
        settledAmount: 0,
        remainingAmount: 4000,
      },
    ]);
    const { testApp, env } = setup(repositoryStub({ candidates }));

    const response = await testApp.request(
      '/api/settlement-candidates?supplierId=supplier-1',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    expect(candidates).toHaveBeenCalledWith('org-alpha', 'supplier-1');
    expect(await response.json()).toMatchObject({
      items: [expect.objectContaining({ payableId: 'payable-1', remainingAmount: 4000 })],
    });
  });

  it('hides every settlement endpoint behind finance.write', async () => {
    const { testApp, env } = setup(repositoryStub(), readerOnlyIdentity);

    for (const path of [
      '/api/settlements',
      '/api/settlement-candidates?supplierId=supplier-1',
      '/api/settlements/settlement-1',
    ]) {
      const response = await testApp.request(path, { headers: authHeaders }, env);
      expect(response.status).toBe(403);
    }
  });
});
