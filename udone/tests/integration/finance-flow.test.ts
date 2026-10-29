import { describe, expect, it } from 'vitest';
import { call, expectStatus, ORG_ID, USERS } from './harness';

/**
 * 收付款主线的 HTTP 集成测试。
 *
 * 与单测的分工：单测证明「给定 PostgREST 返回 X，服务层会做 Y」；这里证明
 * 「PostgREST 真的会返回 X」。后者此前完全空白——服务层对 RPC 的参数名、
 * 返回列名、以及 SQLSTATE→HTTP 状态码的映射，全靠一次性探针手工验过，
 * 探针不入库，等于没有回归保护。
 *
 * 一个文件跑完整条链路，因为每一步都依赖上一步写下的真实数据。
 * 角色分工也是真实的：操作员建单并提交申请（数据范围 own），
 * 财务审批第一级，管理员终审。
 */

interface CustomerCreated {
  customer: { id: string; name: string };
}

interface SupplierCreated {
  supplier: { id: string };
}

interface OrderCreated {
  order: {
    id: string;
    receivableTotal: number;
    payableTotal: number;
    profit: number;
    receivables: Array<{ id: string }>;
    payables: Array<{ id: string }>;
  };
}

interface FinanceSummary {
  finance: {
    applicableReceivable: number;
    applicablePayable: number;
    confirmedReceivable: number;
    pendingReceivable: number;
    confirmedPayable: number;
    pendingPayable: number;
  };
}

interface ApplicationEnvelope {
  application: {
    id: string;
    kind: string;
    status: string;
    currentStep: number;
    version: number;
    amount: number;
  };
}

interface ApplicationList {
  items: unknown[];
  total: number;
}

interface ErrorBody {
  code?: string;
}

describe('收付款申请走真实 PostgREST', () => {
  let customerId = '';
  let supplierId = '';
  let orderId = '';
  let receivableId = '';
  let payableId = '';
  let applicationId = '';
  let applicationVersion = 0;

  it('创建客户：走 REST 插入并回读', async () => {
    const response = await call<CustomerCreated>('/api/customers', {
      method: 'POST',
      actor: 'operator',
      body: { name: '集成测试客户', phone: '13800000001' },
    });

    expectStatus(response, 201);
    customerId = response.body.customer.id;
    expect(customerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.customer.name).toBe('集成测试客户');
  });

  it('创建供应商', async () => {
    const response = await call<SupplierCreated>('/api/suppliers', {
      method: 'POST',
      actor: 'operator',
      body: { name: '集成测试地接', type: 'other' },
    });

    expectStatus(response, 201);
    supplierId = response.body.supplier.id;
    expect(supplierId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('创建订单：事务函数把明细与合计一次写完', async () => {
    const response = await call<OrderCreated>('/api/orders', {
      method: 'POST',
      actor: 'operator',
      body: {
        customerId,
        orderType: 'active',
        routeName: '集成测试线路',
        departureDate: '2027-01-05',
        returnDate: '2027-01-09',
        adultCount: 2,
        childCount: 0,
        receivables: [{ name: '团费', amount: 7500 }],
        payables: [{ name: '地接', amount: 4800, supplierId }],
      },
    });

    expectStatus(response, 201);
    const order = response.body.order;
    orderId = order.id;
    receivableId = order.receivables[0]!.id;
    payableId = order.payables[0]!.id;
    expect(order.receivableTotal).toBe(7500);
    expect(order.payableTotal).toBe(4800);
    // 服务端拥有金额：利润是生成列，不是前端算的。
    expect(order.profit).toBe(2700);
  });

  it('订单财务汇总：可申请余额等于原始金额', async () => {
    const response = await call<FinanceSummary>(`/api/orders/${orderId}/finance`, {
      actor: 'admin',
    });

    expectStatus(response, 200);
    expect(response.body.finance.applicableReceivable).toBe(7500);
    expect(response.body.finance.applicablePayable).toBe(4800);
    expect(response.body.finance.confirmedReceivable).toBe(0);
  });

  it('提交收款申请：在途占额度但不计已收', async () => {
    const response = await call<ApplicationEnvelope>('/api/finance-applications', {
      method: 'POST',
      actor: 'operator',
      body: {
        kind: 'receipt',
        orderId,
        lineId: receivableId,
        amount: 3000,
        method: 'bank',
        occurredOn: '2027-01-06',
        referenceNo: 'RC-0001',
      },
    });

    expectStatus(response, 201);
    const application = response.body.application;
    applicationId = application.id;
    applicationVersion = application.version;
    expect(application.status).toBe('pending');
    expect(application.currentStep).toBe(1);
    expect(application.amount).toBe(3000);

    // 钱没到账：已收仍为 0，在途 3000，可申请余额扣掉在途。
    const finance = await call<FinanceSummary>(`/api/orders/${orderId}/finance`, {
      actor: 'admin',
    });
    expect(finance.body.finance.confirmedReceivable).toBe(0);
    expect(finance.body.finance.pendingReceivable).toBe(3000);
    expect(finance.body.finance.applicableReceivable).toBe(4500);
  });

  it('列表分页：total 来自 Content-Range 而不是数组长度', async () => {
    const response = await call<ApplicationList>('/api/finance-applications', {
      actor: 'admin',
      query: { status: 'pending', page: '2', pageSize: '10' },
    });

    expectStatus(response, 200);
    // 第二页没有数据，但总数仍是 1：total 只能来自 Content-Range，
    // 用 items.length 顶替的实现这里会得到 0。
    expect(response.body.items).toHaveLength(0);
    expect(response.body.total).toBe(1);
  });

  it('没有审批权限的人被数据库拒绝，且返回 403 而不是 500', async () => {
    // 操作员有 finance.write 但没有 finance.approve；
    // SQLSTATE 42501 经 PostgREST 变成 403，服务层必须把它翻成 FORBIDDEN。
    const response = await call<ErrorBody>(`/api/finance-applications/${applicationId}`, {
      method: 'PATCH',
      actor: 'operator',
      body: { action: 'approve', version: applicationVersion },
    });

    expectStatus(response, 403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('财务通过第一级：仍在途，只推进级次', async () => {
    const response = await call<ApplicationEnvelope>(`/api/finance-applications/${applicationId}`, {
      method: 'PATCH',
      actor: 'finance',
      body: { action: 'approve', version: applicationVersion, opinion: '金额与合同一致' },
    });

    expectStatus(response, 200);
    const application = response.body.application;
    expect(application.status).toBe('pending');
    expect(application.currentStep).toBe(2);
    expect(application.version).toBe(applicationVersion + 1);

    const finance = await call<FinanceSummary>(`/api/orders/${orderId}/finance`, {
      actor: 'admin',
    });
    expect(finance.body.finance.confirmedReceivable).toBe(0);
    expect(finance.body.finance.pendingReceivable).toBe(3000);
  });

  it('拿旧版本号审批被拒：并发两个人同时点，只有一个能成', async () => {
    const response = await call<ErrorBody>(`/api/finance-applications/${applicationId}`, {
      method: 'PATCH',
      actor: 'admin',
      body: { action: 'approve', version: applicationVersion },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('CONFLICT');
  });

  it('管理员终审：在途转已收，金额落到明细行', async () => {
    const response = await call<ApplicationEnvelope>(`/api/finance-applications/${applicationId}`, {
      method: 'PATCH',
      actor: 'admin',
      body: { action: 'approve', version: applicationVersion + 1 },
    });

    expectStatus(response, 200);
    expect(response.body.application.status).toBe('approved');
    applicationVersion = response.body.application.version;

    const finance = await call<FinanceSummary>(`/api/orders/${orderId}/finance`, {
      actor: 'admin',
    });
    expect(finance.body.finance.confirmedReceivable).toBe(3000);
    expect(finance.body.finance.pendingReceivable).toBe(0);
    expect(finance.body.finance.applicableReceivable).toBe(4500);
  });

  it('超过可申请余额被拒：额度校验在事务里，不在前端', async () => {
    const response = await call<ErrorBody>('/api/finance-applications', {
      method: 'POST',
      actor: 'operator',
      body: {
        kind: 'receipt',
        orderId,
        lineId: receivableId,
        amount: 4500.01,
        method: 'bank',
        occurredOn: '2027-01-07',
      },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('FINANCE_AMOUNT_EXCEEDS_AVAILABLE');
  });

  it('同人审批被拒：自己提交的申请不能自己批', async () => {
    // 管理员既有 finance.write 也有 finance.approve，正好构成自审场景。
    const created = await call<ApplicationEnvelope>('/api/finance-applications', {
      method: 'POST',
      actor: 'admin',
      body: {
        kind: 'receipt',
        orderId,
        lineId: receivableId,
        amount: 100,
        method: 'cash',
        occurredOn: '2027-01-08',
      },
    });
    expectStatus(created, 201);

    const decided = await call<ErrorBody>(
      `/api/finance-applications/${created.body.application.id}`,
      {
        method: 'PATCH',
        actor: 'admin',
        body: { action: 'approve', version: created.body.application.version },
      },
    );

    expectStatus(decided, 403);
    expect(decided.body.code).toBe('FINANCE_SELF_APPROVAL_FORBIDDEN');
  });

  it('付款路径与收款对称：在途走应付侧', async () => {
    const response = await call<ApplicationEnvelope>('/api/finance-applications', {
      method: 'POST',
      actor: 'finance',
      body: {
        kind: 'payment',
        orderId,
        lineId: payableId,
        amount: 2000,
        method: 'bank',
        occurredOn: '2027-01-08',
      },
    });

    expectStatus(response, 201);
    expect(response.body.application.kind).toBe('payment');

    const finance = await call<FinanceSummary>(`/api/orders/${orderId}/finance`, {
      actor: 'admin',
    });
    expect(finance.body.finance.pendingPayable).toBe(2000);
    expect(finance.body.finance.confirmedPayable).toBe(0);
    expect(finance.body.finance.applicablePayable).toBe(2800);
  });

  it('跨租户读不到：RLS 在真实 JWT 下生效', async () => {
    // 同一用户、换一个不属于他的组织 id。current_organization_id() 返回 null，
    // 详情接口应当查不到，而不是把别人的数据交出去。
    const response = await call<ErrorBody>(`/api/finance-applications/${applicationId}`, {
      actor: 'admin',
      organizationId: 'b0000000-0000-4000-8000-000000000099',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('组织 id 就是夹具里那一个：确认测试没有跑在别的租户上', () => {
    expect(ORG_ID).toBe('a0000000-0000-4000-8000-000000000001');
    expect(new Set(Object.values(USERS)).size).toBe(3);
  });
});
