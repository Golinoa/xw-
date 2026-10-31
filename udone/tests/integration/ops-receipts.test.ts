import { describe, expect, it } from 'vitest';
import {
  OPS_FINANCE_USER,
  OPS_USER,
  OPS_VIEWER_USER,
  call,
  expectStatus,
  signToken,
} from './harness';

/**
 * 运营 billing 下半（收款 / 核销 / 退款），跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明三件事：
 *
 * 1. **回包形状来自库。** 201/200 说明 `receipt_json` / `refund_json` /
 *    `allocation_json` 的 jsonb 键名与 `protocol.ts` 的 row schema 逐字段对齐；
 *    对不上就是 `ops_rpc_shape_invalid` → 503，而不是悄悄少一个字段。
 * 2. **拒绝形状来自库。** 六个 reason 各有各的状态码：职责分离 403、
 *    超额 409、跨客户 400。前端按不同分支处理，弄反了界面就给错提示。
 * 3. **余额是事务内的真实值。** 核销后应收的 `allocatedAmount`、撤销后的
 *    `reversedAmount`、退满后收款的 `refunded`，全部读回来比对。
 *
 * 顺序依赖（同一文件内顺序执行）：先建产品/客户/合同并推到 active，才能生成
 * 应收计划；先有收款，才有核销与退款。
 *
 * 一处能力边界：**登记人自审**这条只能证明「被挡住」（403），不能证明「换个人
 * 能通过」——除非夹具里有两个财务。所以本地夹具加了 `OPS_FINANCE_USER`
 * （`finance_ops`），审核之后的整条链路才跑得下去。
 */

const opsToken = signToken(OPS_USER);
const financeToken = signToken(OPS_FINANCE_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const RECEIPTS = '/api/v1/ops/receipts';
const REFUNDS = '/api/v1/ops/refunds';
const RECEIVABLES = '/api/v1/ops/receivables';
const CONTRACTS = '/api/v1/ops/contracts';
const PRODUCTS = '/api/v1/ops/products';
const CUSTOMERS = '/api/v1/ops/customers';

interface ReceiptBody {
  id: string;
  receiptNo: string;
  status: string;
  amount: number;
  currency: string;
  allocatedAmount: number;
  refundableAmount: number;
  version: number;
  method: { code: string; label: string };
  recordedBy: { id: string; displayName: string } | null;
  approvedBy: { id: string; displayName: string } | null;
}

interface RefundBody {
  id: string;
  refundNo: string;
  status: string;
  amount: number;
  version: number;
}

interface ReceivableBody {
  id: string;
  periodNo: number;
  amount: number;
  allocatedAmount: number;
  reversedAmount: number;
  outstanding: number;
  status: string;
}

interface AllocationBody {
  id: string;
  receiptId: string;
  receiptNo: string;
  receivableId: string;
  periodNo: number;
  amount: number;
  reversedAmount: number;
}

interface ReceiptDetailBody {
  receipt: ReceiptBody;
  allocations: AllocationBody[];
  reversals: Array<{ id: string; amount: number }>;
  refunds: RefundBody[];
}

let customerId: string;
let contractId: string;
let firstPeriod: ReceivableBody;
let secondPeriod: ReceivableBody;

let receipt: ReceiptBody;
let firstAllocation: AllocationBody;

describe('收款链路的引用前置（产品 / 客户 / 合同 / 应收计划）', () => {
  it('creates an active contract with a two period plan', async () => {
    const product = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'RCP-INT-001',
        name: '收款集成产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(product, 201);

    const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '收款集成客户', reason: '收款域集成测试' },
    });
    expectStatus(customer, 201);
    customerId = customer.body.customer.id;

    const created = await call<{ contract: { id: string; status: string; version: number } }>(
      CONTRACTS,
      {
        method: 'POST',
        token: opsToken,
        body: {
          customerId,
          salesMode: 'saas',
          businessNote: '收款集成主合同',
          items: [{ productId: product.body.product.id, quantity: 3, unitPrice: 4000 }],
        },
      },
    );
    expectStatus(created, 201);

    let contract = created.body.contract;
    for (const action of ['submit', 'sign', 'activate'] as const) {
      const moved = await call<{ contract: { id: string; status: string; version: number } }>(
        `${CONTRACTS}/${contract.id}/transition`,
        {
          method: 'POST',
          token: opsToken,
          body: {
            action,
            reason: `收款测试：${action}`,
            version: contract.version,
            ...(action === 'sign' ? { signedOn: '2026-01-01' } : {}),
          },
        },
      );
      expectStatus(moved, 200);
      contract = { ...contract, ...moved.body.contract };
    }
    expect(contract.status).toBe('active');
    contractId = contract.id;

    const plan = await call<{ items: ReceivableBody[] }>(RECEIVABLES, {
      method: 'POST',
      token: opsToken,
      body: {
        contractId,
        periods: [
          { dueDate: '2026-01-10', amount: 8000 },
          { dueDate: '2026-02-10', amount: 4000 },
        ],
      },
    });
    expectStatus(plan, 201);
    expect(plan.body.items).toHaveLength(2);
    [firstPeriod, secondPeriod] = plan.body.items;
  });
});

describe('POST /api/v1/ops/receipts', () => {
  it('refuses a request without an Idempotency-Key header', async () => {
    const response = await call(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: {
        customerId,
        transactionDate: '2026-01-05',
        amount: 100,
        currency: 'CNY',
        methodCode: 'bank_transfer',
        reason: '缺幂等键',
      },
    });

    expectStatus(response, 400);
    // 全局幂等中间件对缺键放行，所以这条 400 只能由 handler 给出。
    expect(JSON.stringify(response.body)).toContain('Idempotency-Key');
  });

  it('records a receipt for the customer', async () => {
    const response = await call<{ receipt: ReceiptBody; duplicateWarnings: unknown[] }>(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractId,
        transactionDate: '2026-01-05',
        amount: 8000,
        currency: 'CNY',
        methodCode: 'bank_transfer',
        referenceNo: 'BK-INT-0001',
        voucherRef: 'VCH-INT-0001',
        reason: '收到首期款',
      },
    });

    expectStatus(response, 201);
    expect(response.body.receipt.status).toBe('recorded');
    expect(response.body.receipt.receiptNo).toMatch(/^SK-\d{6}$/);
    expect(response.body.receipt.allocatedAmount).toBe(0);
    expect(response.body.receipt.recordedBy?.displayName).toBeTruthy();
    expect(response.body.duplicateWarnings).toEqual([]);
    receipt = response.body.receipt;
  });

  it('flags the same reference instead of refusing it when the amount differs', async () => {
    const response = await call<{ receipt: ReceiptBody; duplicateWarnings: unknown[] }>(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractId,
        transactionDate: '2026-01-06',
        amount: 600,
        currency: 'CNY',
        methodCode: 'bank_transfer',
        referenceNo: 'BK-INT-0001',
        reason: '同流水号但金额不同',
      },
    });

    expectStatus(response, 201);
    // 银行流水号会重号，硬拒会逼财务把真实的第二笔改成假流水号才能入账。
    expect(response.body.duplicateWarnings).toHaveLength(1);
  });

  it('refuses a byte-for-byte duplicate with 409', async () => {
    const response = await call(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractId,
        transactionDate: '2026-01-05',
        amount: 8000,
        currency: 'CNY',
        methodCode: 'bank_transfer',
        referenceNo: 'BK-INT-0001',
        reason: '同一笔钱录第二遍',
      },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a currency that disagrees with the contract', async () => {
    const response = await call(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractId,
        transactionDate: '2026-01-07',
        amount: 100,
        currency: 'USD',
        methodCode: 'cash',
        reason: '币种不符',
      },
    });

    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('审核与职责分离', () => {
  it('forbids the recorder from approving their own receipt', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'approve', reason: '自己审自己', version: receipt.version },
    });

    expectStatus(response, 403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { rule: 'SEGREGATION_OF_DUTY' },
    });
  });

  it('lets a second finance operator approve it', async () => {
    const response = await call<{ receipt: ReceiptBody }>(`${RECEIPTS}/${receipt.id}/transition`, {
      method: 'POST',
      token: financeToken,
      body: { action: 'approve', reason: '财务复核通过', version: receipt.version },
    });

    expectStatus(response, 200);
    expect(response.body.receipt.status).toBe('pending_reconcile');
    expect(response.body.receipt.approvedBy?.id).toBeTruthy();
    receipt = response.body.receipt;
  });

  it('refuses a stale version with 409 CONFLICT', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/transition`, {
      method: 'POST',
      token: financeToken,
      body: { action: 'approve', reason: '用旧版本再点一次', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2 } });
  });
});

describe('核销', () => {
  it('refuses an amount above the receipt total', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/allocations`, {
      method: 'POST',
      token: opsToken,
      body: { allocations: [{ receivableId: firstPeriod.id, amount: 9000 }], reason: '超收款额' },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'RECEIPT_EXCEEDED', allocatable: 8000 },
    });
  });

  it('refuses an amount above what the period still owes', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/allocations`, {
      method: 'POST',
      token: opsToken,
      body: {
        allocations: [{ receivableId: secondPeriod.id, amount: 5000 }],
        reason: '超单期余额',
      },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'RECEIVABLE_EXCEEDED', outstanding: 4000 },
    });
  });

  it('reconciles the receipt against the first period', async () => {
    const response = await call<{ receipt: ReceiptBody; receivablesSummary: ReceivableBody[] }>(
      `${RECEIPTS}/${receipt.id}/allocations`,
      {
        method: 'POST',
        token: opsToken,
        body: { allocations: [{ receivableId: firstPeriod.id, amount: 8000 }], reason: '首期全额' },
      },
    );

    expectStatus(response, 201);
    expect(response.body.receipt.status).toBe('reconciled');
    expect(response.body.receipt.allocatedAmount).toBe(8000);
    expect(response.body.receipt.refundableAmount).toBe(8000);
    // 汇总里的那一期读回来必须是 paid、余额 0——一次核销同时改了两个域的表。
    expect(response.body.receivablesSummary[0]).toMatchObject({
      periodNo: 1,
      allocatedAmount: 8000,
      outstanding: 0,
      status: 'paid',
    });
    receipt = response.body.receipt;
  });

  it('refuses a second reconciliation beyond the remaining zero', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/allocations`, {
      method: 'POST',
      token: opsToken,
      body: { allocations: [{ receivableId: secondPeriod.id, amount: 100 }], reason: '再核销一点' },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ details: { reason: 'RECEIPT_EXCEEDED' } });
  });

  it('shows the allocation on the receivable detail with the shared shape', async () => {
    const detail = await call<{ allocations: AllocationBody[] }>(
      `${RECEIVABLES}/${firstPeriod.id}`,
      { token: opsToken },
    );
    expectStatus(detail, 200);
    expect(detail.body.allocations).toHaveLength(1);
    // 两个详情端点共用 `allocation_json`：这里能读到收款号，说明形状是一份。
    expect(detail.body.allocations[0]).toMatchObject({
      receiptNo: receipt.receiptNo,
      periodNo: 1,
      reversedAmount: 0,
    });
    firstAllocation = detail.body.allocations[0];
  });
});

describe('撤销核销', () => {
  it('reverses part of the allocation and lifts the period balance', async () => {
    const response = await call<{
      allocation: { reversedAmount: number };
      receivable: ReceivableBody;
    }>(`/api/v1/ops/receipt-allocations/${firstAllocation.id}/reverse`, {
      method: 'POST',
      token: opsToken,
      body: { amount: 3000, reason: '客户少付一部分，先撤回来' },
    });

    expectStatus(response, 200);
    expect(response.body.allocation.reversedAmount).toBe(3000);
    expect(response.body.receivable).toMatchObject({
      allocatedAmount: 8000,
      reversedAmount: 3000,
      outstanding: 3000,
    });
  });

  it('refuses to reverse more than what is left', async () => {
    const response = await call(`/api/v1/ops/receipt-allocations/${firstAllocation.id}/reverse`, {
      method: 'POST',
      token: opsToken,
      body: { amount: 6000, reason: '撤超过剩余可撤额' },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      details: { reason: 'REVERSAL_EXCEEDED', reversible: 5000 },
    });
  });

  it('allows re-allocating the same period after a reversal', async () => {
    const response = await call<{ receipt: ReceiptBody }>(`${RECEIPTS}/${receipt.id}/allocations`, {
      method: 'POST',
      token: opsToken,
      body: { allocations: [{ receivableId: firstPeriod.id, amount: 3000 }], reason: '重新核销' },
    });

    expectStatus(response, 201);
    // 这条在旧约束（allocated BETWEEN 0 AND amount）下会 500：毛额已顶满 8000，
    // 再加 3000 就超过上限。净额不变量才让「撤销后重新核销」成立。
    expect(response.body.receipt.allocatedAmount).toBe(8000);
    receipt = response.body.receipt;
  });
});

describe('退款', () => {
  it('refuses a refund above the reconciled net', async () => {
    const response = await call(REFUNDS, {
      method: 'POST',
      token: opsToken,
      body: {
        receiptId: receipt.id,
        amount: 9000,
        refundDate: '2026-01-20',
        reason: '退超过已核销额',
      },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'REFUND_EXCEEDED', refundable: 8000 },
    });
  });

  it('records and approves a partial refund', async () => {
    const created = await call<{ refund: RefundBody }>(REFUNDS, {
      method: 'POST',
      token: opsToken,
      body: {
        receiptId: receipt.id,
        amount: 3000,
        refundDate: '2026-01-21',
        reason: '部分退款',
        externalVoucherRef: 'OUT-INT-0001',
      },
    });
    expectStatus(created, 201);
    expect(created.body.refund.status).toBe('recorded');
    expect(created.body.refund.refundNo).toMatch(/^RT-\d{6}$/);

    const approved = await call<{ refund: RefundBody; receipt: ReceiptBody }>(
      `${REFUNDS}/${created.body.refund.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve', reason: '退款已转账' },
      },
    );
    expectStatus(approved, 200);
    expect(approved.body.refund.status).toBe('approved');
    // 部分退款不改变收款状态（契约 §3.4）。
    expect(approved.body.receipt.status).toBe('reconciled');
    expect(approved.body.receipt.refundableAmount).toBe(5000);
  });

  it('moves the receipt to refunded once the last refund is approved', async () => {
    const created = await call<{ refund: RefundBody }>(REFUNDS, {
      method: 'POST',
      token: opsToken,
      body: { receiptId: receipt.id, amount: 5000, refundDate: '2026-01-22', reason: '退满余额' },
    });
    expectStatus(created, 201);

    const approved = await call<{ receipt: ReceiptBody }>(
      `${REFUNDS}/${created.body.refund.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve', reason: '退满最后一笔' },
      },
    );
    expectStatus(approved, 200);
    // 这条边没有独立端点：它由「最后一次退款审核」触发，漏了就永远到不了 refunded。
    expect(approved.body.receipt.status).toBe('refunded');
    expect(approved.body.receipt.refundableAmount).toBe(0);
    receipt = approved.body.receipt;
  });

  it('refuses anything once the receipt is fully refunded', async () => {
    const response = await call(REFUNDS, {
      method: 'POST',
      token: opsToken,
      body: {
        receiptId: receipt.id,
        amount: 100,
        refundDate: '2026-01-23',
        reason: '退满之后再退',
      },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ details: { reason: 'REFUND_EXCEEDED', refundable: 0 } });
  });
});

describe('详情、列表与冲正', () => {
  it('returns the receipt with allocations, reversals and refunds', async () => {
    const detail = await call<ReceiptDetailBody>(`${RECEIPTS}/${receipt.id}`, { token: opsToken });
    expectStatus(detail, 200);
    expect(detail.body.receipt.status).toBe('refunded');
    expect(detail.body.allocations).toHaveLength(2);
    expect(detail.body.reversals).toHaveLength(1);
    expect(detail.body.refunds).toHaveLength(2);
    expect(detail.body.allocations[0]).toMatchObject({ receiptNo: receipt.receiptNo });
  });

  it('filters the list by a repeated status key', async () => {
    const response = await call<{ items: ReceiptBody[]; total: number }>(
      `${RECEIPTS}?status=refunded&status=reversed`,
      { token: opsToken },
    );
    expectStatus(response, 200);
    // 多值筛选靠 req.queries()：用 req.query() 会只剩最后一个值。
    expect(
      response.body.items.every((item) => ['refunded', 'reversed'].includes(item.status)),
    ).toBe(true);
  });

  it('refuses to reverse a receipt that still has live allocations', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/reverse`, {
      method: 'POST',
      token: opsToken,
      body: { reason: '直接冲正', version: receipt.version },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      details: { reason: 'HAS_ALLOCATIONS', allocatedAmount: 8000 },
    });
  });

  it('reverses a receipt that never got allocated', async () => {
    const created = await call<{ receipt: ReceiptBody }>(RECEIPTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        transactionDate: '2026-01-09',
        amount: 1000,
        currency: 'CNY',
        methodCode: 'cash',
        reason: '现金收款登记错了',
      },
    });
    expectStatus(created, 201);

    const reversed = await call<{ receipt: ReceiptBody; reversal: { amount: number } }>(
      `${RECEIPTS}/${created.body.receipt.id}/reverse`,
      {
        method: 'POST',
        token: opsToken,
        body: { reason: '收错了客户', version: created.body.receipt.version },
      },
    );

    expectStatus(reversed, 200);
    expect(reversed.body.receipt.status).toBe('reversed');
    expect(reversed.body.reversal.amount).toBe(1000);
  });
});

describe('权限', () => {
  it('forbids a viewer from recording a receipt', async () => {
    const response = await call(RECEIPTS, {
      method: 'POST',
      token: viewerToken,
      body: {
        customerId,
        transactionDate: '2026-01-10',
        amount: 100,
        currency: 'CNY',
        methodCode: 'cash',
        reason: '只读想登记',
      },
    });

    expectStatus(response, 403);
  });

  it('forbids a viewer from reconciling', async () => {
    const response = await call(`${RECEIPTS}/${receipt.id}/allocations`, {
      method: 'POST',
      token: viewerToken,
      body: { allocations: [{ receivableId: secondPeriod.id, amount: 100 }], reason: '只读想核销' },
    });

    expectStatus(response, 403);
  });

  it('lets a viewer read the refund list', async () => {
    const response = await call<{ items: RefundBody[] }>(REFUNDS, { token: viewerToken });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });
});
