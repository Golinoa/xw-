import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_OVERVIEW_METRICS, OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { OVERVIEW_METRIC_CONTRACT_COUNT, OVERVIEW_METRIC_COUNT } from './protocol';
import { opsOverviewRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的字段名 / 状态码，以及查询参数怎么变成
 * RPC 参数。
 *
 * 口径本身（七个指标怎么算、窗口天数怎么落、无权限的指标算不算、多币种怎么分组）
 * 由 `supabase/tests/ops_overview_domain.sql` 在真库上断言。同一条规则两处各测
 * 一遍只会得到一个错觉：以为改了 SQL 还安全，因为这里是绿的。
 *
 * 属于本层的五类例外：
 *   1. **snake_case → camelCase 的逐个翻译**，包括 `restricted_metrics[]` 里的
 *      名字——只翻译 `metrics` 的键不翻译这个数组，前端永远匹配不上，页面会安静
 *      地少一格；
 *   2. **缺席的指标不许补 0**：SQL 没给键，出站也不能凭空多一个 `0`；
 *   3. **`windowDays` 不传就交给 SQL**（读 settings），API 层不许写 `?? 30`；
 *   4. **范围越界是 400**，且在 API 层就挡住，不进 RPC；
 *   5. **`invalid_window` 信封映射成 400 + `reason: 'INVALID_WINDOW'`**。
 */

const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = [
  'overview.read',
  'customer.read',
  'contract.read',
  'tenant.read',
  'entitlement.read',
  'ticket.read',
  'receivable.read',
];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'delivery@example.test',
    operator_display_name: '交付运营',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: permissions,
  };
}

function overviewRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    statistics_at: '2026-10-31T08:00:00+00:00',
    window_days: 30,
    metrics: {
      active_customers: 12,
      active_contracts: 9,
      running_tenants: 7,
      active_entitlements: 15,
      expiring_entitlements: 3,
      open_tickets: 4,
      waiting_tickets: 1,
      failed_sync_commands: 2,
      pending_receipt_amount: 1200.5,
      unreconciled_amount: 300,
    },
    amounts: [
      {
        currency: 'CNY',
        total_receivable: 20000,
        settled_receivable: 8000,
        overdue_receivable: 5000,
        upcoming_receivable: 7000,
      },
    ],
    restricted_metrics: [],
    partial_failures: [],
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
app.route('/', opsOverviewRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

async function call(options: CallOptions = {}) {
  const url = new URL(OPS_ROUTES.getOpsOverview.path, 'http://ops.test');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.append(key, value);
  }
  const response = await app.request(
    url.toString(),
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        ...options.headers,
      },
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

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/v1/ops/overview', () => {
  it('把 SQL 的 snake_case 翻成契约的 camelCase，金额也不例外', async () => {
    const called = stubFetch({ rpc: { get_ops_overview: overviewRow() } });

    const response = await call();

    expect(called).toEqual(['get_ops_overview']);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      statisticsAt: '2026-10-31T08:00:00+00:00',
      windowDays: 30,
      metrics: {
        activeCustomers: 12,
        activeContracts: 9,
        runningTenants: 7,
        activeEntitlements: 15,
        expiringEntitlements: 3,
        openTickets: 4,
        waitingTickets: 1,
        failedSyncCommands: 2,
        pendingReceiptAmount: 1200.5,
        unreconciledAmount: 300,
      },
      amounts: [
        {
          currency: 'CNY',
          totalReceivable: 20000,
          settledReceivable: 8000,
          overdueReceivable: 5000,
          upcomingReceivable: 7000,
        },
      ],
      restrictedMetrics: [],
      partialFailures: [],
    });
  });

  it('无权的指标在响应里没有键，而不是 0', async () => {
    stubFetch({
      rpc: {
        get_ops_overview: overviewRow({
          metrics: { active_customers: 12 },
          amounts: [],
          restricted_metrics: [
            'active_contracts',
            'running_tenants',
            'pending_receipt_amount',
            'amounts',
          ],
        }),
      },
    });

    const response = await call();

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    const metrics = body.metrics as Record<string, unknown>;
    expect(metrics.activeCustomers).toBe(12);
    expect('activeContracts' in metrics).toBe(false);
    expect('pendingReceiptAmount' in metrics).toBe(false);
    // `in` 而不是 `toBeUndefined()`：后者在「键存在且为 undefined」时也通过，
    // 而那正是补 0 的另一种写法。
    expect(body.restrictedMetrics).toEqual([
      'activeContracts',
      'runningTenants',
      'pendingReceiptAmount',
      'amounts',
    ]);
  });

  it('restrictedMetrics 里认不出的名字被丢掉，不让整份总览变 503', async () => {
    stubFetch({
      rpc: {
        get_ops_overview: overviewRow({
          restricted_metrics: ['metric_from_the_future', 'open_tickets'],
        }),
      },
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ restrictedMetrics: ['openTickets'] });
  });

  it('partialFailures 的 section 只保留契约认得的两个区块', async () => {
    stubFetch({
      rpc: {
        get_ops_overview: overviewRow({
          partial_failures: [
            { code: 'RECEIPT_CURRENCY_MIX', message: '只统计人民币', section: 'metrics' },
            { code: 'OTHER', message: '未知区块', section: 'somewhere' },
          ],
        }),
      },
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      partialFailures: [
        { code: 'RECEIPT_CURRENCY_MIX', message: '只统计人民币', section: 'metrics' },
        { code: 'OTHER', message: '未知区块' },
      ],
    });
  });

  it('不传 windowDays 时把 p_window_days 交给 SQL（null），API 层不写默认值', async () => {
    stubFetch({ rpc: { get_ops_overview: overviewRow() } });

    await call();

    expect(rpcBodies[0]?.body).toEqual({ p_window_days: null });
  });

  it('传 windowDays 时原样透传', async () => {
    stubFetch({ rpc: { get_ops_overview: overviewRow({ window_days: 7 }) } });

    const response = await call({ query: { windowDays: '7' } });

    expect(rpcBodies[0]?.body).toEqual({ p_window_days: 7 });
    expect(response.body).toMatchObject({ windowDays: 7 });
  });

  it('windowDays 为空串时回到「没传」，不是 0', async () => {
    stubFetch({ rpc: { get_ops_overview: overviewRow() } });

    const response = await call({ query: { windowDays: '' } });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toEqual({ p_window_days: null });
  });

  it('windowDays 越界在 API 层就被挡下，不进 RPC', async () => {
    stubFetch({ rpc: { get_ops_overview: overviewRow() } });

    const zero = await call({ query: { windowDays: '0' } });
    const tooLarge = await call({ query: { windowDays: '366' } });

    expect(zero.status).toBe(400);
    expect(tooLarge.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('SQL 回 invalid_window 时是 400 + 可读的越界值', async () => {
    stubFetch({
      rpc: { get_ops_overview: { status: 'invalid_window', value: 999 } },
    });

    const response = await call();

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'INVALID_WINDOW', field: 'windowDays', value: 999 },
    });
  });

  it('没有 overview.read 时 403，且不调用 RPC', async () => {
    const called = stubFetch({
      permissions: ['customer.read', 'contract.read'],
      rpc: { get_ops_overview: overviewRow() },
    });

    const response = await call();

    expect(response.status).toBe(403);
    expect(called).toEqual([]);
  });

  it('没有令牌时 401', async () => {
    stubFetch({ rpc: { get_ops_overview: overviewRow() } });

    const response = await app.request(OPS_ROUTES.getOpsOverview.path, { method: 'GET' }, env);

    expect(response.status).toBe(401);
  });

  it('SQL 返回的形状不认识时 503，而不是把半成品透出去', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ rpc: { get_ops_overview: { status: 'ok', window_days: 30 } } });

    const response = await call();

    expect(response.status).toBe(503);
  });

  it('翻译表与契约包的指标名数量一致（多一个指标必须改两处）', () => {
    expect(OVERVIEW_METRIC_COUNT).toBe(OVERVIEW_METRIC_CONTRACT_COUNT);
    expect(OPS_OVERVIEW_METRICS).toHaveLength(10);
  });
});
