import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsReceivableRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站
 * 查询参数怎么变成 RPC 参数。
 *
 * 规则本身（合计必须等于合同金额、已结清不可展期、状态五档优先级）由
 * `supabase/tests/ops_billing_domain.sql` 在真库上断言。同一条规则两处各测一遍，
 * 只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 属于本层的三类例外：
 *   1. **入站形状**：`strictObject` 拒绝 `periodNo`/`currency`，`periods` 不能是空数组；
 *   2. **幂等键**：全局中间件对缺键放行，两个写端点的 400 只能在这里证明；
 *   3. **查询参数翻译**：`status` 多值、`overdueOnly` 的字符串布尔、`dueDate` → `due_date`。
 */

const RECEIVABLE_ID = '00000000-0000-4000-8000-000000000701';
const CONTRACT_ID = '00000000-0000-4000-8000-000000000702';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000703';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = ['receivable.read', 'receivable.write'];

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

function receivableRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIVABLE_ID,
    contract_id: CONTRACT_ID,
    contract_no: 'HT-000001',
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    period_no: 2,
    due_date: '2026-11-30',
    amount: 4000,
    currency: 'CNY',
    allocated_amount: 0,
    reversed_amount: 0,
    outstanding: 4000,
    status: 'overdue',
    note: null,
    version: 1,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-01T02:00:00+00:00',
    ...overrides,
  };
}

function extensionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000704',
    previous_due_date: '2026-11-30',
    new_due_date: '2027-01-15',
    reason: '客户申请延后',
    created_by: OPERATOR_ID,
    created_at: '2026-10-05T02:00:00+00:00',
    ...overrides,
  };
}

const summary = {
  total_amount: 12000,
  settled_amount: 4000,
  outstanding_amount: 8000,
  overdue_amount: 4000,
};

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
app.route('/', opsReceivableRoutes);

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

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-billing-0001' };

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
  for (const [name, value] of Object.entries({ receivableId: RECEIVABLE_ID, ...values })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /receivables', () => {
  it('passes the sort whitelist and paging through as snake_case RPC arguments', async () => {
    stubFetch({
      rpc: {
        list_receivables: { status: 'ok', items: [receivableRow()], total: 1, summary },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsReceivables.path), {
      query: { sort: 'dueDate', order: 'desc', page: '2', pageSize: '20' },
    });

    expect(result.status).toBe(200);
    const body = rpcBodies.find((entry) => entry.name === 'list_receivables')?.body ?? {};
    expect(body.p_sort).toBe('due_date');
    expect(body.p_sort_desc).toBe(true);
    // 第 2 页、每页 20 条 → offset 20。分页写成 `page` 而不是 `offset` 时，
    // 这个换算是最容易漏的一处。
    expect(body.p_offset).toBe(20);
    expect(body.p_limit).toBe(20);
  });

  it('keeps every status value when the query repeats the key', async () => {
    stubFetch({
      rpc: {
        list_receivables: { status: 'ok', items: [], total: 0, summary },
      },
    });

    await call(path(OPS_ROUTES.listOpsReceivables.path), {
      query: { status: ['overdue', 'partial'] },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_receivables')?.body ?? {};
    // status 用 req.query() 取会只剩 'partial'，筛选条数因此总是偏少。
    expect(body.p_statuses).toEqual(['overdue', 'partial']);
  });

  it('reads overdueOnly=false as false instead of coercing any non-empty string to true', async () => {
    stubFetch({
      rpc: {
        list_receivables: { status: 'ok', items: [], total: 0, summary },
      },
    });

    await call(path(OPS_ROUTES.listOpsReceivables.path), { query: { overdueOnly: 'false' } });

    const body = rpcBodies.find((entry) => entry.name === 'list_receivables')?.body ?? {};
    expect(body.p_overdue_only).toBe(false);
  });

  it('rejects a sort value outside the whitelist', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.listOpsReceivables.path), {
      query: { sort: 'createdAt' },
    });

    expect(result.status).toBe(400);
  });

  it('forbids listing without receivable.read', async () => {
    stubFetch({ permissions: [] });

    const result = await call(path(OPS_ROUTES.listOpsReceivables.path));

    expect(result.status).toBe(403);
  });

  it('maps the summary to camelCase and keeps the paging envelope', async () => {
    stubFetch({
      rpc: {
        list_receivables: { status: 'ok', items: [receivableRow()], total: 1, summary },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsReceivables.path));

    expect(result.body.summary).toEqual({
      totalAmount: 12000,
      settledAmount: 4000,
      outstandingAmount: 8000,
      overdueAmount: 4000,
    });
    expect(result.body.items[0].contractNo).toBe('HT-000001');
    expect(result.body.items[0].dueDate).toBe('2026-11-30');
    expect(result.body.page).toBe(1);
  });
});

describe('POST /receivables', () => {
  it('refuses a request without an Idempotency-Key', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 12000 }] },
    });

    // 全局中间件对缺键放行，这个 400 只能由 handler 给出。
    expect(result.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('creates a plan and maps the created periods back to camelCase', async () => {
    stubFetch({
      rpc: {
        create_receivable_plan: { status: 'ok', items: [receivableRow({ status: 'upcoming' })] },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 12000 }] },
    });

    expect(result.status).toBe(201);
    expect(result.body.items[0].periodNo).toBe(2);
    expect(result.body.items[0].status).toBe('upcoming');
  });

  it('rejects periodNo and currency in the body instead of silently ignoring them', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        contractId: CONTRACT_ID,
        periods: [{ dueDate: '2026-11-30', amount: 12000, periodNo: 3, currency: 'USD' }],
      },
    });

    expect(result.status).toBe(400);
  });

  it('rejects an empty period list', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [] },
    });

    expect(result.status).toBe(400);
  });

  it('reports a non-active contract as 409 STATE_CONFLICT', async () => {
    stubFetch({
      rpc: { create_receivable_plan: { status: 'contract_not_active', contract_status: 'draft' } },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 12000 }] },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({
      reason: 'CONTRACT_NOT_ACTIVE',
      contractStatus: 'draft',
    });
  });

  it('reports a total mismatch as 400 with both amounts', async () => {
    stubFetch({
      rpc: {
        create_receivable_plan: {
          status: 'plan_total_mismatch',
          planned_total: 11999.99,
          contract_total: 12000,
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 11999.99 }] },
    });

    // 契约 §6.4 把这个 reason 拼写定死了，前端按它分支。
    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({
      reason: 'PLAN_TOTAL_MISMATCH',
      plannedTotal: 11999.99,
      contractTotal: 12000,
    });
  });

  it('names the offending period when the amount has more than two decimals', async () => {
    stubFetch({
      rpc: { create_receivable_plan: { status: 'amount_scale_invalid', period_no: 2 } },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        contractId: CONTRACT_ID,
        periods: [
          { dueDate: '2026-11-30', amount: 6000 },
          { dueDate: '2026-12-31', amount: 6000.005 },
        ],
      },
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({ periodNo: 2 });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { create_receivable_plan: { status: 'contract_not_found' } } });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 12000 }] },
    });

    expect(result.status).toBe(404);
  });

  it('forbids writing without receivable.write', async () => {
    stubFetch({ permissions: ['receivable.read'] });

    const result = await call(path(OPS_ROUTES.createOpsReceivablePlan.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { contractId: CONTRACT_ID, periods: [{ dueDate: '2026-11-30', amount: 12000 }] },
    });

    expect(result.status).toBe(403);
  });
});

describe('GET /receivables/:id', () => {
  it('returns the extension history and an empty allocation list', async () => {
    stubFetch({
      rpc: {
        get_receivable: {
          status: 'ok',
          receivable: receivableRow(),
          allocations: [],
          extensions: [extensionRow()],
          reversals: [],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.getOpsReceivable.path));

    expect(result.status).toBe(200);
    expect(result.body.extensions[0].previousDueDate).toBe('2026-11-30');
    expect(result.body.allocations).toEqual([]);
  });

  it('reports an unknown receivable as 404', async () => {
    stubFetch({ rpc: { get_receivable: { status: 'receivable_not_found' } } });

    const result = await call(path(OPS_ROUTES.getOpsReceivable.path));

    expect(result.status).toBe(404);
  });

  it('rejects a non-uuid path parameter before calling the RPC', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.getOpsReceivable.path, { receivableId: 'abc' }));

    expect(result.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('turns an unexpected RPC shape into 503 instead of leaking it', async () => {
    stubFetch({
      rpc: {
        // status 不在五档里：说明库与契约已经不一致，不该原样转给前端。
        get_receivable: {
          status: 'ok',
          receivable: receivableRow({ status: 'unpaid' }),
          allocations: [],
          extensions: [],
          reversals: [],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.getOpsReceivable.path));

    expect(result.status).toBe(503);
  });
});

describe('POST /receivables/:id/extensions', () => {
  it('refuses a request without an Idempotency-Key', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      body: { newDueDate: '2027-01-15', reason: '客户申请延后', version: 1 },
    });

    expect(result.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('sends the expected version so a concurrent extension is detected', async () => {
    stubFetch({
      rpc: {
        extend_receivable: {
          status: 'ok',
          receivable: receivableRow({ version: 2, due_date: '2027-01-15' }),
          extension: extensionRow(),
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { newDueDate: '2027-01-15', reason: '客户申请延后', version: 1 },
    });

    const body = rpcBodies.find((entry) => entry.name === 'extend_receivable')?.body ?? {};
    expect(body.p_expected_version).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.receivable.version).toBe(2);
    expect(result.body.extension.newDueDate).toBe('2027-01-15');
  });

  it('reports a settled receivable as 409 with the settled amounts', async () => {
    stubFetch({
      rpc: {
        extend_receivable: {
          status: 'receivable_settled',
          allocated_amount: 4000,
          reversed_amount: 0,
        },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { newDueDate: '2027-01-15', reason: '客户申请延后', version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({ reason: 'RECEIVABLE_SETTLED' });
  });

  it('reports a due date that is not later as 400 with the current one', async () => {
    stubFetch({
      rpc: {
        extend_receivable: { status: 'invalid_due_date', current_due_date: '2026-11-30' },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { newDueDate: '2026-11-30', reason: '客户申请延后', version: 1 },
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({ currentDueDate: '2026-11-30' });
  });

  it('reports a stale version as 409 with the version to refresh to', async () => {
    stubFetch({
      rpc: { extend_receivable: { status: 'version_mismatch', current_version: 3 } },
    });

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { newDueDate: '2027-01-15', reason: '客户申请延后', version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({ currentVersion: 3 });
  });

  it('rejects a blank reason at the schema layer', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsReceivableExtension.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { newDueDate: '2027-01-15', reason: '   ', version: 1 },
    });

    expect(result.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });
});
