import { describe, expect, it } from 'vitest';
import { OPS_USER, OPS_VIEWER_USER, call, expectStatus, signToken } from './harness';

/**
 * 运营 billing 域（应收计划与展期），跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明的是「回包形状与拒绝形状都来自库」：201/200 说明四个 RPC 的 jsonb 键名
 * 与 `protocol.ts` 的 row schema 逐字段对齐（否则 `ops_rpc_shape_invalid` → 503）；
 * 403 说明权限按动作码判；400/409 说明 `{status:...}` 信封被 Worker 正确翻译。
 *
 * 用例之间有状态依赖（先建合同并推到 active，才能生成计划），所以同一文件内顺序执行。
 *
 * 两处能力边界如实留空：
 * - **已结清不可展期**（`RECEIVABLE_SETTLED`）：结清需要核销，而核销表属 T-08，
 *  本轮不存在，集成层造不出「已结清」的应收。这条由 pgTAP 直接改
 *  `allocated_amount` 证明（`supabase/tests/ops_billing_domain.sql` 的 E1）。
 * - **核销/退款相关数组**：`allocations[]` / `reversals[]` 恒为空数组，本轮只证明
 *  「缺表时是空数组而不是缺键」。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const RECEIVABLES = '/api/v1/ops/receivables';
const CONTRACTS = '/api/v1/ops/contracts';
const PRODUCTS = '/api/v1/ops/products';
const CUSTOMERS = '/api/v1/ops/customers';

interface ContractBody {
  id: string;
  status: string;
  totalAmount: number;
  version: number;
}

interface ReceivableBody {
  id: string;
  contractId: string;
  contractNo: string;
  customerId: string;
  customer: { id: string; customerNo: string; name: string };
  periodNo: number;
  dueDate: string;
  amount: number;
  currency: string;
  allocatedAmount: number;
  reversedAmount: number;
  outstanding: number;
  status: string;
  version: number;
}

const PRODUCT_CODE = 'REC-INT-001';

let activeContract: ContractBody;
let draftContract: ContractBody;
let createdItems: ReceivableBody[] = [];

describe('应收计划的引用前置（产品 / 客户 / 合同）', () => {
  it('creates the product, customer and an active contract', async () => {
    const product = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: PRODUCT_CODE,
        name: '应收集成产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(product, 201);

    const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '应收集成客户', reason: '应收域集成测试' },
    });
    expectStatus(customer, 201);

    const created = await call<{ contract: ContractBody }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: customer.body.customer.id,
        salesMode: 'saas',
        businessNote: '应收集成主合同',
        items: [{ productId: product.body.product.id, quantity: 3, unitPrice: 4000 }],
      },
    });
    expectStatus(created, 201);
    // 3 × 4000 = 12000：入站没传总额，这个数只能来自库的重算。
    expect(created.body.contract.totalAmount).toBe(12000);

    let contract = created.body.contract;

    const submitted = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${contract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'submit', reason: '提交审批', version: contract.version },
      },
    );
    expectStatus(submitted, 200);
    contract = { ...contract, ...submitted.body.contract };

    const signed = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${contract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          action: 'sign',
          reason: '客户签署',
          signedOn: '2026-11-01',
          version: contract.version,
        },
      },
    );
    expectStatus(signed, 200);
    contract = { ...contract, ...signed.body.contract };

    const activated = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${contract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'activate', reason: '合同生效', version: contract.version },
      },
    );
    expectStatus(activated, 200);
    activeContract = { ...contract, ...activated.body.contract };
    expect(activeContract.status).toBe('active');
  });

  it('creates a draft contract that must not accept a plan', async () => {
    const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '应收草稿客户', reason: '非 active 合同用例' },
    });
    expectStatus(customer, 201);

    const product = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'REC-INT-002',
        name: '应收草稿产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(product, 201);

    const created = await call<{ contract: ContractBody }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: customer.body.customer.id,
        salesMode: 'saas',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 5000 }],
      },
    });
    expectStatus(created, 201);
    draftContract = created.body.contract;
    expect(draftContract.status).toBe('draft');
  });
});

describe('GET /api/v1/ops/receivables', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(RECEIVABLES, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
  });

  it('returns an empty page before any plan exists', async () => {
    const response = await call<{ items: ReceivableBody[]; total: number }>(RECEIVABLES, {
      token: viewerToken,
      query: { contractId: activeContract.id },
    });
    expectStatus(response, 200);
    expect(response.body.total).toBe(0);
    expect(response.body.items).toEqual([]);
  });
});

describe('POST /api/v1/ops/receivables', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: { contractId: activeContract.id, periods: [{ dueDate: '2027-01-31', amount: 12000 }] },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a viewer without receivable.write', async () => {
    const response = await call(RECEIVABLES, {
      method: 'POST',
      token: viewerToken,
      body: { contractId: activeContract.id, periods: [{ dueDate: '2027-01-31', amount: 12000 }] },
    });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a plan whose total does not equal the contract amount', async () => {
    const response = await call(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      body: {
        contractId: activeContract.id,
        periods: [{ dueDate: '2027-01-31', amount: 11999.99 }],
      },
    });
    expectStatus(response, 400);
    // 契约 §6.4 定死的 reason；不给两个数，用户只能自己再算一遍差多少。
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: {
        reason: 'PLAN_TOTAL_MISMATCH',
        plannedTotal: 11999.99,
        contractTotal: 12000,
      },
    });
  });

  it('refuses a plan on a contract that is not active', async () => {
    const response = await call(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      body: { contractId: draftContract.id, periods: [{ dueDate: '2027-01-31', amount: 5000 }] },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTRACT_NOT_ACTIVE', contractStatus: 'draft' },
    });
  });

  it('creates a three-period plan and returns it in camelCase', async () => {
    const response = await call<{ items: ReceivableBody[] }>(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      body: {
        contractId: activeContract.id,
        periods: [
          { dueDate: '2027-01-31', amount: 4000, note: '首期' },
          { dueDate: '2027-04-30', amount: 4000 },
          { dueDate: '2027-07-31', amount: 4000 },
        ],
      },
    });
    expectStatus(response, 201);
    createdItems = response.body.items;
    expect(createdItems).toHaveLength(3);
    expect(createdItems.map((item) => item.periodNo)).toEqual([1, 2, 3]);
    // 币种从合同继承，请求里根本没传。
    expect(createdItems[0].currency).toBe('CNY');
    expect(createdItems[0].contractNo).toBeTruthy();
    expect(createdItems[0].customer.name).toBe('应收集成客户');
  });

  it('refuses a second plan for the same contract', async () => {
    const response = await call(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      body: { contractId: activeContract.id, periods: [{ dueDate: '2027-01-31', amount: 12000 }] },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'PLAN_EXISTS' },
    });
  });
});

describe('GET /api/v1/ops/receivables/{id}', () => {
  it('returns one period with an empty extension and allocation list', async () => {
    const response = await call<{
      receivable: ReceivableBody;
      extensions: unknown[];
      allocations: unknown[];
    }>(`${RECEIVABLES}/${createdItems[0].id}`, { token: viewerToken });
    expectStatus(response, 200);
    expect(response.body.receivable.periodNo).toBe(1);
    expect(response.body.extensions).toEqual([]);
    // T-08 未落地时必须是空数组而不是缺键：前端按 .length 渲染。
    expect(response.body.allocations).toEqual([]);
  });

  it('reports an unknown receivable as 404', async () => {
    const response = await call(`${RECEIVABLES}/00000000-0000-4000-8000-0000000009ff`, {
      token: viewerToken,
    });
    expectStatus(response, 404);
  });
});

describe('列表筛选与汇总', () => {
  it('reports the summary over the whole filtered set, not the current page', async () => {
    const response = await call<{
      total: number;
      summary: {
        totalAmount: number;
        settledAmount: number;
        outstandingAmount: number;
        overdueAmount: number;
      };
    }>(RECEIVABLES, {
      token: viewerToken,
      query: { contractId: activeContract.id, pageSize: '15' },
    });
    expectStatus(response, 200);
    expect(response.body.total).toBe(3);
    expect(response.body.summary).toMatchObject({
      totalAmount: 12000,
      settledAmount: 0,
      outstandingAmount: 12000,
      overdueAmount: 0,
    });
  });

  it('pages without shrinking the total', async () => {
    const response = await call<{ total: number; items: ReceivableBody[] }>(RECEIVABLES, {
      token: viewerToken,
      query: { contractId: activeContract.id, page: '2', pageSize: '15' },
    });
    expectStatus(response, 200);
    // 第 2 页没有数据，但 total 仍是筛选后的 3 条。
    expect(response.body.total).toBe(3);
    expect(response.body.items).toEqual([]);
  });

  it('filters by derived status', async () => {
    const response = await call<{ total: number }>(RECEIVABLES, {
      token: viewerToken,
      query: { contractId: activeContract.id, status: 'upcoming' },
    });
    expectStatus(response, 200);
    expect(response.body.total).toBe(3);
  });
});

describe('POST /api/v1/ops/receivables/{id}/extensions', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${RECEIVABLES}/${createdItems[0].id}/extensions`, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: { newDueDate: '2027-03-31', reason: '客户申请延后', version: 1 },
    });
    expectStatus(response, 400);
  });

  it('refuses a due date that is not later than the current one', async () => {
    const response = await call(`${RECEIVABLES}/${createdItems[0].id}/extensions`, {
      method: 'POST',
      token: opsToken,
      body: { newDueDate: '2027-01-31', reason: '客户申请延后', version: 1 },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'INVALID_DUE_DATE', currentDueDate: '2027-01-31' },
    });
  });

  it('refuses a stale version instead of overwriting a concurrent extension', async () => {
    const response = await call(`${RECEIVABLES}/${createdItems[0].id}/extensions`, {
      method: 'POST',
      token: opsToken,
      body: { newDueDate: '2027-03-31', reason: '客户申请延后', version: 99 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { currentVersion: 1 },
    });
  });

  it('extends the period and keeps the original due date in the history', async () => {
    const response = await call<{
      receivable: ReceivableBody;
      extension: { previousDueDate: string; newDueDate: string; reason: string };
    }>(`${RECEIVABLES}/${createdItems[0].id}/extensions`, {
      method: 'POST',
      token: opsToken,
      body: { newDueDate: '2027-03-31', reason: '客户申请延后', version: 1 },
    });
    expectStatus(response, 200);
    expect(response.body.receivable.dueDate).toBe('2027-03-31');
    expect(response.body.receivable.version).toBe(2);
    expect(response.body.extension.previousDueDate).toBe('2027-01-31');
  });

  it('lists the extension in the detail after the update', async () => {
    const response = await call<{ extensions: unknown[]; receivable: ReceivableBody }>(
      `${RECEIVABLES}/${createdItems[0].id}`,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(response.body.extensions).toHaveLength(1);
    expect(response.body.receivable.status).toBe('upcoming');
  });
});
