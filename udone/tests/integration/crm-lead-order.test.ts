import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface CreateLeadBody {
  leadId: string;
}

interface LeadDetailBody {
  id: string;
  stage: string;
  version: number;
  convertedCustomerId: string | null;
  convertedOrderId: string | null;
}

interface OrderBody {
  order: {
    id: string;
    orderType: string;
    status: string;
    receivableTotal: number;
    payableTotal: number;
    personCount: number;
    routeName: string | null;
  };
}

interface FunnelBody {
  total: number;
  stages: Record<string, number>;
  convertedCustomers: number;
  convertedOrders: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 建一条线索并推进到 won：转换的前置条件必须由真实业务动作满足，不能直接改库。 */
async function wonLead(phone: string): Promise<LeadDetailBody> {
  const created = await call<CreateLeadBody>('/api/leads', {
    method: 'POST',
    actor: 'admin',
    body: {
      name: `转订单测试 ${phone.slice(-4)}`,
      phone,
      source: '官网',
      destination: '云南',
      departureCity: '上海',
      tripType: '跟团游',
      intentLevel: '高',
      expectedDate: '2026-12-20',
      budgetMin: 3000,
      budgetMax: 6000,
      adultCount: 2,
      childCount: 1,
    },
  });
  expectStatus(created, 200);

  const followed = await call(`/api/leads/follow-up`, {
    method: 'POST',
    actor: 'admin',
    body: { leadId: created.body.leadId, stage: 'won', detail: '客户确认成单' },
  });
  expectStatus(followed, 200);

  const detail = await call<LeadDetailBody>(`/api/leads/${created.body.leadId}`, {
    actor: 'admin',
  });
  expectStatus(detail, 200);
  return detail.body;
}

describe('线索转订单走真实 PostgREST', () => {
  it('won 线索转出预订单：金额为 0 且人数沿用线索', async () => {
    const lead = await wonLead('13900000201');
    expect(lead.stage).toBe('won');
    expect(lead.convertedCustomerId).toBeNull();

    const converted = await call<{ orderId: string }>('/api/leads/convert-order', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: lead.id, version: lead.version },
    });
    expectStatus(converted, 200);
    expect(converted.body.orderId).toBeTruthy();

    const order = await call<OrderBody>(`/api/orders/${converted.body.orderId}`, {
      actor: 'admin',
    });
    expectStatus(order, 200);
    expect(order.body.order.orderType).toBe('booking');
    // 预算区间不是应收：把 3000–6000 写成金额会污染报表与余额
    expect(order.body.order.receivableTotal).toBe(0);
    expect(order.body.order.payableTotal).toBe(0);
    expect(order.body.order.personCount).toBe(3);
    expect(order.body.order.routeName).toBe('云南');

    const after = await call<LeadDetailBody>(`/api/leads/${lead.id}`, { actor: 'admin' });
    expectStatus(after, 200);
    expect(after.body.convertedOrderId).toBe(converted.body.orderId);
    expect(after.body.convertedCustomerId).toBeTruthy();
  });

  it('重复转订单返回同一张，不会建第二张', async () => {
    const lead = await wonLead('13900000202');
    const first = await call<{ orderId: string }>('/api/leads/convert-order', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: lead.id, version: lead.version },
    });
    expectStatus(first, 200);

    const second = await call<{ orderId: string }>('/api/leads/convert-order', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: lead.id, version: lead.version + 5 },
    });
    expectStatus(second, 200);
    expect(second.body.orderId).toBe(first.body.orderId);
  });

  it('未成单的线索不能转订单', async () => {
    const created = await call<CreateLeadBody>('/api/leads', {
      method: 'POST',
      actor: 'admin',
      body: {
        name: '还没谈成',
        phone: '13900000203',
        source: '官网',
        destination: '贵州',
        departureCity: '上海',
        tripType: '跟团游',
        intentLevel: '低',
        expectedDate: '2026-12-21',
        budgetMin: 2000,
        budgetMax: 3000,
        adultCount: 1,
        childCount: 0,
      },
    });
    expectStatus(created, 200);

    const response = await call('/api/leads/convert-order', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: created.body.leadId, version: 1 },
    });
    expectStatus(response, 409);
  });

  it('阶段统计按区间统计新建线索与转化数', async () => {
    const lead = await wonLead('13900000204');
    const converted = await call('/api/leads/convert-order', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: lead.id, version: lead.version },
    });
    expectStatus(converted, 200);

    const day = today();
    const response = await call<FunnelBody>('/api/leads/funnel', {
      actor: 'admin',
      query: { from: day, to: day },
    });
    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.stages.won).toBeGreaterThanOrEqual(1);
    expect(response.body.convertedOrders).toBeGreaterThanOrEqual(1);
  });
});
