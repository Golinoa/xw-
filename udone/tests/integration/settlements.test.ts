import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

/**
 * 批量结算走真实 PostgREST。
 *
 * 这一层要证明的是 pgTAP 与单测都证明不了的三件事：
 * 1. `create_settlement_batch` 收的 jsonb 键名真的是 camelCase（`payableId`）——
 *    参数名写错不会有编译错误，只会在线上 500，而 pgTAP 直接调函数是绕过这层的；
 * 2. 23505 / 库函数返回的 error_code 经 PostgREST 变成 409 而不是 500；
 * 3. 累计封顶在真实链路里也生效：已结满之后再来一笔会被拒。
 *
 * 每次运行都新建供应商（名字带随机后缀），所以「同月同供应商唯一」不会被上一次运行撞到。
 */

const suffix = Math.random().toString(36).slice(2, 8);

interface CustomerCreated {
  customer: { id: string };
}

interface SupplierCreated {
  supplier: { id: string };
}

interface OrderCreated {
  order: { id: string; payables: Array<{ id: string; name: string }> };
}

interface CandidateList {
  items: Array<{ payableId: string; payableAmount: number; remainingAmount: number }>;
}

interface SettlementDetail {
  settlement: {
    id: string;
    status: string;
    totalAmount: number;
    periodMonth: string;
    supplierName: string;
    items: Array<{ payableId: string; amount: number; confirmed: boolean }>;
  };
}

interface TransitionBody {
  settlementId: string;
  status: string;
  totalAmount: number;
}

interface ErrorBody {
  code?: string;
}

describe('批量结算走真实 PostgREST', () => {
  let supplierId = '';
  let payableId = '';
  let batchId = '';

  it('准备数据：客户、供应商、一张带应付行的订单', async () => {
    const customer = await call<CustomerCreated>('/api/customers', {
      method: 'POST',
      actor: 'operator',
      body: { name: `结算集成客户-${suffix}`, phone: '13800000021' },
    });
    expectStatus(customer, 201);

    const supplier = await call<SupplierCreated>('/api/suppliers', {
      method: 'POST',
      actor: 'operator',
      body: { name: `结算集成地接-${suffix}`, type: 'transport', settlement: 'monthly' },
    });
    expectStatus(supplier, 201);
    supplierId = supplier.body.supplier.id;

    const order = await call<OrderCreated>('/api/orders', {
      method: 'POST',
      actor: 'operator',
      body: {
        customerId: customer.body.customer.id,
        orderType: 'active',
        routeName: `结算集成线路-${suffix}`,
        departureDate: '2027-04-01',
        returnDate: '2027-04-05',
        adultCount: 2,
        childCount: 0,
        receivables: [{ name: '团费', amount: 6000 }],
        payables: [{ name: '地接', amount: 4800, supplierId }],
      },
    });
    expectStatus(order, 201);
    payableId = order.body.order.payables[0]!.id;
  });

  it('待结算候选：新应付行的可结算金额等于应付金额', async () => {
    const response = await call<CandidateList>('/api/settlement-candidates', {
      actor: 'finance',
      query: { supplierId },
    });

    expectStatus(response, 200);
    expect(response.body.items).toEqual([
      expect.objectContaining({ payableId, payableAmount: 4800, remainingAmount: 4800 }),
    ]);
  });

  it('建草稿批次：jsonb 键名与库函数对得上，明细随批次一起写入', async () => {
    const response = await call<SettlementDetail>('/api/settlements', {
      method: 'POST',
      actor: 'finance',
      body: {
        supplierId,
        periodMonth: '2026-12',
        method: 'bank',
        note: '集成测试批次',
        items: [{ payableId, amount: 4800 }],
      },
    });

    expectStatus(response, 201);
    const settlement = response.body.settlement;
    batchId = settlement.id;
    expect(settlement.status).toBe('draft');
    expect(settlement.totalAmount).toBe(4800);
    expect(settlement.periodMonth).toBe('2026-12');
    // 供应商名称是服务端拼的，前端不该自己再查一次。
    expect(settlement.supplierName).toBe(`结算集成地接-${suffix}`);
    expect(settlement.items).toEqual([
      expect.objectContaining({ payableId, amount: 4800, confirmed: false }),
    ]);
  });

  it('同月同供应商再建一个批次：409 而不是 500', async () => {
    const response = await call<ErrorBody>('/api/settlements', {
      method: 'POST',
      actor: 'finance',
      body: {
        supplierId,
        periodMonth: '2026-12',
        method: 'bank',
        items: [{ payableId, amount: 100 }],
      },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('CONFLICT');
  });

  it('确认草稿：真实链路下 RPC 返回 confirmed 与总额', async () => {
    const response = await call<TransitionBody>(`/api/settlements/${batchId}/confirm`, {
      method: 'POST',
      actor: 'finance',
    });

    expectStatus(response, 200);
    expect(response.body).toMatchObject({ status: 'confirmed', totalAmount: 4800 });
  });

  it('确认后候选里不再出现这条应付行', async () => {
    const response = await call<CandidateList>('/api/settlement-candidates', {
      actor: 'finance',
      query: { supplierId },
    });

    expectStatus(response, 200);
    expect(response.body.items).toHaveLength(0);
  });

  it('累计封顶：已结满后再结 1 分钱被拒，且用的是结算专用错误码', async () => {
    const response = await call<ErrorBody>('/api/settlements', {
      method: 'POST',
      actor: 'finance',
      body: {
        supplierId,
        periodMonth: '2027-01',
        method: 'bank',
        items: [{ payableId, amount: 0.01 }],
      },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE');
  });

  it('没有审批权的人不能作废已确认批次：403 而不是 500', async () => {
    const response = await call<ErrorBody>(`/api/settlements/${batchId}/cancel`, {
      method: 'POST',
      actor: 'operator',
      body: { reason: '结错了' },
    });

    expectStatus(response, 403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('管理员作废后额度释放，候选里重新出现这条应付行', async () => {
    const response = await call<TransitionBody>(`/api/settlements/${batchId}/cancel`, {
      method: 'POST',
      actor: 'admin',
      body: { reason: '集成测试回滚' },
    });

    expectStatus(response, 200);
    expect(response.body.status).toBe('cancelled');

    const candidates = await call<CandidateList>('/api/settlement-candidates', {
      actor: 'finance',
      query: { supplierId },
    });
    expect(candidates.body.items).toEqual([
      expect.objectContaining({ payableId, remainingAmount: 4800 }),
    ]);
  });

  it('列表按供应商筛选，返回带供应商名称的批次', async () => {
    const response = await call<{
      items: Array<{ id: string; supplierName: string; status: string }>;
      total: number;
    }>('/api/settlements', { actor: 'finance', query: { supplierId } });

    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.items.find((item) => item.id === batchId)).toMatchObject({
      supplierName: `结算集成地接-${suffix}`,
      status: 'cancelled',
    });
  });
});
