import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsSettingsRoutes } from './routes';

/**
 * 设置页的翻译层。范围校验、空补丁、重复值这些**规则**由
 * `supabase/tests/ops_settings_domain.sql` 在真库上断言；这里只测翻译与拒绝的落点：
 *
 * 1. **PATCH 只带真的传了的键。** 把整份 body 传下去，两个人各改一项时会互相覆盖。
 * 2. **越界变 400 + `details.field`**，不是 422、不是 500——设置页的三个输入框
 *    要能各自标红。
 * 3. **字典的读不要 `settings.manage`**，写要。这两条方向相反，只测一侧会把
 *    「下拉框被锁给管理员」当成正常。
 */

const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const ITEM_ID = '00000000-0000-4000-8000-0000000000e1';

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

function settingsRow() {
  return {
    status: 'ok',
    settings: {
      overview_expiry_window_days: 30,
      ticket_due_hours: 48,
      export_retention_days: 90,
    },
    updated_by: null,
    updated_at: '2026-10-31T08:00:00+00:00',
  };
}

const paymentMethodsRow = {
  status: 'ok',
  items: [
    {
      code: 'payment_methods',
      name: '收款方式',
      items: [
        {
          id: ITEM_ID,
          value: 'bank_transfer',
          label: '银行转账',
          sort_order: 10,
          is_active: true,
        },
      ],
    },
  ],
};

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
app.route('/', opsSettingsRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
  path?: string;
}

async function call(routePath: string, options: CallOptions = {}) {
  const url = new URL(options.path ?? routePath, 'http://ops.test');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.append(key, value);
  }

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/v1/ops/settings', () => {
  it('translates the three settings and keeps updatedBy null', async () => {
    stubFetch(['settings.manage'], { get_ops_settings: settingsRow() });

    const response = await call(OPS_ROUTES.getOpsSettings.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      settings: {
        overviewExpiryWindowDays: 30,
        ticketDueHours: 48,
        exportRetentionDays: 90,
      },
      updatedBy: null,
    });
  });

  it('turns updatedBy into an operator object rather than a bare uuid', async () => {
    stubFetch(['settings.manage'], {
      get_ops_settings: {
        ...settingsRow(),
        updated_by: { id: OPERATOR_ID, display_name: '平台管理员' },
      },
    });

    const response = await call(OPS_ROUTES.getOpsSettings.path);

    expect(response.body.updatedBy).toEqual({ id: OPERATOR_ID, displayName: '平台管理员' });
  });

  it('forbids a caller without settings.manage and never reaches the RPC', async () => {
    stubFetch(['customer.read'], { get_ops_settings: settingsRow() });

    const response = await call(OPS_ROUTES.getOpsSettings.path);

    expect(response.status).toBe(403);
    expect(rpcBodies).toHaveLength(0);
  });
});

describe('PATCH /api/v1/ops/settings', () => {
  it('sends only the keys that were provided', async () => {
    stubFetch(['settings.manage'], { update_ops_settings: settingsRow() });

    await call(OPS_ROUTES.updateOpsSettings.path, {
      method: 'PATCH',
      idempotencyKey: 'idem-settings-1',
      body: { ticketDueHours: 60 },
    });

    expect(rpcBodies[0]?.body).toMatchObject({ p_patch: { ticketDueHours: 60 } });
    expect(rpcBodies[0]?.body.p_patch).not.toHaveProperty('overviewExpiryWindowDays');
    expect(rpcBodies[0]?.body.p_patch).not.toHaveProperty('exportRetentionDays');
  });

  it('requires an Idempotency-Key', async () => {
    stubFetch(['settings.manage'], { update_ops_settings: settingsRow() });

    const response = await call(OPS_ROUTES.updateOpsSettings.path, {
      method: 'PATCH',
      body: { ticketDueHours: 60 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { field: 'Idempotency-Key' } });
    expect(rpcBodies).toHaveLength(0);
  });

  /*
   * 越界与未知键**都在 zod 那层就被挡住**（schema 带 min/max 且是 strictObject），
   * 所以这两条断言的是「400 且没有打到 RPC」。SQL 侧那两个分支
   * （`out_of_range` / `unknown_key`）不是给 HTTP 调用方用的，是给「绕过端点的
   * 调用」兜底的——`ops.update_ops_settings` 只对 authenticated 开放，任何持有
   * 用户令牌的东西都能直接 POST 到 `/rpc/`。
   *
   * 写清楚这一点比让它看起来被测过重要：把注释放成「RPC 会回 OUT_OF_RANGE」，
   * 下一个改 schema 的人会以为有测试守着。
   */
  it('rejects an out-of-range value before the RPC sees it', async () => {
    stubFetch(['settings.manage'], { update_ops_settings: settingsRow() });

    const response = await call(OPS_ROUTES.updateOpsSettings.path, {
      method: 'PATCH',
      idempotencyKey: 'idem-settings-2',
      body: { ticketDueHours: 721 },
    });

    expect(response.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('rejects an unknown setting key instead of ignoring it', async () => {
    stubFetch(['settings.manage'], { update_ops_settings: settingsRow() });

    const response = await call(OPS_ROUTES.updateOpsSettings.path, {
      method: 'PATCH',
      idempotencyKey: 'idem-settings-3',
      body: { retentionDays: 30 },
    });

    expect(response.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });

  it('maps the RPC out_of_range envelope to 400 with the field and the bound', async () => {
    // 这条走的是「另一个调用方直接打 RPC」的路径：为让请求通过 zod 而给一个
    // 合法值，再让桩返回越界信封，验的是路由的翻译而不是校验。
    stubFetch(['settings.manage'], {
      update_ops_settings: {
        status: 'out_of_range',
        field: 'ticketDueHours',
        value: 900,
        min: 1,
        max: 720,
      },
    });

    const response = await call(OPS_ROUTES.updateOpsSettings.path, {
      method: 'PATCH',
      idempotencyKey: 'idem-settings-4',
      body: { ticketDueHours: 60 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'OUT_OF_RANGE', field: 'ticketDueHours', min: 1, max: 720 },
    });
  });
});

describe('GET /api/v1/ops/dictionaries', () => {
  it('translates the nested items', async () => {
    stubFetch(['settings.manage'], { list_dictionaries: paymentMethodsRow });

    const response = await call(OPS_ROUTES.listOpsDictionaries.path);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [
        {
          code: 'payment_methods',
          name: '收款方式',
          items: [{ id: ITEM_ID, value: 'bank_transfer', sortOrder: 10, isActive: true }],
        },
      ],
    });
  });

  it('passes the code filter through', async () => {
    stubFetch(['settings.manage'], { list_dictionaries: paymentMethodsRow });

    await call(OPS_ROUTES.listOpsDictionaries.path, { query: { code: 'payment_methods' } });

    expect(rpcBodies[0]?.body).toMatchObject({ p_code: 'payment_methods' });
  });

  it('reads the dictionaries without settings.manage', async () => {
    // 契约 §5.9：字典的读对「任意已认证运营成员」开放。没有这一条，
    // 「创建工单的人取不到问题类型」会被当成设计。
    stubFetch(['ticket.create'], { list_dictionaries: paymentMethodsRow });

    const response = await call(OPS_ROUTES.listOpsDictionaries.path);

    expect(response.status).toBe(200);
  });

  it('turns the forbidden envelope into 403', async () => {
    stubFetch([], { list_dictionaries: { status: 'forbidden' } });

    const response = await call(OPS_ROUTES.listOpsDictionaries.path);

    expect(response.status).toBe(403);
  });
});

describe('POST /api/v1/ops/dictionaries/:code/items', () => {
  const path = OPS_ROUTES.createOpsDictionaryItem.path.replace(':code', 'payment_methods');

  it('returns the created item', async () => {
    stubFetch(['settings.manage'], {
      create_dictionary_item: {
        status: 'ok',
        item: {
          id: ITEM_ID,
          value: 'unionpay',
          label: '银联',
          sort_order: 100,
          is_active: true,
        },
      },
    });

    const response = await call(path, {
      method: 'POST',
      idempotencyKey: 'idem-dict-1',
      body: { value: 'unionpay', label: '银联' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      item: { value: 'unionpay', sortOrder: 100, isActive: true },
    });
    // sortOrder 不传时不能变成 0：0 会被排到最前面，把运营排好的顺序打乱。
    expect(rpcBodies[0]?.body).toMatchObject({ p_sort_order: null });
  });

  it('turns a duplicate value into 409 with the existing item id', async () => {
    stubFetch(['settings.manage'], {
      create_dictionary_item: { status: 'duplicate_value', value: 'unionpay', item_id: ITEM_ID },
    });

    const response = await call(path, {
      method: 'POST',
      idempotencyKey: 'idem-dict-2',
      body: { value: 'unionpay', label: '银联' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { itemId: ITEM_ID } });
  });

  it('turns an unknown dictionary code into 404', async () => {
    stubFetch(['settings.manage'], {
      create_dictionary_item: { status: 'dictionary_not_found', code: 'no_such' },
    });

    const response = await call(path, {
      method: 'POST',
      idempotencyKey: 'idem-dict-3',
      body: { value: 'x', label: 'X' },
    });

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/v1/ops/dictionary-items/:itemId', () => {
  const path = OPS_ROUTES.updateOpsDictionaryItem.path.replace(':itemId', ITEM_ID);

  it('sends only the provided fields', async () => {
    stubFetch(['settings.manage'], {
      update_dictionary_item: {
        status: 'ok',
        item: {
          id: ITEM_ID,
          value: 'unionpay',
          label: '银联云闪付',
          sort_order: 100,
          is_active: true,
        },
      },
    });

    const response = await call(path, {
      method: 'PATCH',
      body: { label: '银联云闪付' },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toMatchObject({ p_patch: { label: '银联云闪付' } });
    expect(rpcBodies[0]?.body.p_patch).not.toHaveProperty('isActive');
  });

  it('turns an unknown item id into 404', async () => {
    stubFetch(['settings.manage'], { update_dictionary_item: { status: 'not_found' } });

    const response = await call(path, { method: 'PATCH', body: { label: 'x' } });

    expect(response.status).toBe(404);
  });

  it('rejects an empty patch at the contract layer', async () => {
    stubFetch(['settings.manage'], {
      update_dictionary_item: {
        status: 'ok',
        item: { id: ITEM_ID, value: 'x', label: 'X', sort_order: 0, is_active: true },
      },
    });

    const response = await call(path, { method: 'PATCH', body: {} });

    expect(response.status).toBe(400);
    expect(rpcBodies).toHaveLength(0);
  });
});
