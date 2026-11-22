import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, Lead, LeadDetailResponse } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { LeadRepository } from './lead-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read', 'order.write'],
  dataScope: 'all',
};

const lead: Lead = {
  id: 'lead-1',
  name: '测试线索',
  phone: '13800000000',
  wechat: null,
  email: null,
  source: '官网',
  destination: '云南',
  departureCity: '深圳',
  tripType: '跟团游',
  intentLevel: '高',
  expectedDate: '2026-12-20',
  budgetMin: 3000,
  budgetMax: 8000,
  adultCount: 2,
  childCount: 0,
  remark: null,
  stage: 'new',
  ownerId: USER,
  ownerName: '马总',
  nextFollowUpAt: null,
  lastFollowUpAt: null,
  convertedCustomerId: null,
  version: 1,
  createdAt: '2026-11-19T00:00:00Z',
};

function repositoryStub(overrides: Partial<LeadRepository> = {}): LeadRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [lead], total: 1, page: 1, pageSize: 15 }),
    get: vi.fn().mockResolvedValue({ ...lead, events: [] } as LeadDetailResponse),
    create: vi.fn().mockResolvedValue({ leadId: 'lead-2' }),
    followUp: vi.fn().mockResolvedValue(null),
    claim: vi.fn().mockResolvedValue(null),
    assign: vi.fn().mockResolvedValue(null),
    convert: vi.fn().mockResolvedValue({ customerId: 'cust-1' }),
    convertToOrder: vi.fn().mockResolvedValue({ orderId: 'order-9' }),
    funnel: vi.fn().mockResolvedValue({
      from: '2026-11-01',
      to: '2026-11-30',
      total: 2,
      stages: { won: 1, new: 1 },
      convertedCustomers: 1,
      convertedOrders: 1,
    }),
    ...overrides,
  };
}

function setup(repository: LeadRepository) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(admin),
      hasPermission: vi.fn(async (ctx, permission) => ctx.permissions.includes(permission)),
    },
    LEAD_REPOSITORY: repository,
  };
  return { testApp, env };
}

const headers = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

describe('lead routes', () => {
  it('lists leads with the in-pool filter', async () => {
    const list = vi.fn().mockResolvedValue({ items: [lead], total: 1, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/leads?inPool=true', { headers }, env);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ inPool: true }), ORG);
  });

  // 同 reports：'false' 必须解析成 false，否则「只看公海」的复选框会反过来。
  it('reads inPool=false as false', async () => {
    const list = vi.fn().mockResolvedValue({ items: [lead], total: 1, page: 1, pageSize: 15 });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/leads?inPool=false', { headers }, env);
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ inPool: false }), ORG);
  });

  it('creates a lead', async () => {
    const create = vi.fn().mockResolvedValue({ leadId: 'lead-2' });
    const { testApp, env } = setup(repositoryStub({ create }));
    const response = await testApp.request(
      '/api/leads',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: '新线索',
          phone: '13800000001',
          source: '官网',
          destination: '云南',
          departureCity: '深圳',
          tripType: '跟团游',
          intentLevel: '高',
          expectedDate: '2026-12-20',
          budgetMin: 1000,
          budgetMax: 5000,
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ leadId: 'lead-2' });
  });

  it('maps a version conflict to 409', async () => {
    const claim = vi.fn().mockResolvedValue('VERSION_CONFLICT');
    const { testApp, env } = setup(repositoryStub({ claim }));
    const response = await testApp.request(
      '/api/leads/claim',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ leadId: 'lead-1', version: 1 }),
      },
      env,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { details: { reason: string } };
    expect(body.details.reason).toBe('VERSION_MISMATCH');
  });

  it('converts a lead idempotently through the repository', async () => {
    const convert = vi.fn().mockResolvedValue({ customerId: 'cust-1' });
    const { testApp, env } = setup(repositoryStub({ convert }));
    const response = await testApp.request(
      '/api/leads/convert',
      { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ leadId: 'lead-1' }) },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customerId: 'cust-1' });
  });

  it('leaves the budget range check to the database function', async () => {
    const create = vi.fn().mockResolvedValue({ error: 'VALIDATION_ERROR' });
    const { testApp, env } = setup(repositoryStub({ create }));
    const response = await testApp.request(
      '/api/leads',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: '新线索',
          phone: '13800000001',
          source: '官网',
          destination: '云南',
          departureCity: '深圳',
          tripType: '跟团游',
          intentLevel: '高',
          expectedDate: '2026-12-20',
          budgetMin: 5000,
          budgetMax: 1000,
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(create).toHaveBeenCalled();
  });
});

describe('线索转订单与阶段统计', () => {
  it('按区间返回阶段统计', async () => {
    const repository = repositoryStub();
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      '/api/leads/funnel?from=2026-11-01&to=2026-11-30',
      { headers },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 2, convertedOrders: 1 });
    expect(repository.funnel).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-30' }, ORG);
  });

  it('把版本号原样传给转换函数', async () => {
    const repository = repositoryStub();
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      '/api/leads/convert-order',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ leadId: 'lead-1', version: 3 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ orderId: 'order-9' });
    expect(repository.convertToOrder).toHaveBeenCalledWith({ leadId: 'lead-1', version: 3 }, ORG);
  });

  it('未成单的线索转订单返回 409', async () => {
    const repository = repositoryStub({
      convertToOrder: vi.fn().mockResolvedValue({ error: 'STAGE_NOT_WON' }),
    });
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      '/api/leads/convert-order',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ leadId: 'lead-1', version: 1 }),
      },
      env,
    );
    expect(response.status).toBe(409);
  });
});
