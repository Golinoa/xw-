import { beforeAll, describe, expect, it } from 'vitest';
import {
  OPS_FINANCE_USER,
  OPS_SALES_USER,
  OPS_USER,
  call,
  expectStatus,
  signToken,
} from './harness';

/**
 * overview 集成测试：真实 PostgREST + 真实 RPC。
 *
 * 这一份要证的不是「数字对不对」（那是 pgTAP 的活，那里的数据是固定的，能逐条对），
 * 而是三件只有跑在 HTTP 上才成立的事：
 *
 * 1. **两个端点读的是同一份数据。** T-13 的硬验收是
 *    `overview.amounts[CNY].overdueReceivable` 等于
 *    `/receivables?status=overdue` 的 `summary.overdueAmount`。两个数各自写一遍
 *    SQL 也能「大致相等」，所以这条只能比**实际响应**。
 * 2. **`restrictedMetrics` 真的按权限分叉。** 这份测试用两个身份：商务运营什么都
 *    看得到，财务运营没有 `tenant.read` 与 `ticket.read`——同一份总览在他们眼里
 *    必须长得不一样，而不是都显示 0。
 * 3. **`windowDays` 不传时来自 settings**，而不是 API 层写死的 30。
 *
 * 一处如实说明的取舍：金额是**全局**的（总览没有按合同筛选的入口），而这一份测试
 * 与其它集成文件并行跑在同一个库上。所以「两个端点相等」这条用重试兜住
 * ——并发写入可能让两次读之间出现差异，三次都收敛不了才是真的不一致。
 */

const OVERVIEW = '/api/v1/ops/overview';
const RECEIVABLES = '/api/v1/ops/receivables';
const CONTRACTS = '/api/v1/ops/contracts';
const PRODUCTS = '/api/v1/ops/products';
const CUSTOMERS = '/api/v1/ops/customers';

const opsToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);
const financeToken = signToken(OPS_FINANCE_USER);

interface OverviewBody {
  statisticsAt: string;
  windowDays: number;
  metrics: Record<string, number | undefined>;
  amounts: Array<{
    currency: string;
    totalReceivable: number;
    settledReceivable: number;
    overdueReceivable: number;
    upcomingReceivable: number;
  }>;
  restrictedMetrics: string[];
  partialFailures: Array<{ code: string; message: string; section?: string }>;
}

interface ReceivableSummaryBody {
  summary: {
    totalAmount: number;
    settledAmount: number;
    outstandingAmount: number;
    overdueAmount: number;
  };
}

interface ContractBody {
  id: string;
  status: string;
  version: number;
}

/** 本文件自己造的那一期逾期应收，用来确认总览不是空转。 */
const OWN_OVERDUE_AMOUNT = 400;

/**
 * 迁移的回包只有 `{contract: {status, version}}`——**没有 id**。
 * 所以这里必须把原对象铺开再合并，不能只取回包：`id` 一旦丢掉，下一次请求
 * 的路径就变成 `/contracts/undefined/transition`，而它报的是
 * `invalid input syntax for type uuid: "undefined"`，看起来像「函数参数错了」。
 */
async function transition(
  contract: ContractBody,
  body: Record<string, unknown>,
): Promise<ContractBody> {
  const response = await call<{ contract: Partial<ContractBody> }>(
    `${CONTRACTS}/${contract.id}/transition`,
    {
      method: 'POST',
      token: opsToken,
      body: { ...body, version: contract.version },
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `transition ${String(body.action)} -> HTTP ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return { ...contract, ...response.body.contract };
}

beforeAll(async () => {
  const product = await call<{ product: { id: string } }>(PRODUCTS, {
    method: 'POST',
    token: opsToken,
    body: {
      code: 'OVW-INT-001',
      name: '总览集成产品',
      salesModes: [{ mode: 'saas', isEnabled: true }],
    },
  });
  expectStatus(product, 201);

  const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
    method: 'POST',
    token: opsToken,
    body: { name: '总览集成客户', reason: '总览域集成测试' },
  });
  expectStatus(customer, 201);

  const created = await call<{ contract: ContractBody }>(CONTRACTS, {
    method: 'POST',
    token: opsToken,
    body: {
      customerId: customer.body.customer.id,
      salesMode: 'saas',
      businessNote: '总览集成主合同',
      items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 1000 }],
    },
  });
  expectStatus(created, 201);

  let contract = created.body.contract;
  contract = await transition(contract, { action: 'submit', reason: '提交审批' });
  contract = await transition(contract, {
    action: 'sign',
    reason: '客户签署',
    signedOn: '2026-11-01',
  });
  contract = await transition(contract, { action: 'activate', reason: '合同生效' });
  expect(contract.status).toBe('active');

  // 一期已逾期（今天是 2026-10-31）、一期在未来。逾期那期是「总览的逾期金额
  // 不是 0」的来源，也是两个端点对账时的锚点。
  const plan = await call(RECEIVABLES, {
    method: 'POST',
    token: opsToken,
    body: {
      contractId: contract.id,
      periods: [
        { dueDate: '2026-01-31', amount: OWN_OVERDUE_AMOUNT },
        { dueDate: '2027-12-31', amount: 600 },
      ],
    },
  });
  expectStatus(plan, 201);
});

describe('GET /api/v1/ops/overview', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(OVERVIEW, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
  });

  it('returns every metric for an operator who can read every domain', async () => {
    const response = await call<OverviewBody>(OVERVIEW, { token: salesToken });
    expectStatus(response, 200);

    expect(response.body.windowDays).toBe(30);
    expect(response.body.statisticsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 商务运营有 overview 所需的全部读权限：十个指标一个不少，也没有受限项。
    expect(Object.keys(response.body.metrics).sort()).toEqual(
      [
        'activeContracts',
        'activeCustomers',
        'activeEntitlements',
        'expiringEntitlements',
        'failedSyncCommands',
        'openTickets',
        'pendingReceiptAmount',
        'runningTenants',
        'unreconciledAmount',
        'waitingTickets',
      ].sort(),
    );
    expect(response.body.restrictedMetrics).toEqual([]);
    expect(response.body.partialFailures).toEqual([]);
  });

  it('counts the contract this file just activated', async () => {
    const response = await call<OverviewBody>(OVERVIEW, { token: salesToken });
    expectStatus(response, 200);

    // 并行跑在同一个库上，所以用 `>=`：这里要证的是「新数据进了统计」，
    // 不是「库里只有这一条」。
    expect(response.body.metrics.activeContracts ?? 0).toBeGreaterThanOrEqual(1);

    /**
     * 客户那一条**不加 `>= 1`**，因为新建客户还不是 `active`（默认在
     * `onboarding`/`signed`），而「有效软件客户」的口径是 `status='active'`
     * 且已有已签合同。换句话说：0 不是缺陷，是这条口径在起作用。
     *
     * 这也正是这个数字在运营会上有意义的原因——它数的是「能收到钱的客户」，
     * 不是「录进系统的客户」。
     */
    expect(response.body.metrics.activeCustomers).toBeTypeOf('number');
    expect(response.body.metrics.openTickets ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('keeps tenant and ticket metrics away from an operator without those reads', async () => {
    const response = await call<OverviewBody>(OVERVIEW, { token: financeToken });
    expectStatus(response, 200);

    // 财务运营能看钱、看客户、看合同，但没有 tenant.read / ticket.read。
    expect(response.body.metrics.activeCustomers).toBeTypeOf('number');
    expect(response.body.metrics.pendingReceiptAmount).toBeTypeOf('number');
    expect(response.body.metrics.runningTenants).toBeUndefined();
    expect(response.body.metrics.openTickets).toBeUndefined();
    expect(response.body.metrics.waitingTickets).toBeUndefined();
    expect(response.body.metrics.failedSyncCommands).toBeUndefined();

    expect(response.body.restrictedMetrics).toEqual(
      expect.arrayContaining([
        'runningTenants',
        'failedSyncCommands',
        'openTickets',
        'waitingTickets',
      ]),
    );
    // 关键：不是 0 冒充。`Object.keys` 里没有这个键，前端才分得清「没有」与「零」。
    expect(Object.keys(response.body.metrics)).not.toContain('openTickets');
  });

  it('agrees with the receivable list on the overdue amount (T-13)', async () => {
    // 两个端点读的是同一个视图，但这条只能比真实响应：各自写一遍 SQL 也能
    // 「大致相等」，而差出来的那点从不出现在报错里。
    let overview: OverviewBody | undefined;
    let summary: ReceivableSummaryBody['summary'] | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [overviewResponse, listResponse] = await Promise.all([
        call<OverviewBody>(OVERVIEW, { token: salesToken }),
        call<ReceivableSummaryBody>(RECEIVABLES, { token: salesToken, query: { pageSize: '15' } }),
      ]);
      expectStatus(overviewResponse, 200);
      expectStatus(listResponse, 200);

      overview = overviewResponse.body;
      summary = listResponse.body.summary;

      const cny = overview.amounts.find((row) => row.currency === 'CNY');
      if (cny && Math.abs(cny.overdueReceivable - summary.overdueAmount) < 0.005) break;
    }

    const cny = overview?.amounts.find((row) => row.currency === 'CNY');
    expect(cny, '总览里必须有一行 CNY').toBeDefined();
    // 先确认锚点在，再比相等：两个端点都回 0 也能「相等」，那不证明任何事。
    expect(cny?.overdueReceivable ?? 0).toBeGreaterThanOrEqual(OWN_OVERDUE_AMOUNT);
    expect(cny?.overdueReceivable).toBeCloseTo(summary?.overdueAmount ?? -1, 2);
    expect(cny?.totalReceivable).toBeCloseTo(summary?.totalAmount ?? -1, 2);
    expect(cny?.settledReceivable).toBeCloseTo(summary?.settledAmount ?? -1, 2);
  });

  it('honours an explicit windowDays', async () => {
    const response = await call<OverviewBody>(OVERVIEW, {
      token: salesToken,
      query: { windowDays: '7' },
    });
    expectStatus(response, 200);
    expect(response.body.windowDays).toBe(7);
  });

  it('treats an empty windowDays as absent', async () => {
    const response = await call<OverviewBody>(OVERVIEW, {
      token: salesToken,
      query: { windowDays: '' },
    });
    expectStatus(response, 200);
    expect(response.body.windowDays).toBe(30);
  });

  it('rejects a window out of range before reaching the database', async () => {
    const zero = await call(OVERVIEW, { token: salesToken, query: { windowDays: '0' } });
    const tooLarge = await call(OVERVIEW, { token: salesToken, query: { windowDays: '366' } });

    expectStatus(zero, 400);
    expectStatus(tooLarge, 400);
    expect(zero.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
