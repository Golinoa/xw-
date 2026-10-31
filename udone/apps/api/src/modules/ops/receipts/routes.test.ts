import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsReceiptRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站
 * 参数怎么变成 RPC 参数。
 *
 * 规则本身（核销不超额、退款不超可退额、登记人不能自审、撤销要有原因）由
 * `supabase/tests/ops_receipt_domain.sql` 在真库上断言。同一条规则两处各测一遍，
 * 只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 属于本层的四类例外：
 *   1. **入站形状**：`strictObject` 拒绝多余字段，动作枚举只收 approve/reject；
 *   2. **幂等键**：全局中间件对缺键放行，七个写端点的 400 只能在这里证明；
 *   3. **查询参数翻译**：`status` 多值、日期区间、`page/pageSize` → `limit/offset`；
 *   4. **状态码归属**：职责分离必须是 403 而不是 409，金额类冲突必须是 409
 *      而不是 422——这两条前端按不同分支处理，弄反了界面就给错提示。
 */

const RECEIPT_ID = '00000000-0000-4000-8000-000000000801';
const RECEIVABLE_ID = '00000000-0000-4000-8000-000000000802';
const CONTRACT_ID = '00000000-0000-4000-8000-000000000803';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000804';
const ALLOCATION_ID = '00000000-0000-4000-8000-000000000805';
const REFUND_ID = '00000000-0000-4000-8000-000000000806';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = [
  'receivable.read',
  'receipt.record',
  'receipt.approve',
  'receipt.reconcile',
  'receipt.reverse',
  'receipt.refund',
];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'finance@example.test',
    operator_display_name: '财务',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['finance_ops'],
    role_names: ['财务运营'],
    permission_codes: permissions,
  };
}

function operatorRef() {
  return { id: OPERATOR_ID, display_name: '财务' };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    receipt_no: 'SK-000001',
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    contract_id: CONTRACT_ID,
    contract_no: 'HT-000001',
    transaction_date: '2026-01-05',
    amount: 8000,
    currency: 'CNY',
    method: { code: 'bank_transfer', label: 'bank_transfer' },
    reference_no: 'BK-9001',
    voucher_ref: null,
    status: 'recorded',
    allocated_amount: 0,
    refundable_amount: 0,
    recorded_by: operatorRef(),
    approved_by: null,
    approved_at: null,
    recorded_reason: '收到首期款',
    version: 1,
    created_at: '2026-01-05T02:00:00+00:00',
    updated_at: '2026-01-05T02:00:00+00:00',
    ...overrides,
  };
}

function allocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ALLOCATION_ID,
    receipt_id: RECEIPT_ID,
    receipt_no: 'SK-000001',
    receivable_id: RECEIVABLE_ID,
    period_no: 1,
    contract_id: CONTRACT_ID,
    due_date: '2026-01-10',
    amount: 8000,
    reversed_amount: 0,
    allocated_by: operatorRef(),
    allocated_at: '2026-01-06T02:00:00+00:00',
    ...overrides,
  };
}

function reversalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000807',
    allocation_id: ALLOCATION_ID,
    receivable_id: RECEIVABLE_ID,
    amount: 3000,
    reason: '客户少付了一部分',
    reversed_by: operatorRef(),
    created_at: '2026-01-07T02:00:00+00:00',
    ...overrides,
  };
}

function refundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REFUND_ID,
    refund_no: 'RT-000001',
    receipt_id: RECEIPT_ID,
    receipt_no: 'SK-000001',
    contract_id: CONTRACT_ID,
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    amount: 3000,
    currency: 'CNY',
    refund_date: '2026-01-21',
    reason: '部分退款',
    external_voucher_ref: 'OUT-0001',
    status: 'recorded',
    handled_by: operatorRef(),
    approved_by: null,
    approved_at: null,
    version: 1,
    created_at: '2026-01-21T02:00:00+00:00',
    updated_at: '2026-01-21T02:00:00+00:00',
    ...overrides,
  };
}

function receivableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIVABLE_ID,
    contract_id: CONTRACT_ID,
    contract_no: 'HT-000001',
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    period_no: 1,
    due_date: '2026-01-10',
    amount: 8000,
    currency: 'CNY',
    allocated_amount: 8000,
    reversed_amount: 0,
    outstanding: 0,
    status: 'paid',
    note: null,
    version: 2,
    created_at: '2026-01-01T02:00:00+00:00',
    updated_at: '2026-01-06T02:00:00+00:00',
    ...overrides,
  };
}

interface StubOptions {
  permissions?: string[];
  rpc?: Record<string, unknown>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const rpcBodies: Array<{ name: string; body: Record<string, unknown> }> = [];

function stubFetch(options: StubOptions = {}) {
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const called: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rpcName = url.split('/rpc/')[1]?.split('?')[0];

    if (rpcName === 'get_current_ops_context') return json([opsContextRow(permissions)]);
    if (!rpcName) throw new Error(`unexpected request: ${url}`);

    called.push(rpcName);
    rpcBodies.push({
      name: rpcName,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (!(rpcName in (options.rpc ?? {}))) {
      throw new Error(`rpc ${rpcName} was not expected`);
    }
    return json(options.rpc?.[rpcName]);
  });

  vi.stubGlobal('fetch', fetchMock);
  return called;
}

const app = new Hono<ApiEnvironment>();
app.onError(errorHandler);
app.route('/', opsReceiptRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
}

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-receipt-0001' };

async function call(path: string, options: CallOptions = {}) {
  const url = new URL(path, 'http://ops.test');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  const response = await app.request(
    url.toString(),
    {
      method: options.method ?? 'GET',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env,
  );
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

/** 路径一律从注册表取：测试里手写路径会让「清单改了、测试没改」悄悄通过。 */
function path(template: string, values: Record<string, string> = {}) {
  let result = template;
  for (const [name, value] of Object.entries({
    receiptId: RECEIPT_ID,
    allocationId: ALLOCATION_ID,
    refundId: REFUND_ID,
    ...values,
  })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

function receiptBody(overrides: Record<string, unknown> = {}) {
  return {
    customerId: CUSTOMER_ID,
    contractId: CONTRACT_ID,
    transactionDate: '2026-01-05',
    amount: 8000,
    currency: 'CNY',
    methodCode: 'bank_transfer',
    referenceNo: 'BK-9001',
    reason: '收到首期款',
    ...overrides,
  };
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /receipts', () => {
  it('keeps every status value when the query repeats the key', async () => {
    stubFetch({ rpc: { list_receipts: { status: 'ok', items: [receiptRow()], total: 1 } } });

    await call(path(OPS_ROUTES.listOpsReceipts.path), {
      query: { status: ['recorded', 'reconciled'] },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_receipts')?.body ?? {};
    // `req.query()` 只取最后一个值，筛选条数因此总是偏少。
    expect(body.p_statuses).toEqual(['recorded', 'reconciled']);
  });

  it('translates dates, method and paging into snake_case RPC arguments', async () => {
    stubFetch({ rpc: { list_receipts: { status: 'ok', items: [], total: 0 } } });

    await call(path(OPS_ROUTES.listOpsReceipts.path), {
      query: {
        customerId: CUSTOMER_ID,
        methodCode: 'bank_transfer',
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
        page: '3',
        pageSize: '20',
      },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_receipts')?.body ?? {};
    expect(body.p_customer_id).toBe(CUSTOMER_ID);
    expect(body.p_method_code).toBe('bank_transfer');
    expect(body.p_date_from).toBe('2026-01-01');
    expect(body.p_date_to).toBe('2026-01-31');
    expect(body.p_offset).toBe(40);
    expect(body.p_limit).toBe(20);
  });

  it('rejects a status outside the closed enum', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.listOpsReceipts.path), {
      query: { status: 'pending' },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });

  it('maps the request level to camelCase and keeps refundableAmount', async () => {
    stubFetch({
      rpc: {
        list_receipts: {
          status: 'ok',
          items: [
            receiptRow({ status: 'reconciled', allocated_amount: 8000, refundable_amount: 8000 }),
          ],
          total: 1,
        },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsReceipts.path));

    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({
      receiptNo: 'SK-000001',
      allocatedAmount: 8000,
      refundableAmount: 8000,
      method: { code: 'bank_transfer' },
      recordedBy: { id: OPERATOR_ID, displayName: '财务' },
      approvedBy: null,
    });
  });
});

describe('POST /receipts', () => {
  it('refuses a request without an Idempotency-Key header', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      body: receiptBody(),
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({ field: 'Idempotency-Key' });
  });

  it('rejects a body with an unexpected field', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...receiptBody(), periodNo: 1 },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 201 with duplicate warnings when the reference repeats', async () => {
    stubFetch({
      rpc: {
        record_receipt: {
          status: 'ok',
          receipt: receiptRow(),
          duplicate_warnings: [
            {
              receipt_id: '00000000-0000-4000-8000-000000000808',
              receipt_no: 'SK-000002',
              transaction_date: '2026-01-09',
              amount: 600,
              status: 'recorded',
            },
          ],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: receiptBody(),
    });

    expect(result.status).toBe(201);
    expect(result.body.duplicateWarnings[0]).toMatchObject({
      receiptNo: 'SK-000002',
      amount: 600,
    });
    const sent = rpcBodies.find((entry) => entry.name === 'record_receipt')?.body ?? {};
    expect(sent.p_reference_no).toBe('BK-9001');
    expect(sent.p_reason).toBe('收到首期款');
  });

  it('omits optional fields as null rather than leaving them undefined', async () => {
    stubFetch({
      rpc: { record_receipt: { status: 'ok', receipt: receiptRow(), duplicate_warnings: [] } },
    });

    await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: receiptBody({ referenceNo: undefined, contractId: undefined }),
    });

    const sent = rpcBodies.find((entry) => entry.name === 'record_receipt')?.body ?? {};
    // 缺键与显式 null 在 PostgREST 上是两件事：前者用默认值，后者把默认值覆盖成 null。
    // 这里要的是后者——「没填」就是没有。
    expect(sent).toHaveProperty('p_contract_id', null);
    expect(sent).toHaveProperty('p_reference_no', null);
  });

  it('maps a fully duplicated receipt to 409 CONFLICT', async () => {
    stubFetch({ rpc: { record_receipt: { status: 'duplicate_reference' } } });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: receiptBody(),
    });

    // 409 而不是 400：这笔钱已经在这本账上了，不是格式错误。
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('CONFLICT');
    expect(result.body.details).toMatchObject({ field: 'referenceNo' });
  });

  it('maps a currency disagreement with the contract to 400 CURRENCY_MISMATCH', async () => {
    stubFetch({
      rpc: { record_receipt: { status: 'currency_mismatch', contract_currency: 'CNY' } },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: receiptBody({ currency: 'USD' }),
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({ reason: 'CURRENCY_MISMATCH' });
  });
});

describe('GET /receipts/{id}', () => {
  it('maps allocations and reversals to the shared camelCase shape', async () => {
    stubFetch({
      rpc: {
        get_receipt: {
          status: 'ok',
          receipt: receiptRow({ status: 'reconciled', allocated_amount: 8000 }),
          allocations: [allocationRow()],
          reversals: [reversalRow()],
          refunds: [refundRow()],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.getOpsReceipt.path));

    expect(result.status).toBe(200);
    expect(result.body.allocations[0]).toMatchObject({
      receiptNo: 'SK-000001',
      periodNo: 1,
      reversedAmount: 0,
      allocatedBy: { displayName: '财务' },
    });
    expect(result.body.reversals[0]).toMatchObject({ allocationId: ALLOCATION_ID, amount: 3000 });
    expect(result.body.refunds[0]).toMatchObject({ refundNo: 'RT-000001', status: 'recorded' });
  });

  it('returns 404 when the receipt is gone', async () => {
    stubFetch({ rpc: { get_receipt: { status: 'receipt_not_found' } } });

    const result = await call(path(OPS_ROUTES.getOpsReceipt.path));

    expect(result.status).toBe(404);
    expect(result.body.details).toMatchObject({ resource: 'receipt' });
  });
});

describe('POST /receipts/{id}/transition', () => {
  it('refuses self approval with 403 and the rule code', async () => {
    stubFetch({ rpc: { transition_receipt: { status: 'segregation_of_duty' } } });

    const result = await call(path(OPS_ROUTES.transitionOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve', version: 1 },
    });

    // 403 而不是 409：换个人点同一个按钮就成功了，属于「人不允许」。
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('FORBIDDEN');
    expect(result.body.details).toMatchObject({ rule: 'SEGREGATION_OF_DUTY' });
  });

  it('maps an illegal edge to 409 STATE_CONFLICT with allowedActions', async () => {
    stubFetch({
      rpc: {
        transition_receipt: {
          status: 'invalid_transition',
          current_status: 'pending_reconcile',
          allowed_actions: ['reconcile', 'reverse'],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.transitionOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve', version: 2 },
    });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('STATE_CONFLICT');
    expect(result.body.details).toMatchObject({
      reason: 'INVALID_TRANSITION',
      currentStatus: 'pending_reconcile',
      allowedActions: ['reconcile', 'reverse'],
    });
  });

  it('maps a stale version to 409 CONFLICT with the current one', async () => {
    stubFetch({ rpc: { transition_receipt: { status: 'version_mismatch', current_version: 4 } } });

    const result = await call(path(OPS_ROUTES.transitionOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve', version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('CONFLICT');
    expect(result.body.details).toMatchObject({ currentVersion: 4 });
  });

  it('rejects an action outside the approve/reject enum', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.transitionOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'reconcile', version: 1 },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /receipts/{id}/allocations', () => {
  it('returns 201 with the new receipt and the touched periods', async () => {
    stubFetch({
      rpc: {
        allocate_receipt: {
          status: 'ok',
          receipt: receiptRow({ status: 'reconciled', allocated_amount: 8000 }),
          receivables_summary: [receivableRow()],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 8000 }], reason: '首期' },
    });

    expect(result.status).toBe(201);
    expect(result.body.receipt).toMatchObject({ status: 'reconciled', allocatedAmount: 8000 });
    expect(result.body.receivablesSummary[0]).toMatchObject({ periodNo: 1, outstanding: 0 });

    const sent = rpcBodies.find((entry) => entry.name === 'allocate_receipt')?.body ?? {};
    // 入站是 camelCase，RPC 认 camelCase 的键名（库函数自己解 jsonb）。
    expect(sent.p_allocations).toEqual([{ receivableId: RECEIVABLE_ID, amount: 8000 }]);
  });

  it('keeps the two ceilings apart: receipt vs period', async () => {
    stubFetch({
      rpc: {
        allocate_receipt: { status: 'receipt_exceeded', requested_total: 9000, allocatable: 8000 },
      },
    });

    const first = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 9000 }] },
    });

    expect(first.status).toBe(409);
    expect(first.body.details).toMatchObject({
      reason: 'RECEIPT_EXCEEDED',
      requestedTotal: 9000,
      allocatable: 8000,
    });

    stubFetch({
      rpc: {
        allocate_receipt: {
          status: 'receivable_exceeded',
          index: 1,
          receivable_id: RECEIVABLE_ID,
          outstanding: 4000,
        },
      },
    });

    const second = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 5000 }] },
    });

    // 两个 reason 分开是有意义的：前者是「这笔钱不够抵」，后者是「这期不需要
    // 这么多钱」，用户要做的事完全不同。
    expect(second.body.details).toMatchObject({
      reason: 'RECEIVABLE_EXCEEDED',
      index: 1,
      outstanding: 4000,
    });
  });

  it('maps an unapproved receipt to 409 RECEIPT_NOT_APPROVED', async () => {
    stubFetch({
      rpc: {
        allocate_receipt: {
          status: 'receipt_not_approved',
          allowed_actions: ['approve', 'reject', 'reverse'],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 100 }] },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({
      reason: 'RECEIPT_NOT_APPROVED',
      allowedActions: ['approve', 'reject', 'reverse'],
    });
  });

  it('maps a cross-currency allocation to 400 CURRENCY_MISMATCH', async () => {
    stubFetch({
      rpc: {
        allocate_receipt: {
          status: 'currency_mismatch',
          index: 1,
          receivable_id: RECEIVABLE_ID,
          receivable_currency: 'USD',
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 100 }] },
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({
      reason: 'CURRENCY_MISMATCH',
      receivableCurrency: 'USD',
    });
  });

  it('rejects an empty allocation list at the schema level', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [] },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /receipts/{id}/reverse', () => {
  it('maps live allocations to 409 HAS_ALLOCATIONS', async () => {
    stubFetch({
      rpc: { reverse_receipt: { status: 'has_allocations', allocated_amount: 8000 } },
    });

    const result = await call(path(OPS_ROUTES.reverseOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { reason: '客户退款走别的渠道', version: 4 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({ reason: 'HAS_ALLOCATIONS', allocatedAmount: 8000 });
  });

  it('returns the reversed amount on success', async () => {
    stubFetch({
      rpc: {
        reverse_receipt: {
          status: 'ok',
          receipt: receiptRow({ status: 'reversed' }),
          reversal: { amount: 8000 },
        },
      },
    });

    const result = await call(path(OPS_ROUTES.reverseOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { reason: '现金收错了客户', version: 2 },
    });

    expect(result.status).toBe(200);
    expect(result.body.reversal).toEqual({ amount: 8000 });
  });
});

describe('POST /receipt-allocations/{id}/reverse', () => {
  it('sends a null amount when the caller wants a full reversal', async () => {
    stubFetch({
      rpc: {
        reverse_allocation: {
          status: 'ok',
          allocation: { id: ALLOCATION_ID, amount: 8000, reversed_amount: 8000 },
          receivable: receivableRow({ allocated_amount: 8000, reversed_amount: 8000 }),
          receipt: receiptRow({ status: 'reconciled' }),
        },
      },
    });

    const result = await call(path(OPS_ROUTES.reverseOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { reason: '整笔退回' },
    });

    expect(result.status).toBe(200);
    expect(result.body.allocation).toMatchObject({ reversedAmount: 8000 });
    const sent = rpcBodies.find((entry) => entry.name === 'reverse_allocation')?.body ?? {};
    expect(sent.p_amount).toBeNull();
  });

  it('maps an over-reversal to 409 REVERSAL_EXCEEDED with the real ceiling', async () => {
    stubFetch({ rpc: { reverse_allocation: { status: 'reversal_exceeded', reversible: 5000 } } });

    const result = await call(path(OPS_ROUTES.reverseOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { amount: 6000, reason: '撤多了' },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({ reason: 'REVERSAL_EXCEEDED', reversible: 5000 });
  });

  it('returns 404 for an unknown allocation', async () => {
    stubFetch({ rpc: { reverse_allocation: { status: 'allocation_not_found' } } });

    const result = await call(path(OPS_ROUTES.reverseOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { reason: '不存在' },
    });

    expect(result.status).toBe(404);
    expect(result.body.details).toMatchObject({ resource: 'receipt allocation' });
  });
});

describe('refunds', () => {
  it('lists refunds with the paging translated', async () => {
    stubFetch({
      rpc: { list_refunds: { status: 'ok', items: [refundRow()], total: 1 } },
    });

    const result = await call(path(OPS_ROUTES.listOpsRefunds.path), {
      query: { status: ['recorded', 'approved'], page: '2', pageSize: '20' },
    });

    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({
      refundNo: 'RT-000001',
      handledBy: { displayName: '财务' },
    });
    const sent = rpcBodies.find((entry) => entry.name === 'list_refunds')?.body ?? {};
    expect(sent.p_statuses).toEqual(['recorded', 'approved']);
    expect(sent.p_offset).toBe(20);
  });

  it('maps an over-refund to 409 REFUND_EXCEEDED with the refundable amount', async () => {
    stubFetch({
      rpc: {
        record_refund: { status: 'refund_exceeded', requested_amount: 9000, refundable: 8000 },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsRefund.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { receiptId: RECEIPT_ID, amount: 9000, refundDate: '2026-01-20', reason: '退多了' },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({
      reason: 'REFUND_EXCEEDED',
      requestedAmount: 9000,
      refundable: 8000,
    });
  });

  it('refuses a contractId that disagrees with the receipt', async () => {
    stubFetch({
      rpc: {
        get_receipt: {
          status: 'ok',
          receipt: receiptRow(),
          allocations: [],
          reversals: [],
          refunds: [],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsRefund.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        receiptId: RECEIPT_ID,
        contractId: '00000000-0000-4000-8000-0000000008ff',
        amount: 1000,
        refundDate: '2026-01-20',
        reason: '记错合同',
      },
    });

    // 静默忽略会让「用户在 A 合同上退款、实际记到 B」无从发现。
    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({ reason: 'CONTRACT_MISMATCH', field: 'contractId' });
  });

  it('returns 201 and the refund row on success', async () => {
    stubFetch({ rpc: { record_refund: { status: 'ok', refund: refundRow() } } });

    const result = await call(path(OPS_ROUTES.createOpsRefund.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { receiptId: RECEIPT_ID, amount: 3000, refundDate: '2026-01-21', reason: '部分退款' },
    });

    expect(result.status).toBe(201);
    expect(result.body.refund).toMatchObject({ refundNo: 'RT-000001', status: 'recorded' });
  });

  it('carries the receipt status change caused by the last refund approval', async () => {
    stubFetch({
      rpc: {
        transition_refund: {
          status: 'ok',
          refund: refundRow({ status: 'approved' }),
          receipt: receiptRow({ status: 'refunded', refundable_amount: 0 }),
        },
      },
    });

    const result = await call(path(OPS_ROUTES.transitionOpsRefund.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve', reason: '退满' },
    });

    expect(result.status).toBe(200);
    // 退满那一刻收款迁到 refunded——没有独立端点触发这条边，只能靠这个响应体现。
    expect(result.body.receipt).toMatchObject({ status: 'refunded' });
  });

  it('rejects a refund action outside approve/cancel', async () => {
    stubFetch({ rpc: {} });

    const result = await call(path(OPS_ROUTES.transitionOpsRefund.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'reject', reason: '不在枚举里' },
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('permissions', () => {
  it('forbids recording without receipt.record', async () => {
    stubFetch({ permissions: ['receivable.read'] });

    const result = await call(path(OPS_ROUTES.createOpsReceipt.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: receiptBody(),
    });

    expect(result.status).toBe(403);
  });

  it('forbids reconciling without receipt.reconcile', async () => {
    stubFetch({ permissions: ['receivable.read', 'receipt.record'] });

    const result = await call(path(OPS_ROUTES.createOpsReceiptAllocation.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { allocations: [{ receivableId: RECEIVABLE_ID, amount: 100 }] },
    });

    expect(result.status).toBe(403);
  });

  it('still allows reading the list with receivable.read only', async () => {
    stubFetch({
      permissions: ['receivable.read'],
      rpc: { list_receipts: { status: 'ok', items: [], total: 0 } },
    });

    const result = await call(path(OPS_ROUTES.listOpsReceipts.path));

    expect(result.status).toBe(200);
  });
});
