import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsReportRoutes } from './routes';

/**
 * 报表域的翻译层。口径（分组、排序、合计从明细重算、最新命令才算失败）由
 * `supabase/tests/ops_reports_domain.sql` 在真库上断言；这里只测三件翻译：
 *
 * 1. **可重复参数** `?status=a&status=b` 必须变成两元素数组。取最后一个的症状是
 *    「报表数字比预期大」——看起来像口径问题，实际是少了一个筛选条件。
 * 2. **可空字段保留 null**（`lastErrorCategory`、`lastAttemptAt`、`product`），
 *    不能补成空串或 0。
 * 3. **`invalid_*` 信封 → 400 + reason**：非法筛选值必须是 400，不能是空列表
 *    ——空列表会让调用方以为「确实没数据」。
 */

const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const REPORTING_IDS = {
  command: '00000000-0000-4000-8000-0000000000d1',
  mapping: '00000000-0000-4000-8000-0000000000d2',
  subject: '00000000-0000-4000-8000-0000000000d3',
  product: '00000000-0000-4000-8000-0000000000d4',
};

const ALL_PERMISSIONS = ['receivable.read', 'entitlement.read', 'tenant.read', 'deployment.read'];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'sales@example.test',
    operator_display_name: '商务运营',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['sales_ops'],
    role_names: ['商务运营'],
    permission_codes: permissions,
  };
}

const customerRefRow = { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例客户' };

function totalsRow() {
  return {
    count: 3,
    total_amount: 1900,
    settled_amount: 200,
    outstanding_amount: 1700,
    overdue_amount: 1000,
  };
}

function receivableReportRow() {
  return {
    status: 'ok',
    statistics_at: '2026-10-31T08:00:00+00:00',
    group_by: 'customer',
    rows: [{ key: CUSTOMER_ID, label: '示例客户', ...totalsRow() }],
    totals: totalsRow(),
    filters_echo: {
      customerId: null,
      contractId: null,
      status: null,
      dueFrom: null,
      dueTo: null,
      groupBy: 'customer',
    },
  };
}

function expiringReportRow() {
  return {
    status: 'ok',
    statistics_at: '2026-10-31T08:00:00+00:00',
    window_days: 30,
    rows: [
      {
        subject_type: 'subscription',
        id: REPORTING_IDS.subject,
        customer: customerRefRow,
        product: { id: REPORTING_IDS.product, name: '标准版' },
        status: 'active',
        valid_to: '2026-11-05',
        days_remaining: 5,
      },
      {
        subject_type: 'licence',
        id: REPORTING_IDS.mapping,
        customer: customerRefRow,
        product: null,
        status: 'active',
        valid_to: '2026-11-20',
        days_remaining: 20,
      },
    ],
  };
}

function syncReportRow() {
  return {
    status: 'ok',
    statistics_at: '2026-10-31T08:00:00+00:00',
    rows: [
      {
        command_id: REPORTING_IDS.command,
        command_no: 'CMD-000001',
        mapping: { id: REPORTING_IDS.mapping, mapping_no: 'TM-000001' },
        customer: customerRefRow,
        command_type: 'provision',
        attempt_count: 2,
        last_error_category: 'permanent',
        last_error_code: 'TENANT_EXISTS',
        last_attempt_at: '2026-10-31T02:00:00+00:00',
      },
      {
        command_id: REPORTING_IDS.product,
        command_no: 'CMD-000002',
        mapping: { id: REPORTING_IDS.mapping, mapping_no: 'TM-000002' },
        customer: customerRefRow,
        command_type: 'bind',
        attempt_count: 0,
        last_error_category: null,
        last_error_code: null,
        last_attempt_at: null,
      },
    ],
  };
}

function versionReportRow() {
  return {
    status: 'ok',
    statistics_at: '2026-10-31T08:00:00+00:00',
    rows: [{ version: '1.4.0', instance_count: 2, customers: [customerRefRow] }],
    unknown_version_count: 1,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const rpcBodies: Array<{ name: string; body: Record<string, unknown> }> = [];

function stubFetch(permissions: string[], rpc: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rpcName = url.split('/rpc/')[1]?.split('?')[0];
    if (rpcName === 'get_current_ops_context') return json([opsContextRow(permissions)]);
    if (!rpcName) throw new Error(`unexpected request: ${url}`);

    rpcBodies.push({
      name: rpcName,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (!(rpcName in rpc)) throw new Error(`rpc ${rpcName} was not expected`);
    return json(rpc[rpcName]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const app = new Hono<ApiEnvironment>();
app.onError(errorHandler);
app.route('/', opsReportRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

async function call(path: string, query: Record<string, string | string[]> = {}) {
  const url = new URL(path, 'http://ops.test');
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  const response = await app.request(
    url.toString(),
    { method: 'GET', headers: { Authorization: 'Bearer token' } },
    env,
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/v1/ops/reports/receivables', () => {
  it('translates rows, totals and filtersEcho', async () => {
    stubFetch(ALL_PERMISSIONS, { report_receivables: receivableReportRow() });

    const response = await call(OPS_ROUTES.getOpsReceivableReport.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      groupBy: 'customer',
      rows: [
        {
          key: CUSTOMER_ID,
          label: '示例客户',
          count: 3,
          totalAmount: 1900,
          settledAmount: 200,
          outstandingAmount: 1700,
          overdueAmount: 1000,
        },
      ],
      totals: { count: 3, overdueAmount: 1000 },
      filtersEcho: { groupBy: 'customer', status: null },
    });
  });

  it('turns a repeated status parameter into an array', async () => {
    stubFetch(ALL_PERMISSIONS, { report_receivables: receivableReportRow() });

    await call(OPS_ROUTES.getOpsReceivableReport.path, {
      status: ['overdue', 'partial'],
      groupBy: 'contract',
    });

    expect(rpcBodies[0]?.body).toMatchObject({
      p_statuses: ['overdue', 'partial'],
      p_group_by: 'contract',
    });
  });

  it('rejects an unknown groupBy with a reason instead of an empty report', async () => {
    stubFetch(ALL_PERMISSIONS, {
      report_receivables: { status: 'invalid_group_by', value: 'quarter' },
    });

    const response = await call(OPS_ROUTES.getOpsReceivableReport.path);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'INVALID_GROUP_BY', value: 'quarter' },
    });
  });

  it('forbids a caller without receivable.read and never reaches the RPC', async () => {
    stubFetch(['entitlement.read'], { report_receivables: receivableReportRow() });

    const response = await call(OPS_ROUTES.getOpsReceivableReport.path);

    expect(response.status).toBe(403);
    expect(rpcBodies).toHaveLength(0);
  });
});

describe('GET /api/v1/ops/reports/expiring-entitlements', () => {
  it('keeps a null product for a licence', async () => {
    stubFetch(ALL_PERMISSIONS, { report_expiring_entitlements: expiringReportRow() });

    const response = await call(OPS_ROUTES.getOpsExpiringEntitlementReport.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      windowDays: 30,
      rows: [
        { subjectType: 'subscription', daysRemaining: 5, validTo: '2026-11-05' },
        { subjectType: 'licence', product: null, daysRemaining: 20 },
      ],
    });
  });

  it('maps an unknown subject type to 400', async () => {
    stubFetch(ALL_PERMISSIONS, {
      report_expiring_entitlements: { status: 'invalid_subject_type', value: 'voucher' },
    });

    const response = await call(OPS_ROUTES.getOpsExpiringEntitlementReport.path);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'INVALID_SUBJECT_TYPE' } });
  });
});

describe('GET /api/v1/ops/reports/tenant-sync-failures', () => {
  it('keeps null error fields as null rather than empty strings', async () => {
    stubFetch(ALL_PERMISSIONS, { report_tenant_sync_failures: syncReportRow() });

    const response = await call(OPS_ROUTES.getOpsTenantSyncFailureReport.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      rows: [
        {
          commandNo: 'CMD-000001',
          mapping: { mappingNo: 'TM-000001' },
          commandType: 'provision',
          lastAttemptAt: '2026-10-31T02:00:00+00:00',
        },
        {
          commandNo: 'CMD-000002',
          lastErrorCategory: null,
          lastErrorCode: null,
          lastAttemptAt: null,
        },
      ],
    });
  });
});

describe('GET /api/v1/ops/reports/deployment-versions', () => {
  it('translates groups and the unknown bucket', async () => {
    stubFetch(ALL_PERMISSIONS, { report_deployment_versions: versionReportRow() });

    const response = await call(OPS_ROUTES.getOpsDeploymentVersionReport.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      rows: [
        {
          version: '1.4.0',
          instanceCount: 2,
          customers: [{ id: CUSTOMER_ID, customerNo: 'CUS-000001', name: '示例客户' }],
        },
      ],
      unknownVersionCount: 1,
    });
  });

  it('forbids a caller without deployment.read', async () => {
    stubFetch(['receivable.read'], { report_deployment_versions: versionReportRow() });

    const response = await call(OPS_ROUTES.getOpsDeploymentVersionReport.path);

    expect(response.status).toBe(403);
  });
});
