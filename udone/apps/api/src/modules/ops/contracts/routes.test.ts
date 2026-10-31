import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsContractRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 的信封 → 契约的状态码 / 错误码 / 字段名。
 *
 * 它不测「规则是否成立」——客户资格、条目合计、`sales_mode` 是否启用、`renewal_not_due`
 * 的判定窗口都由 pgTAP 在真实库上断言。同一条规则在两处各测一遍，只会得到一个错觉：
 * 以为改了库还安全，因为这里是绿的。
 *
 * 有三类例外确实属于本层：
 *   1. **入站形状**：`strictObject` 拒绝未知字段（`amount` 必须是 400）、query 枚举
 *      非法必须 400（不能静默返回全集）、价格必须是 number；
 *   2. **幂等键**：全局中间件对缺键请求放行，八个写端点的 400 只能在这里证明；
 *   3. **URL 拼装**：`uploadUrl` 的前缀、路径编码与过期时间（§8）。
 */

const CONTRACT_ID = '00000000-0000-4000-8000-000000000401';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000402';
const PACKAGE_ID = '00000000-0000-4000-8000-000000000403';
const PRICE_VERSION_ID = '00000000-0000-4000-8000-000000000404';
const AMENDMENT_ID = '00000000-0000-4000-8000-000000000405';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000406';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = ['contract.read', 'contract.write', 'contract.approve'];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'admin@example.test',
    operator_display_name: '管理员',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 3,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: permissions,
  };
}

function contractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTRACT_ID,
    contract_no: 'HT-000001',
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    sales_owner: { id: OPERATOR_ID, display_name: '管理员', email: 'admin@example.test' },
    sales_mode: 'saas',
    currency: 'CNY',
    // numeric 出来是 number，不是 "25600.00"。
    total_amount: 25600,
    payment_terms: '签约后 15 日内',
    tax_note: null,
    business_note: null,
    status: 'draft',
    signed_on: null,
    effective_on: null,
    expires_on: '2027-10-31',
    renewed_from_contract_id: null,
    status_reason: null,
    // 草稿没有版本快照，所以是 0 而不是 1。
    current_version_no: 0,
    version: 1,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function contractItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000407',
    line_no: 1,
    product_id: null,
    package_id: PACKAGE_ID,
    package_price_version_id: PRICE_VERSION_ID,
    sales_mode: 'saas',
    billing_type: 'periodic',
    quantity: 2,
    unit_price: 12800,
    amount: 25600,
    term_months: 12,
    item_name_snapshot: '标准版套餐',
    ...overrides,
  };
}

function attachmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTACHMENT_ID,
    contract_id: CONTRACT_ID,
    file_name: '合同扫描件.pdf',
    content_type: 'application/pdf',
    byte_size: 2048,
    storage_path: `contracts/${CONTRACT_ID}/${ATTACHMENT_ID}/合同扫描件.pdf`,
    checksum_sha256: null,
    status: 'pending',
    access_scope: 'contract.read',
    uploaded_by: OPERATOR_ID,
    uploaded_at: '2026-10-03T02:00:00+00:00',
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000408',
    version_no: 1,
    snapshot: { contract: { status: 'active' }, items: [], entitlementLines: [] },
    change_reason: 'activate',
    created_by: OPERATOR_ID,
    created_at: '2026-10-03T02:00:00+00:00',
    ...overrides,
  };
}

function amendmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AMENDMENT_ID,
    contract_id: CONTRACT_ID,
    amendment_no: 1,
    reason: '客户追加 100 个行程额度',
    before_summary: { quota: 100 },
    after_summary: { quota: 200 },
    status: 'draft',
    requested_by: OPERATOR_ID,
    approved_by: null,
    approved_at: null,
    applied_version_no: null,
    version: 1,
    created_at: '2026-10-03T02:00:00+00:00',
    updated_at: '2026-10-03T02:00:00+00:00',
    ...overrides,
  };
}

/** §5：三张未落地的表在这一轮恒返回 0。 */
const impact = { receivables: 0, entitlements: 0, tenant_commands: 0 };

interface StubOptions {
  permissions?: string[];
  /** `rpc/<name>` → 响应体。没给的名字一律当作「不该被调用」。 */
  rpc?: Record<string, unknown>;
  /**
   * 存储签名端点的行为。`fail` 用来证明「拿不到签名时回 503，而不是回一个
   * 点不开的地址」——后者会 201，客户端以为传成功了。
   */
  storage?: 'ok' | 'fail';
}

/**
 * 存储签名的桩。
 *
 * 单测不启动本地 Storage 替身（它有自己的行为测试，跑在 `pnpm test` 里），
 * 这里只负责回形状：上传回 `{url}`、下载回 `{signedURL}`，都是 Supabase 的
 * 相对路径，且**路径原样带回**——`uploadUrl` 的按段编码与层级断言只有原样
 * 带回才验得到真正的拼装。
 */
function stubStorageSign(url: string) {
  const upload = url.includes('/object/upload/sign/');
  const marker = upload ? '/object/upload/sign/' : '/object/sign/';
  const key = url.slice(url.indexOf(marker) + marker.length);
  // 两个字段都带 token：Supabase 的上传签名把 token 同时放进 `url` 与 `token`
  // 两个键。只回 `url` 而不带 token 的桩会让「上传地址是否可直用」这条断言
  // 永远绿——因为它根本没法被点开。
  return upload
    ? { url: `${marker}${key}?token=stub-token`, token: 'stub-token' }
    : { signedURL: `${marker}${key}?token=stub-token` };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 每次 RPC 调用的请求体。
 *
 * 契约字段是否真的透传下去（`p_items` 是不是 snake_case 的 jsonb、`[]` 与「没传」
 * 是否分开、`p_items_provided` 是否跟着变）只能从请求体看出来。
 */
const rpcBodies: Array<{ name: string; body: Record<string, unknown> }> = [];

function stubFetch(options: StubOptions = {}) {
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const called: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('/storage/v1/object/')) {
      if (options.storage === 'fail') {
        return json({ statusCode: '500', error: 'InternalError', message: 'boom' }, 500);
      }
      return json(stubStorageSign(url));
    }

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
app.route('/', opsContractRoutes);

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
  /**
   * 额外绑定。`OPS_STORAGE_PUBLIC_URL` 还没进 `ApiEnvironment['Bindings']`
   * （那属于 `middleware/auth.ts`，不在本轮写边界里），所以在这里显式补上。
   */
  bindings?: Partial<ApiEnvironment['Bindings']> & { OPS_STORAGE_PUBLIC_URL?: string };
}

/** 八个必填幂等键的写端点之外的用例也带上不会错——中间件对带了 key 的请求只做回放判定。 */
const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-contract-0001' };

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
    { ...env, ...options.bindings },
  );
  const text = await response.text();
  // 未匹配到任何路由时 Hono 回的是纯文本 404，不是 JSON。
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

/** 路径一律从注册表取：测试里手写路径会让「清单改了、测试没改」悄悄通过。 */
function path(template: string, values: Record<string, string> = {}): string {
  let result = template;
  for (const [name, value] of Object.entries({
    contractId: CONTRACT_ID,
    amendmentId: AMENDMENT_ID,
    attachmentId: ATTACHMENT_ID,
    ...values,
  })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

/** 一条合法的合同条目（两处引用 + 数量 + 单价）。 */
const ITEM_BODY = {
  packageId: PACKAGE_ID,
  priceVersionId: PRICE_VERSION_ID,
  quantity: 2,
  unitPrice: 12800,
  termMonths: 12,
};

afterEach(() => {
  vi.unstubAllGlobals();
  rpcBodies.length = 0;
});

describe('route registry', () => {
  it('keeps the fourteen contract keys on the documented method and path', () => {
    const keys = [
      'listOpsContracts',
      'createOpsContract',
      'getOpsContract',
      'updateOpsContract',
      'transitionOpsContract',
      'listOpsContractVersions',
      'createOpsContractAmendment',
      'transitionOpsContractAmendment',
      'createOpsContractRenewal',
      'getOpsContractEntitlementPreview',
      'listOpsContractAttachments',
      'createOpsContractAttachment',
      'completeOpsContractAttachment',
      'accessOpsContractAttachment',
    ] as const satisfies readonly (keyof typeof OPS_ROUTES)[];

    expect(keys).toHaveLength(14);
    expect(
      Object.fromEntries(
        keys.map((key) => [key, `${OPS_ROUTES[key].method} ${OPS_ROUTES[key].path}`]),
      ),
    ).toEqual({
      listOpsContracts: 'GET /api/v1/ops/contracts',
      createOpsContract: 'POST /api/v1/ops/contracts',
      getOpsContract: 'GET /api/v1/ops/contracts/:contractId',
      updateOpsContract: 'PATCH /api/v1/ops/contracts/:contractId',
      transitionOpsContract: 'POST /api/v1/ops/contracts/:contractId/transition',
      listOpsContractVersions: 'GET /api/v1/ops/contracts/:contractId/versions',
      createOpsContractAmendment: 'POST /api/v1/ops/contracts/:contractId/amendments',
      transitionOpsContractAmendment:
        'POST /api/v1/ops/contracts/:contractId/amendments/:amendmentId/transition',
      createOpsContractRenewal: 'POST /api/v1/ops/contracts/:contractId/renewals',
      getOpsContractEntitlementPreview: 'GET /api/v1/ops/contracts/:contractId/entitlement-preview',
      listOpsContractAttachments: 'GET /api/v1/ops/contracts/:contractId/attachments',
      createOpsContractAttachment: 'POST /api/v1/ops/contracts/:contractId/attachments',
      completeOpsContractAttachment: 'POST /api/v1/ops/contract-attachments/:attachmentId/complete',
      accessOpsContractAttachment: 'GET /api/v1/ops/contract-attachments/:attachmentId/access',
    });
  });

  it('keeps the attachment endpoints off the /contracts/{id} prefix', async () => {
    // 这两条的前缀写错就是 404，而类型系统抓不到，只能靠断言把它们钉住。
    const called = stubFetch({ rpc: {} });

    const completeUnderContract = await call(
      `/api/v1/ops/contracts/${CONTRACT_ID}/contract-attachments/${ATTACHMENT_ID}/complete`,
      { method: 'POST', headers: IDEMPOTENCY_KEY, body: {} },
    );
    const accessUnderContract = await call(
      `/api/v1/ops/contracts/${CONTRACT_ID}/contract-attachments/${ATTACHMENT_ID}/access`,
    );

    expect(completeUnderContract.status).toBe(404);
    expect(accessUnderContract.status).toBe(404);
    expect(called).toEqual([]);
  });
});

describe('GET /api/v1/ops/contracts', () => {
  it('maps the list and forwards every filter, including repeated status values', async () => {
    stubFetch({
      rpc: { list_contracts: { status: 'ok', items: [contractRow()], total: 1 } },
    });

    const response = await call(OPS_ROUTES.listOpsContracts.path, {
      query: {
        keyword: 'HT-0000',
        customerId: CUSTOMER_ID,
        status: ['draft', 'active'],
        ownerOperatorId: OPERATOR_ID,
        expiresFrom: '2026-11-01',
        expiresTo: '2026-12-01',
        salesMode: 'saas',
        page: '2',
        pageSize: '20',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 1, page: 2, pageSize: 20 });
    expect(response.body.items[0]).toMatchObject({
      contractNo: 'HT-000001',
      totalAmount: 25600,
      customer: { customerNo: 'CUS-000001', name: '示例旅行社' },
      salesOwner: { displayName: '管理员' },
      currentVersionNo: 0,
      version: 1,
    });
    // `status` 是重复参数：`req.query()` 只会留下 'draft'，那样就是「筛了一半」。
    expect(rpcBodies[0]?.body).toEqual({
      p_keyword: 'HT-0000',
      p_customer_id: CUSTOMER_ID,
      p_statuses: ['draft', 'active'],
      p_owner: OPERATOR_ID,
      p_expires_from: '2026-11-01',
      p_expires_to: '2026-12-01',
      p_sales_mode: 'saas',
      p_page: 2,
      p_page_size: 20,
    });
  });

  it('rejects an unknown status instead of silently listing everything', async () => {
    const called = stubFetch({ rpc: {} });

    // `activ` 拼错：静默忽略会返回全集，页面看起来像「筛选没生效」。
    const response = await call(OPS_ROUTES.listOpsContracts.path, {
      query: { status: 'activ' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('refuses a reader without contract.read before touching the directory', async () => {
    const called = stubFetch({ permissions: ['contract.write'], rpc: {} });

    const response = await call(OPS_ROUTES.listOpsContracts.path);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'contract.read' },
    });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/contracts', () => {
  const body = {
    customerId: CUSTOMER_ID,
    salesMode: 'saas',
    paymentTerms: '签约后 15 日内',
    items: [ITEM_BODY],
  };

  it('returns 201 and sends items as snake_case jsonb without an amount', async () => {
    stubFetch({ rpc: { create_contract: { status: 'ok', contract: contractRow() } } });

    const response = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      contract: { contractNo: 'HT-000001', totalAmount: 25600, status: 'draft' },
    });
    expect(typeof response.body.contract.totalAmount).toBe('number');
    expect(rpcBodies[0]?.body).toMatchObject({
      p_customer_id: CUSTOMER_ID,
      p_sales_mode: 'saas',
      p_currency: null,
      p_tax_note: null,
      // 条目的 jsonb 是**驼峰**（`contract_items_normalize` 按 §4 的入参名读）；
      // 传列名口径会让每个引用变成 null，金额静默算成 0。
      p_items: [
        {
          productId: null,
          packageId: PACKAGE_ID,
          priceVersionId: PRICE_VERSION_ID,
          quantity: 2,
          unitPrice: 12800,
          termMonths: 12,
        },
      ],
    });
    // 金额由 SQL 重算（§4）：请求体里根本不该有这个键。
    expect((rpcBodies[0]?.body.p_items as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'amount',
    );
    // 本域 RPC 的签名里没有 `p_request_id`：多传一个参数 PostgREST 会判「函数不存在」。
    expect(rpcBodies[0]?.body).not.toHaveProperty('p_request_id');
  });

  it('rejects a create without Idempotency-Key before any write can happen', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsContract.path, { method: 'POST', body });

    // 全局幂等中间件对没有 key 的请求直接放行，所以这条拒绝只能在 handler 里。
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects an amount in the request body at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      // 客户端自己算金额是这次「服务端重算」要防的事；收下再丢掉会让它以为生效了。
      body: { ...body, items: [{ ...ITEM_BODY, amount: 25600 }] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects a string price at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, items: [{ ...ITEM_BODY, unitPrice: '12800.00' }] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects an item that references nothing', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, items: [{ quantity: 1 }] },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('maps the five refusals to their documented codes', async () => {
    stubFetch({ rpc: { create_contract: { status: 'customer_not_found' } } });
    const noCustomer = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
    });

    stubFetch({ rpc: { create_contract: { status: 'items_required' } } });
    const noItems = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, items: [] },
    });

    stubFetch({ rpc: { create_contract: { status: 'price_mismatch' } } });
    const priceMismatch = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
    });

    stubFetch({
      rpc: { create_contract: { status: 'sales_mode_disabled', sales_mode: 'private' } },
    });
    const modeDisabled = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
    });

    stubFetch({ rpc: { create_contract: { status: 'contract_no_conflict' } } });
    const noConflict = await call(OPS_ROUTES.createOpsContract.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
    });

    expect(noCustomer.status).toBe(404);
    expect(noCustomer.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'customer' } });
    expect(noItems.status).toBe(400);
    expect(noItems.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ITEMS_REQUIRED', field: 'items' },
    });
    expect(priceMismatch.status).toBe(400);
    expect(priceMismatch.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'PRICE_MISMATCH' },
    });
    expect(modeDisabled.status).toBe(400);
    expect(modeDisabled.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODE_DISABLED', salesMode: 'private' },
    });
    expect(noConflict.status).toBe(409);
    expect(noConflict.body).toMatchObject({ code: 'CONFLICT', details: { field: 'contractNo' } });
  });
});

describe('GET /api/v1/ops/contracts/{contractId}', () => {
  it('returns the contract with items and an empty set of deferred-domain arrays', async () => {
    stubFetch({
      rpc: {
        get_contract: {
          status: 'ok',
          contract: contractRow(),
          items: [contractItemRow()],
          receivable_summary: null,
          receivables: [],
          subscriptions: [],
          licenses: [],
          attachments: [attachmentRow()],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsContract.path));

    expect(response.status).toBe(200);
    expect(response.body.contract.id).toBe(CONTRACT_ID);
    expect(response.body.items).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000407',
        lineNo: 1,
        productId: null,
        packageId: PACKAGE_ID,
        priceVersionId: PRICE_VERSION_ID,
        salesMode: 'saas',
        billingType: 'periodic',
        quantity: 2,
        unitPrice: 12800,
        amount: 25600,
        termMonths: 12,
        itemNameSnapshot: '标准版套餐',
      },
    ]);
    // 表不存在时是空数组而不是 null：`null` 与「此刻没有」不可区分。
    expect(response.body.receivables).toEqual([]);
    expect(response.body.subscriptions).toEqual([]);
    expect(response.body.licenses).toEqual([]);
    expect(response.body.attachments[0]).toMatchObject({
      fileName: '合同扫描件.pdf',
      status: 'pending',
      accessScope: 'contract.read',
    });
    expect(rpcBodies[0]?.body).toEqual({ p_contract_id: CONTRACT_ID });
  });

  it('reports a missing contract as 404 with the resource name', async () => {
    stubFetch({ rpc: { get_contract: { status: 'contract_not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsContract.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'contract' } });
  });
});

describe('PATCH /api/v1/ops/contracts/{contractId}', () => {
  const url = path(OPS_ROUTES.updateOpsContract.path);

  it('returns 200 and keeps "no items" distinct from "clear all items"', async () => {
    stubFetch({
      rpc: { update_contract: { status: 'ok', contract: contractRow({ version: 2 }) } },
    });

    const response = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { businessNote: '客户要求分两期付款', version: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ contract: { version: 2 } });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_expected_version: 1,
      p_payment_terms: null,
      p_business_note: '客户要求分两期付款',
      p_expires_on: null,
      p_items: null,
      p_items_provided: false,
    });
  });

  it('sends an empty item array as "provided" so the library can reject it', async () => {
    stubFetch({ rpc: { update_contract: { status: 'items_required' } } });

    const response = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { items: [], version: 1 },
    });

    expect(rpcBodies[0]?.body).toMatchObject({ p_items: [], p_items_provided: true });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ITEMS_REQUIRED' },
    });
  });

  it('rejects a PATCH without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    // 客户域与 catalog 的 PATCH 都是「可选」，本域是「必填」（§5.4）——差异点就在这里。
    const response = await call(url, { method: 'PATCH', body: { businessNote: 'x', version: 1 } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('reports a stale version as 409 CONFLICT with details.currentVersion', async () => {
    stubFetch({ rpc: { update_contract: { status: 'version_mismatch', current_version: 7 } } });

    const response = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { businessNote: 'x', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 7 } });
  });

  it('reports an already-signed contract as 409 STATE_CONFLICT / CONTRACT_IMMUTABLE', async () => {
    stubFetch({
      rpc: { update_contract: { status: 'contract_immutable', current: 'signed' } },
    });

    const response = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { businessNote: 'x', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTRACT_IMMUTABLE', status: 'signed' },
    });
  });

  it('rejects status and amount in the body at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    // 状态只能走 transition；金额由库重算。两者都是「入站非法字段」（400），不是 409。
    const withStatus = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { status: 'signed', version: 1 },
    });
    const withAmount = await call(url, {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { totalAmount: 1, version: 1 },
    });

    expect(withStatus.status).toBe(400);
    expect(withAmount.status).toBe(400);
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/transition', () => {
  const url = path(OPS_ROUTES.transitionOpsContract.path);
  const body = { action: 'submit', reason: '条目已确认，提交审核', version: 1 };

  it('returns 200 with the new status, version and impact', async () => {
    stubFetch({
      rpc: {
        transition_contract: {
          status: 'ok',
          contract: { status: 'reviewing', version: 2 },
          impact,
        },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      contract: { status: 'reviewing', version: 2 },
      impact: { receivables: 0, entitlements: 0, tenantCommands: 0 },
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_action: 'submit',
      p_reason: '条目已确认，提交审核',
      p_confirm_impact: false,
      p_expected_version: 1,
    });
  });

  it('rejects a transition without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('requires contract.approve for sign/activate/terminate/expire', async () => {
    const called = stubFetch({ permissions: ['contract.read', 'contract.write'], rpc: {} });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'activate' },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'contract.approve' },
    });
    expect(called).toEqual([]);
  });

  it('rejects an action outside the closed state machine', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'resume' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('separates version / transition / reference conflicts by code and details', async () => {
    stubFetch({
      rpc: { transition_contract: { status: 'version_mismatch', current_version: 5 } },
    });
    const stale = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({
      rpc: {
        transition_contract: { status: 'invalid_transition', current: 'expired', action: 'submit' },
      },
    });
    const invalid = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({
      rpc: {
        transition_contract: {
          status: 'referenced',
          impact: { receivables: 2, entitlements: 1, tenant_commands: 0 },
        },
      },
    });
    const referenced = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'terminate', confirmImpact: true },
    });

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 5 } });
    expect(invalid.status).toBe(409);
    expect(invalid.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION', current: 'expired', action: 'submit' },
    });
    expect(referenced.status).toBe(409);
    expect(referenced.body).toMatchObject({
      code: 'OBJECT_REFERENCED',
      details: { impact: { receivables: 2, entitlements: 1, tenantCommands: 0 } },
    });
    // 下划线 → 驼峰必须发生在这一层；原样透传会让前端拿到 undefined。
    expect(referenced.body.details.impact).not.toHaveProperty('tenant_commands');
  });

  it('maps the guard failures to 400 with a machine-readable reason', async () => {
    stubFetch({ rpc: { transition_contract: { status: 'customer_not_eligible' } } });
    const ineligible = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({ rpc: { transition_contract: { status: 'total_mismatch' } } });
    const totalMismatch = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({ rpc: { transition_contract: { status: 'items_required' } } });
    const noItems = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(ineligible.body).toMatchObject({ details: { reason: 'CUSTOMER_NOT_ELIGIBLE' } });
    expect(totalMismatch.body).toMatchObject({ details: { reason: 'TOTAL_MISMATCH' } });
    expect(noItems.body).toMatchObject({ details: { reason: 'ITEMS_REQUIRED', field: 'items' } });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { transition_contract: { status: 'contract_not_found' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'contract' } });
  });

  it('reports a vanished customer during submit as 404 on the customer resource', async () => {
    stubFetch({ rpc: { transition_contract: { status: 'customer_not_found' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'customer' } });
  });
});

describe('GET /api/v1/ops/contracts/{contractId}/versions', () => {
  it('maps the snapshot rows without reinterpreting the snapshot', async () => {
    stubFetch({
      rpc: {
        list_contract_versions: {
          status: 'ok',
          items: [versionRow(), versionRow({ version_no: 2, change_reason: 'amendment#1' })],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsContractVersions.path));

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[0]).toMatchObject({
      versionNo: 1,
      changeReason: 'activate',
      createdBy: OPERATOR_ID,
    });
    expect(response.body.items[0].snapshot).toEqual({
      contract: { status: 'active' },
      items: [],
      entitlementLines: [],
    });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { list_contract_versions: { status: 'contract_not_found' } } });

    const response = await call(path(OPS_ROUTES.listOpsContractVersions.path));

    expect(response.status).toBe(404);
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/amendments', () => {
  const url = path(OPS_ROUTES.createOpsContractAmendment.path);
  const body = { reason: '客户追加额度', header: { businessNote: '追加 100 个额度' } };

  it('returns 201 and marks the header as provided', async () => {
    stubFetch({ rpc: { create_contract_amendment: { status: 'ok', amendment: amendmentRow() } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      amendment: { amendmentNo: 1, status: 'draft', reason: '客户追加 100 个行程额度' },
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_reason: '客户追加额度',
      p_header: {
        paymentTerms: null,
        taxNote: null,
        businessNote: '追加 100 个额度',
        expiresOn: null,
      },
      p_header_provided: true,
      p_items: null,
      p_items_provided: false,
    });
  });

  it('rejects a create without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('maps a taken amendment number to 409 CONFLICT on the amendment field', async () => {
    stubFetch({ rpc: { create_contract_amendment: { status: 'amendment_conflict' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'amendment' } });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { create_contract_amendment: { status: 'contract_not_found' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ details: { resource: 'contract' } });
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/amendments/{amendmentId}/transition', () => {
  const url = path(OPS_ROUTES.transitionOpsContractAmendment.path);
  const body = { action: 'approve', reason: '条款已核对', version: 1 };

  it('returns 200 with the amendment status and version', async () => {
    stubFetch({
      rpc: {
        transition_contract_amendment: {
          status: 'ok',
          amendment: { status: 'approved', version: 2 },
        },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ amendment: { status: 'approved', version: 2 } });
    // 路径上的 contractId 必须下传：RPC 用它校验变更单归属，不符返回
    // amendment_not_found。不下传时 `/contracts/{别的合同}/amendments/{id}` 会成功。
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_amendment_id: AMENDMENT_ID,
      p_action: 'approve',
      p_reason: '条款已核对',
      p_expected_version: 1,
    });
  });

  it('rejects a transition without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('maps a missing amendment and a stale version', async () => {
    stubFetch({ rpc: { transition_contract_amendment: { status: 'amendment_not_found' } } });
    const missing = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({
      rpc: { transition_contract_amendment: { status: 'version_mismatch', current_version: 4 } },
    });
    const stale = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ details: { resource: 'amendment' } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 4 } });
  });

  it('maps self-approval to 409 CONFLICT on the amendment field', async () => {
    stubFetch({
      rpc: {
        transition_contract_amendment: {
          status: 'amendment_conflict',
          field: 'amendment',
          reason: 'SELF_APPROVAL',
        },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    // 职责分离（申请人与审批人不能是同一人）。reason 附在 details 里，
    // 否则前端只能说「有冲突」，用户只会重复点同一个按钮。
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { field: 'amendment', reason: 'SELF_APPROVAL' },
    });
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/renewals', () => {
  const url = path(OPS_ROUTES.createOpsContractRenewal.path);
  const body = {
    effectiveOn: '2027-11-01',
    expiresOn: '2028-10-31',
    reason: '年度续约',
  };

  it('returns 201 with the new contract', async () => {
    stubFetch({
      rpc: {
        renew_contract: {
          status: 'ok',
          contract: contractRow({ renewed_from_contract_id: CONTRACT_ID }),
        },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(201);
    expect(response.body.contract.renewedFromContractId).toBe(CONTRACT_ID);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_effective_on: '2027-11-01',
      p_expires_on: '2028-10-31',
      // 不传条目 = 沿用原合同（库复制），不是「新合同没有条目」。
      p_items: null,
      p_force: false,
    });
  });

  it('rejects a renewal without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('maps renewal_not_due to 409 STATE_CONFLICT and can be forced', async () => {
    stubFetch({ rpc: { renew_contract: { status: 'renewal_not_due' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });
    const forced = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, force: true },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'RENEWAL_NOT_DUE' },
    });
    expect(rpcBodies[1]?.body).toMatchObject({ p_force: true });
    // force=true 仍然得到同一个拒绝时，说明库里没认这个参数——不是本层该吞的事。
    expect(forced.status).toBe(409);
  });

  it('maps renewing a draft contract to 409 STATE_CONFLICT', async () => {
    stubFetch({
      rpc: {
        renew_contract: { status: 'invalid_transition', current: 'draft', action: 'renew' },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    // 草稿/评审中的合同还没生效过，续约没有意义——这是状态冲突，不是入站非法。
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION', current: 'draft', action: 'renew' },
    });
  });
});

describe('GET /api/v1/ops/contracts/{contractId}/entitlement-preview', () => {
  it('maps features and the single documented warning code', async () => {
    stubFetch({
      rpc: {
        contract_entitlement_preview: {
          status: 'ok',
          features: [
            {
              // 这条 RPC 的输出是驼峰（§6 的形状），与其他 RPC 的 snake_case 不同。
              featureKey: 'trip.quota',
              displayName: '行程额度',
              enabled: true,
              quota: 200,
              termMonths: 12,
              appliesTo: 'both',
            },
          ],
          warnings: [{ code: 'PACKAGE_NOT_ACTIVE', packageId: PACKAGE_ID }],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsContractEntitlementPreview.path));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      features: [
        {
          featureKey: 'trip.quota',
          displayName: '行程额度',
          enabled: true,
          quota: 200,
          termMonths: 12,
          appliesTo: 'both',
        },
      ],
      warnings: [{ code: 'PACKAGE_NOT_ACTIVE', packageId: PACKAGE_ID }],
    });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { contract_entitlement_preview: { status: 'contract_not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsContractEntitlementPreview.path));

    expect(response.status).toBe(404);
  });
});

describe('GET /api/v1/ops/contracts/{contractId}/attachments', () => {
  it('maps the attachment list', async () => {
    stubFetch({
      rpc: {
        list_contract_attachments: {
          status: 'ok',
          items: [
            attachmentRow(),
            attachmentRow({ status: 'stored', checksum_sha256: 'a'.repeat(64) }),
          ],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsContractAttachments.path));

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items[1]).toMatchObject({ status: 'stored', byteSize: 2048 });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { list_contract_attachments: { status: 'contract_not_found' } } });

    const response = await call(path(OPS_ROUTES.listOpsContractAttachments.path));

    expect(response.status).toBe(404);
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/attachments', () => {
  const url = path(OPS_ROUTES.createOpsContractAttachment.path);
  const body = { fileName: '合同扫描件.pdf', contentType: 'application/pdf', byteSize: 2048 };

  it('returns 201 with a signed upload URL that expires within five minutes', async () => {
    stubFetch({
      rpc: { create_contract_attachment: { status: 'ok', attachment: attachmentRow() } },
    });

    const before = Date.now();
    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body,
      bindings: { OPS_STORAGE_PUBLIC_URL: 'https://storage.test' },
    });

    expect(response.status).toBe(201);
    expect(response.body.attachment).toMatchObject({
      status: 'pending',
      fileName: '合同扫描件.pdf',
    });
    // 前缀与路径：对象路径按段编码，`/` 保持层级、中文文件名被编码。
    expect(response.body.uploadUrl).toMatch(
      /^https:\/\/storage\.test\/storage\/v1\/object\/upload\/sign\/ops-contracts\/contracts\/[0-9a-f-]+\/[0-9a-f-]+\/%E5%90%88%E5%90%8C%E6%89%AB%E6%8F%8F%E4%BB%B6\.pdf\?token=/,
    );
    const expiresAt = Date.parse(response.body.uploadExpiresAt);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_file_name: '合同扫描件.pdf',
      p_content_type: 'application/pdf',
      p_byte_size: 2048,
    });
  });

  it('answers 503 instead of 201 when the storage refuses to sign', async () => {
    // 元数据已经在库里（pending），但上传地址拿不到。回 201 会让客户端以为
    // 「可以开始传了」，而那个 URL 是服务器编出来的——对象永远不会到存储里。
    stubFetch({
      storage: 'fail',
      rpc: { create_contract_attachment: { status: 'ok', attachment: attachmentRow() } },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      details: { reason: 'STORAGE_UNAVAILABLE', bucket: 'ops-contracts' },
    });
  });

  it('falls back to the local storage base when OPS_STORAGE_PUBLIC_URL is unset', async () => {
    stubFetch({
      rpc: { create_contract_attachment: { status: 'ok', attachment: attachmentRow() } },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.body.uploadUrl.startsWith('http://127.0.0.1:54321/')).toBe(true);
  });

  it('rejects a create without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('rejects an oversized attachment with the contract maximum', async () => {
    stubFetch({ rpc: { create_contract_attachment: { status: 'attachment_too_large' } } });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, byteSize: 26_214_401 },
    });

    expect(response.status).toBe(400);
    // 库没回上限时用契约常量兜底：前端要显示「超过 25 MB」。
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ATTACHMENT_TOO_LARGE', maxBytes: 26_214_400 },
    });
  });

  it('rejects a content type outside the whitelist', async () => {
    stubFetch({ rpc: { create_contract_attachment: { status: 'attachment_type_rejected' } } });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, contentType: 'application/zip' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ATTACHMENT_TYPE_REJECTED' },
    });
  });

  it('reports a missing contract as 404', async () => {
    stubFetch({ rpc: { create_contract_attachment: { status: 'contract_not_found' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ details: { resource: 'contract' } });
  });
});

describe('POST /api/v1/ops/contract-attachments/{attachmentId}/complete', () => {
  const url = path(OPS_ROUTES.completeOpsContractAttachment.path);

  it('returns 200 and the stored attachment', async () => {
    stubFetch({
      rpc: {
        complete_contract_attachment: {
          status: 'ok',
          attachment: attachmentRow({ status: 'stored', checksum_sha256: 'b'.repeat(64) }),
        },
      },
    });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { checksumSha256: 'b'.repeat(64) },
    });

    // 不是「新建」，所以是 200 而不是 201。
    expect(response.status).toBe(200);
    expect(response.body.attachment.status).toBe('stored');
    expect(rpcBodies[0]?.body).toMatchObject({
      p_attachment_id: ATTACHMENT_ID,
      p_checksum_sha256: 'b'.repeat(64),
    });
  });

  it('rejects a complete without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body: {} });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('rejects a malformed checksum before it reaches the library', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { checksumSha256: 'not-a-sha256' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('maps not-uploaded and not-found separately', async () => {
    stubFetch({ rpc: { complete_contract_attachment: { status: 'attachment_not_uploaded' } } });
    const notUploaded = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body: {} });

    stubFetch({ rpc: { complete_contract_attachment: { status: 'attachment_not_found' } } });
    const notFound = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body: {} });

    expect(notUploaded.status).toBe(409);
    expect(notUploaded.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'ATTACHMENT_NOT_UPLOADED' },
    });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ details: { resource: 'attachment' } });
  });
});

describe('GET /api/v1/ops/contract-attachments/{attachmentId}/access', () => {
  const url = path(OPS_ROUTES.accessOpsContractAttachment.path);

  it('returns a signed download URL and the access scope', async () => {
    stubFetch({
      rpc: {
        contract_attachment_access: {
          status: 'ok',
          attachment: attachmentRow({ status: 'stored' }),
        },
      },
    });

    const before = Date.now();
    const response = await call(url, {
      bindings: { OPS_STORAGE_PUBLIC_URL: 'https://storage.test' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      accessScope: 'contract.read',
      storagePath: `contracts/${CONTRACT_ID}/${ATTACHMENT_ID}/合同扫描件.pdf`,
    });
    expect(response.body.url).toMatch(
      /^https:\/\/storage\.test\/storage\/v1\/object\/sign\/ops-contracts\/contracts\/.+\.pdf\?token=/,
    );
    const expiresAt = Date.parse(response.body.expiresAt);
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    expect(rpcBodies[0]?.body).toEqual({ p_attachment_id: ATTACHMENT_ID });
  });

  it('reports a missing attachment as 404', async () => {
    stubFetch({ rpc: { contract_attachment_access: { status: 'attachment_not_found' } } });

    const response = await call(url);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'attachment' } });
  });
});
