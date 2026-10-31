import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { toCsv } from './runner';
import { opsExportsRoutes } from './routes';

/**
 * 导出域的翻译层与执行器。
 *
 * 分两半测，因为它们的失败方式不同：
 *
 * - **路由**：202 的语义、`downloadUrl` 什么时候给、`Location` 头对不对。这些
 *   都是「形状」问题，一旦错了前端会以误解的方式工作（比如把 202 当 200，
 *   立刻去读 `downloadUrl`）。
 * - **执行器**：CSV 的转义与 BOM、失败要落成 `failed` 而不是只打日志。这部分
 *   的真库行为在 `supabase/tests/ops_exports_domain.sql` 里；这里只测 Node 侧
 *   那段——它没有 SQL 可以依赖。
 *
 * 权限与状态机**不在这里断**：`export.read` / `export.create` 的分离、发起人
 * 失权后取数被拒，都发生在 SQL 里，放在 pgTAP 断才有效。
 */

const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const EXPORT_ID = '00000000-0000-4000-8000-0000000000f1';

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'admin@example.test',
    operator_display_name: '平台管理员',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: permissions,
  };
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    export_no: 'EXP-000001',
    export_type: 'customers',
    filters: {},
    status: 'queued',
    row_count: null,
    storage_path: null,
    requested_by: { id: OPERATOR_ID, display_name: '平台管理员' },
    created_at: '2026-10-31T08:00:00+00:00',
    completed_at: null,
    expires_at: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Recorded {
  rpc: Array<{ name: string; body: Record<string, unknown> }>;
  puts: Array<{ url: string; body: string }>;
}

const recorded: Recorded = { rpc: [], puts: [] };

/**
 * 按 URL 分派的 stub。
 *
 * `claim_export` 的默认答案必须是 `empty`：每个 `GET` 都会先跑一次懒执行，
 * 而绝大多数用例关心的不是执行——给一个「有任务」的默认值会让每个列表用例
 * 都顺带跑一遍上传，测的东西就不止一件了。
 */
function stubFetch(permissions: string[], rpc: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // PUT 必须先判：签名上传的地址本身也含 `/object/upload/sign/`，先判它
    // 会把上传请求当成又一次「要签名」，于是 PUT 永远不发出、测试却全绿。
    if (init?.method === 'PUT') {
      recorded.puts.push({ url, body: String(init.body ?? '') });
      return json({ Key: 'ops-exports/exports/EXP-000001.csv' });
    }
    if (url.includes('/storage/v1/object/upload/sign/')) {
      return json({ url: '/object/upload/sign/ops-exports/exports/EXP-000001.csv?token=stub' });
    }
    if (url.includes('/storage/v1/object/sign/')) {
      return json({ signedURL: '/object/sign/ops-exports/exports/EXP-000001.csv?token=stub' });
    }

    const rpcName = url.split('/rpc/')[1]?.split('?')[0];
    if (rpcName === 'get_current_ops_context') return json([opsContextRow(permissions)]);
    if (!rpcName) throw new Error(`unexpected request: ${url}`);

    recorded.rpc.push({
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
app.route('/', opsExportsRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  method?: 'GET' | 'POST';
  query?: string;
  body?: unknown;
  idempotencyKey?: string;
  path?: string;
}

async function call(routePath: string, options: CallOptions = {}) {
  const url = new URL(options.path ?? routePath, 'http://ops.test');
  if (options.query) url.search = options.query;

  const headers: Record<string, string> = { Authorization: 'Bearer token' };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await app.request(
    url.toString(),
    {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
    env,
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    headers: response.headers,
  };
}

const ALL_EXPORT_PERMISSIONS = ['export.read', 'export.create'];

beforeEach(() => {
  recorded.rpc.length = 0;
  recorded.puts.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/v1/ops/exports', () => {
  it('answers 202 with a job that is not downloadable yet', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      create_export: {
        status: 'ok',
        export: {
          id: EXPORT_ID,
          export_no: 'EXP-000001',
          export_type: 'customers',
          status: 'queued',
        },
      },
    });

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      export: { id: EXPORT_ID, exportNo: 'EXP-000001', exportType: 'customers', status: 'queued' },
    });
  });

  it('points Location at the detail endpoint so the caller knows what to poll', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      create_export: {
        status: 'ok',
        export: {
          id: EXPORT_ID,
          export_no: 'EXP-000001',
          export_type: 'customers',
          status: 'queued',
        },
      },
    });

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(response.headers.get('Location')).toBe(`/api/v1/ops/exports/${EXPORT_ID}`);
  });

  it('sends an empty object when filters are omitted', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      create_export: {
        status: 'ok',
        export: {
          id: EXPORT_ID,
          export_no: 'EXP-000001',
          export_type: 'customers',
          status: 'queued',
        },
      },
    });

    await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(recorded.rpc[0]?.body.p_filters).toEqual({});
  });

  it('rejects a missing Idempotency-Key before touching the database', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {});

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(response.status).toBe(400);
    expect(recorded.rpc).toHaveLength(0);
  });

  it('rejects a whitespace-only reason in zod, before the RPC sees it', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {});

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '   ' },
    });

    expect(response.status).toBe(400);
    expect(recorded.rpc).toHaveLength(0);
  });

  it('answers 403 when the operator cannot create exports', async () => {
    stubFetch(['export.read'], {});

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(response.status).toBe(403);
    expect(recorded.rpc).toHaveLength(0);
  });

  it('translates an unsupported type into a locatable 400', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      create_export: { status: 'unsupported_type', export_type: 'invoices' },
    });

    const response = await call(OPS_ROUTES.createOpsExport.path, {
      method: 'POST',
      idempotencyKey: 'idem-1',
      body: { exportType: 'customers', reason: '月度盘点' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'UNSUPPORTED_TYPE' } });
  });
});

describe('GET /api/v1/ops/exports', () => {
  it('translates the row and hands back the requester as an object', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: { status: 'empty' },
      list_exports: { status: 'ok', items: [exportRow({ row_count: 2, status: 'succeeded' })] },
    });

    const response = await call(OPS_ROUTES.listOpsExports.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [
        {
          exportNo: 'EXP-000001',
          exportType: 'customers',
          status: 'succeeded',
          rowCount: 2,
          requestedBy: { id: OPERATOR_ID, displayName: '平台管理员' },
        },
      ],
    });
  });

  it('sends every repeated status parameter, not just the first one', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: { status: 'empty' },
      list_exports: { status: 'ok', items: [] },
    });

    await call(OPS_ROUTES.listOpsExports.path, {
      query: '?status=failed&status=succeeded&exportType=receipts',
    });

    const list = recorded.rpc.find((entry) => entry.name === 'list_exports');
    expect(list?.body).toMatchObject({
      p_statuses: ['failed', 'succeeded'],
      p_export_type: 'receipts',
    });
  });

  it('runs one queued job before answering the list', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: { status: 'empty' },
      list_exports: { status: 'ok', items: [] },
    });

    await call(OPS_ROUTES.listOpsExports.path);

    // 顺序有意义：先推进再读，否则刚认领的那条会以「还在跑」的旧状态出现在列表里。
    expect(recorded.rpc.map((entry) => entry.name)).toEqual(['claim_export', 'list_exports']);
  });
});

describe('GET /api/v1/ops/exports/{exportId}', () => {
  const detailRpcs = {
    claim_export: { status: 'empty' },
    get_export: {
      status: 'ok',
      export: exportRow({
        status: 'succeeded',
        row_count: 2,
        storage_path: 'exports/EXP-000001.csv',
        completed_at: '2026-10-31T08:00:00+00:00',
        expires_at: '2027-01-29T08:00:00+00:00',
      }),
      can_download: true,
    },
  };

  it('signs a download URL when the caller may read that domain', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, detailRpcs);

    const response = await call(`${OPS_ROUTES.getOpsExport.path.replace(':exportId', EXPORT_ID)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      downloadUrl: expect.stringContaining('/storage/v1/object/sign/ops-exports/'),
      expiresAt: '2027-01-29T08:00:00+00:00',
    });
  });

  it('withholds the URL when can_download is false, without asking storage', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      ...detailRpcs,
      get_export: { ...detailRpcs.get_export, can_download: false },
    });

    const response = await call(`${OPS_ROUTES.getOpsExport.path.replace(':exportId', EXPORT_ID)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ downloadUrl: null, downloadExpiresAt: null });
  });

  it('withholds the URL for an expired job even when the caller may read the domain', async () => {
    stubFetch(['export.read', 'customer.read'], {
      ...detailRpcs,
      get_export: {
        ...detailRpcs.get_export,
        export: exportRow({
          status: 'expired',
          row_count: 2,
          storage_path: 'exports/EXP-000001.csv',
          completed_at: '2026-10-31T08:00:00+00:00',
          expires_at: '2026-11-30T08:00:00+00:00',
        }),
      },
    });

    const response = await call(`${OPS_ROUTES.getOpsExport.path.replace(':exportId', EXPORT_ID)}`);

    // 过期行的 `expires_at` 在过去。若这里仍签地址，`settings.retention.exportDays`
    // 就形同虚设——保留期管的是「还能不能拿到」，不是「状态字段写什么」。
    expect(response.body).toMatchObject({ downloadUrl: null });
  });

  it('answers 404 for an unknown job', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: { status: 'empty' },
      get_export: { status: 'not_found' },
    });

    const response = await call(`${OPS_ROUTES.getOpsExport.path.replace(':exportId', EXPORT_ID)}`);

    expect(response.status).toBe(404);
  });
});

describe('toCsv', () => {
  it('starts with a BOM so Excel opens Chinese text as UTF-8', () => {
    expect(toCsv([{ name: '甲' }]).startsWith('\uFEFF')).toBe(true);
  });

  it('collects the header from every row, not just the first one', () => {
    // `note` 出现在第二行。取第一行的键会让整列消失，而消失的方式是不报错。
    const csv = toCsv([{ id: 1 }, { id: 2, note: '补充' }]);
    const [header] = csv.replace('\uFEFF', '').split('\r\n');

    expect(header).toBe('id,note');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    const csv = toCsv([{ note: 'a,b', other: 'say "hi"', third: 'line1\nline2' }]);

    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it('serialises nested objects instead of flattening them', () => {
    expect(toCsv([{ customer: { name: '甲' } }])).toContain('"{""name"":""甲""}"');
  });

  it('writes an empty cell for null and an empty file for no rows', () => {
    expect(toCsv([{ id: null }]).replace('\uFEFF', '')).toBe('id\r\n\r\n');
    expect(toCsv([]).replace('\uFEFF', '')).toBe('\r\n');
  });
});

describe('the runner', () => {
  it('fetches, uploads and finishes a claimed job', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: {
        status: 'ok',
        export: {
          id: EXPORT_ID,
          export_no: 'EXP-000001',
          export_type: 'customers',
          filters: {},
          status: 'running',
          requested_by: OPERATOR_ID,
        },
      },
      export_fetch_rows: {
        status: 'ok',
        row_count: 2,
        rows: [
          { id: 'c1', name: '导出测试客户甲' },
          { id: 'c2', name: '导出测试客户乙' },
        ],
      },
      finish_export: {
        status: 'ok',
        export: exportRow({ status: 'succeeded', row_count: 2 }),
      },
      list_exports: { status: 'ok', items: [] },
    });

    await call(OPS_ROUTES.listOpsExports.path);

    expect(recorded.puts).toHaveLength(1);
    expect(recorded.puts[0]?.url).toContain('/object/upload/sign/ops-exports/');
    expect(recorded.puts[0]?.body).toContain('导出测试客户甲');
    expect(recorded.rpc.map((entry) => entry.name)).toEqual([
      'claim_export',
      'export_fetch_rows',
      'finish_export',
      'list_exports',
    ]);
  });

  it('aborts with a stable reason when the requester lost the domain permission', async () => {
    stubFetch(ALL_EXPORT_PERMISSIONS, {
      claim_export: {
        status: 'ok',
        export: {
          id: EXPORT_ID,
          export_no: 'EXP-000001',
          export_type: 'tickets',
          filters: {},
          status: 'running',
          requested_by: OPERATOR_ID,
        },
      },
      export_fetch_rows: { status: 'forbidden', required_permission: 'ticket.read' },
      abort_export: { status: 'ok' },
      list_exports: { status: 'ok', items: [] },
    });

    await call(OPS_ROUTES.listOpsExports.path);

    const abort = recorded.rpc.find((entry) => entry.name === 'abort_export');
    expect(abort?.body.p_reason).toBe('REQUESTER_LOST_PERMISSION');
    expect(recorded.puts).toHaveLength(0);
  });

  it('aborts instead of throwing when storage is unreachable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('get_current_ops_context'))
        return json([opsContextRow(ALL_EXPORT_PERMISSIONS)]);
      if (url.includes('/storage/v1/object/upload/sign/')) return json({}, 500);
      const rpcName = url.split('/rpc/')[1]?.split('?')[0];
      if (rpcName) {
        recorded.rpc.push({
          name: rpcName,
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
      }
      if (rpcName === 'claim_export') {
        return json({
          status: 'ok',
          export: {
            id: EXPORT_ID,
            export_no: 'EXP-000001',
            export_type: 'customers',
            filters: {},
            status: 'running',
            requested_by: OPERATOR_ID,
          },
        });
      }
      if (rpcName === 'export_fetch_rows') return json({ status: 'ok', row_count: 0, rows: [] });
      if (rpcName === 'abort_export') return json({ status: 'ok' });
      if (rpcName === 'list_exports') return json({ status: 'ok', items: [] });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await call(OPS_ROUTES.listOpsExports.path);

    // 关键：这是 200 而不是 5xx。导出坏了不该让导出列表打不开——用户要在
    // 列表里看到「这条失败了」，而不是一个错误页。
    expect(response.status).toBe(200);
    const abort = recorded.rpc.find((entry) => entry.name === 'abort_export');
    expect(abort?.body.p_reason).toBe('STORAGE_UNAVAILABLE');
  });
});
