import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsCatalogRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 的信封 → 契约的状态码/错误码/字段名。
 *
 * 它不测「规则是否成立」——销售方式开关、草稿合同引用、`retired` 终态、价格版本
 * 取号都由 pgTAP 在真实库上断言。同一条规则在两处各测一遍，只会得到一个错觉：
 * 以为改了库还安全，因为这里是绿的。
 *
 * 有两类例外确实属于本层：
 *   1. **入站形状**：`strictObject` 拒绝未知字段（改 `featureKey` 必须是 400，
 *      不是 409）、query 枚举非法必须 400（不能静默返回全集）；
 *   2. **幂等键**：全局中间件对缺键请求放行，四个 POST 的 400 只能在这里证明。
 */

const PRODUCT_ID = '00000000-0000-4000-8000-000000000301';
const PACKAGE_ID = '00000000-0000-4000-8000-000000000302';
const PRICE_VERSION_ID = '00000000-0000-4000-8000-000000000303';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = ['catalog.read', 'catalog.write'];

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

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    code: 'TRIP-CLOUD',
    name: '行程云',
    description: '面向旅行社的行程管理',
    lifecycle_status: 'active',
    sales_modes: [
      { mode: 'saas', is_enabled: true },
      { mode: 'private', is_enabled: false },
    ],
    version: 3,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function productListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    code: 'TRIP-CLOUD',
    name: '行程云',
    lifecycle_status: 'active',
    sales_modes: [{ mode: 'saas', is_enabled: true }],
    package_count: 2,
    version: 3,
    ...overrides,
  };
}

function packageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PACKAGE_ID,
    product_id: PRODUCT_ID,
    product: { id: PRODUCT_ID, code: 'TRIP-CLOUD', name: '行程云' },
    internal_name: '标准版',
    customer_name: '标准版套餐',
    sales_mode: 'saas',
    billing_type: 'periodic',
    default_term_months: 12,
    currency: 'CNY',
    // numeric 出来是 number，不是 "12800.00"。
    list_price: 12800,
    status: 'draft',
    effective_from: '2026-11-01',
    effective_to: null,
    current_price_version_id: PRICE_VERSION_ID,
    version: 2,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function packageListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PACKAGE_ID,
    product_id: PRODUCT_ID,
    internal_name: '标准版',
    customer_name: '标准版套餐',
    sales_mode: 'saas',
    billing_type: 'periodic',
    price: 12800,
    currency: 'CNY',
    status: 'draft',
    effective_from: '2026-11-01',
    version: 2,
    ...overrides,
  };
}

function priceVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRICE_VERSION_ID,
    package_id: PACKAGE_ID,
    version_no: 1,
    price: 12800,
    currency: 'CNY',
    term_months: 12,
    effective_from: '2026-11-01',
    created_by: OPERATOR_ID,
    created_at: '2026-10-01T02:00:00+00:00',
    ...overrides,
  };
}

function packageFeatureRow(overrides: Record<string, unknown> = {}) {
  return {
    feature_key: 'trip.quota',
    display_name: '行程额度',
    enabled: true,
    quota_value: 100,
    term_months: null,
    applies_to: 'both',
    ...overrides,
  };
}

function featureRow(overrides: Record<string, unknown> = {}) {
  return {
    feature_key: 'trip.quota',
    display_name: '行程额度',
    value_type: 'quota',
    unit: '个',
    description: null,
    is_active: true,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function featureListRow(overrides: Record<string, unknown> = {}) {
  return {
    feature_key: 'trip.quota',
    display_name: '行程额度',
    value_type: 'quota',
    unit: '个',
    is_active: true,
    usage_count: 2,
    ...overrides,
  };
}

const impact = { draft_contracts: 3 };

interface StubOptions {
  permissions?: string[];
  /** `rpc/<name>` → 响应体。没给的名字一律当作「不该被调用」。 */
  rpc?: Record<string, unknown>;
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
 * 契约字段是否真的透传下去（`p_sales_modes` 是不是 snake_case 的 jsonb、
 * 省略的字段是不是 `null`、`[]` 与「没传」是否分开）只能从请求体看出来。
 */
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
app.route('/', opsCatalogRoutes);

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

/** 四个必填幂等键的 POST 之外的用例也带上不会错——中间件对带了 key 的请求只做回放判定。 */
const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-catalog-0001' };

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** 路径一律从注册表取：测试里手写路径会让「清单改了、测试没改」悄悄通过。 */
function path(template: string, values: Record<string, string> = {}): string {
  let result = template;
  for (const [name, value] of Object.entries({
    productId: PRODUCT_ID,
    packageId: PACKAGE_ID,
    featureKey: encodeURIComponent('trip.quota'),
    ...values,
  })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  rpcBodies.length = 0;
});

describe('route registry', () => {
  it('keeps the thirteen catalog keys on the documented method and path', () => {
    const keys = [
      'listOpsProducts',
      'createOpsProduct',
      'updateOpsProduct',
      'listOpsPackages',
      'createOpsPackage',
      'getOpsPackage',
      'updateOpsPackage',
      'listOpsPackagePriceVersions',
      'createOpsPackagePriceVersion',
      'transitionOpsPackage',
      'listOpsFeatures',
      'createOpsFeature',
      'updateOpsFeature',
    ] as const satisfies readonly (keyof typeof OPS_ROUTES)[];

    expect(
      Object.fromEntries(
        keys.map((key) => [key, `${OPS_ROUTES[key].method} ${OPS_ROUTES[key].path}`]),
      ),
    ).toEqual({
      listOpsProducts: 'GET /api/v1/ops/products',
      createOpsProduct: 'POST /api/v1/ops/products',
      updateOpsProduct: 'PATCH /api/v1/ops/products/:productId',
      listOpsPackages: 'GET /api/v1/ops/packages',
      createOpsPackage: 'POST /api/v1/ops/packages',
      getOpsPackage: 'GET /api/v1/ops/packages/:packageId',
      updateOpsPackage: 'PATCH /api/v1/ops/packages/:packageId',
      listOpsPackagePriceVersions: 'GET /api/v1/ops/packages/:packageId/price-versions',
      createOpsPackagePriceVersion: 'POST /api/v1/ops/packages/:packageId/price-versions',
      transitionOpsPackage: 'POST /api/v1/ops/packages/:packageId/transition',
      listOpsFeatures: 'GET /api/v1/ops/features',
      createOpsFeature: 'POST /api/v1/ops/features',
      updateOpsFeature: 'PATCH /api/v1/ops/features/:featureKey',
    });
  });
});

describe('GET /api/v1/ops/products', () => {
  it('maps the list row and forwards every filter', async () => {
    stubFetch({ rpc: { list_products: { status: 'ok', items: [productListRow()] } } });

    const response = await call(OPS_ROUTES.listOpsProducts.path, {
      query: { keyword: '行程', lifecycleStatus: 'active', salesMode: 'saas' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: PRODUCT_ID,
          code: 'TRIP-CLOUD',
          name: '行程云',
          lifecycleStatus: 'active',
          salesModes: [{ mode: 'saas', isEnabled: true }],
          packageCount: 2,
          version: 3,
        },
      ],
    });
    expect(rpcBodies[0]?.body).toEqual({
      p_keyword: '行程',
      p_lifecycle_status: 'active',
      p_sales_mode: 'saas',
    });
  });

  it('rejects an unknown lifecycle value instead of silently listing everything', async () => {
    const called = stubFetch({ rpc: {} });

    // `actve` 拼错：静默忽略会返回全集，页面看起来像「筛选没生效」。
    const response = await call(OPS_ROUTES.listOpsProducts.path, {
      query: { lifecycleStatus: 'actve' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('refuses a reader without catalog.read before touching the directory', async () => {
    const called = stubFetch({ permissions: ['catalog.write'], rpc: {} });

    const response = await call(OPS_ROUTES.listOpsProducts.path);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'catalog.read' },
    });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/products', () => {
  it('returns 201 and sends sales modes as snake_case jsonb', async () => {
    stubFetch({ rpc: { create_product: { status: 'ok', product: productRow() } } });

    const response = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        code: 'TRIP-CLOUD',
        name: '行程云',
        salesModes: [{ mode: 'saas', isEnabled: true }, { mode: 'private' }],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      product: {
        id: PRODUCT_ID,
        code: 'TRIP-CLOUD',
        name: '行程云',
        description: '面向旅行社的行程管理',
        lifecycleStatus: 'active',
        salesModes: [
          { mode: 'saas', isEnabled: true },
          { mode: 'private', isEnabled: false },
        ],
        version: 3,
        createdAt: '2026-10-01T02:00:00+00:00',
        updatedAt: '2026-10-02T02:00:00+00:00',
      },
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_code: 'TRIP-CLOUD',
      p_name: '行程云',
      p_description: null,
      // 省略 isEnabled = 该销售方式存在但关闭，与表默认值一致。
      p_sales_modes: [
        { mode: 'saas', is_enabled: true },
        { mode: 'private', is_enabled: false },
      ],
    });
  });

  it('rejects a create without Idempotency-Key before any write can happen', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      body: { code: 'TRIP-CLOUD', name: '行程云', salesModes: [{ mode: 'saas' }] },
    });

    // 全局幂等中间件对没有 key 的请求直接放行，所以这条拒绝只能在 handler 里。
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('maps a duplicate code to 409 CONFLICT on the code field', async () => {
    stubFetch({ rpc: { create_product: { status: 'code_conflict' } } });

    const response = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { code: 'TRIP-CLOUD', name: '行程云', salesModes: [{ mode: 'saas' }] },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'code' } });
  });

  it('maps the two sales-mode refusals to 400 with a machine-readable reason', async () => {
    stubFetch({ rpc: { create_product: { status: 'sales_modes_required' } } });
    const required = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { code: 'TRIP-CLOUD', name: '行程云', salesModes: [] },
    });

    // 库里回的键是 `mode`（触发的那一个值），不是 §4 文字里的 `sales_mode`。
    stubFetch({
      rpc: { create_product: { status: 'invalid_sales_mode', mode: 'reseller' } },
    });
    const invalid = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { code: 'TRIP-CLOUD', name: '行程云', salesModes: [{ mode: 'saas' }] },
    });

    expect(required.status).toBe(400);
    expect(required.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODES_REQUIRED' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'INVALID_SALES_MODE', salesMode: 'reseller' },
    });
  });

  it('rejects an unknown body field at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsProduct.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { code: 'TRIP-CLOUD', name: '行程云', salesModes: [], lifecycleStatus: 'active' },
    });

    // 生命周期只能走 PATCH；创建时带它说明前端拿错了表单，必须 400 而不是静默丢弃。
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });
});

describe('PATCH /api/v1/ops/products/{productId}', () => {
  const url = path(OPS_ROUTES.updateOpsProduct.path);

  it('sends omitted fields as null and returns the updated product', async () => {
    stubFetch({
      rpc: {
        update_product: {
          status: 'ok',
          product: productRow({ name: '行程云 2.0', version: 4 }),
        },
      },
    });

    const response = await call(url, {
      method: 'PATCH',
      body: { name: '行程云 2.0', reason: '改名', version: 3 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ product: { name: '行程云 2.0', version: 4 } });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_product_id: PRODUCT_ID,
      p_name: '行程云 2.0',
      p_description: null,
      p_lifecycle_status: null,
      p_sales_modes: null,
      p_expected_version: 3,
      p_reason: '改名',
    });
  });

  it('keeps the empty array distinct from "not sent" for sales modes', async () => {
    stubFetch({ rpc: { update_product: { status: 'sales_modes_required' } } });

    const response = await call(url, {
      method: 'PATCH',
      body: { salesModes: [], version: 3 },
    });

    // `[]` 是「全删」，不是「不动」——它必须原样下传，让库返回 sales_modes_required。
    expect(rpcBodies[0]?.body).toMatchObject({ p_sales_modes: [] });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODES_REQUIRED' },
    });
  });

  it('reports a stale version as 409 CONFLICT with the current value', async () => {
    stubFetch({ rpc: { update_product: { status: 'version_mismatch', current_version: 7 } } });

    const response = await call(url, { method: 'PATCH', body: { name: '行程云', version: 3 } });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 7 } });
  });

  it('reports a draft-contract reference as 409 OBJECT_REFERENCED with the impact', async () => {
    stubFetch({ rpc: { update_product: { status: 'referenced', impact } } });

    const response = await call(url, {
      method: 'PATCH',
      body: { lifecycleStatus: 'retired', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'OBJECT_REFERENCED',
      details: { impact: { draftContracts: 3 } },
    });
    // 下划线 → 驼峰必须发生在这一层；原样透传会让前端拿到 undefined。
    expect(response.body.details.impact).not.toHaveProperty('draft_contracts');
  });

  it('reports a retired product returning to draft as 409 STATE_CONFLICT', async () => {
    stubFetch({ rpc: { update_product: { status: 'invalid_transition' } } });

    const response = await call(url, {
      method: 'PATCH',
      body: { lifecycleStatus: 'draft', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
  });

  it('reports a missing product as 404', async () => {
    stubFetch({ rpc: { update_product: { status: 'not_found' } } });

    const response = await call(url, { method: 'PATCH', body: { name: '行程云', version: 1 } });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/v1/ops/packages', () => {
  it('maps the list row and forwards every filter', async () => {
    stubFetch({ rpc: { list_packages: { status: 'ok', items: [packageListRow()] } } });

    const response = await call(OPS_ROUTES.listOpsPackages.path, {
      query: { productId: PRODUCT_ID, salesMode: 'saas', status: 'draft', keyword: '标准' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: PACKAGE_ID,
          productId: PRODUCT_ID,
          internalName: '标准版',
          customerName: '标准版套餐',
          salesMode: 'saas',
          billingType: 'periodic',
          price: 12800,
          currency: 'CNY',
          status: 'draft',
          effectiveFrom: '2026-11-01',
          version: 2,
        },
      ],
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_product_id: PRODUCT_ID,
      p_sales_mode: 'saas',
      p_status: 'draft',
      p_keyword: '标准',
    });
  });

  it('rejects an unknown status instead of silently ignoring the filter', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.listOpsPackages.path, { query: { status: 'live' } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/packages', () => {
  it('returns 201 with the package and its first price version', async () => {
    stubFetch({
      rpc: {
        create_package: {
          status: 'ok',
          package: packageRow(),
          price_version: priceVersionRow(),
        },
      },
    });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        productId: PRODUCT_ID,
        internalName: '标准版',
        salesMode: 'saas',
        billingType: 'periodic',
        defaultTermMonths: 12,
        listPrice: 12800,
        effectiveFrom: '2026-11-01',
        features: [{ featureKey: 'trip.quota', quotaValue: 100, appliesTo: 'both' }],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      package: {
        id: PACKAGE_ID,
        productId: PRODUCT_ID,
        product: { id: PRODUCT_ID, code: 'TRIP-CLOUD', name: '行程云' },
        internalName: '标准版',
        customerName: '标准版套餐',
        salesMode: 'saas',
        billingType: 'periodic',
        defaultTermMonths: 12,
        currency: 'CNY',
        listPrice: 12800,
        status: 'draft',
        effectiveFrom: '2026-11-01',
        effectiveTo: null,
        currentPriceVersionId: PRICE_VERSION_ID,
        version: 2,
        createdAt: '2026-10-01T02:00:00+00:00',
        updatedAt: '2026-10-02T02:00:00+00:00',
      },
      priceVersion: {
        id: PRICE_VERSION_ID,
        packageId: PACKAGE_ID,
        versionNo: 1,
        price: 12800,
        currency: 'CNY',
        termMonths: 12,
        effectiveFrom: '2026-11-01',
        createdBy: OPERATOR_ID,
        createdAt: '2026-10-01T02:00:00+00:00',
      },
    });
    // 金额是 number：写成字符串后这里会失败。
    expect(typeof response.body.package.listPrice).toBe('number');
    expect(rpcBodies[0]?.body).toMatchObject({
      p_product_id: PRODUCT_ID,
      p_customer_name: null,
      p_currency: null,
      p_list_price: 12800,
      p_features: [
        {
          feature_key: 'trip.quota',
          enabled: true,
          quota_value: 100,
          term_months: null,
          applies_to: 'both',
        },
      ],
    });
  });

  it('rejects a create without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      body: {
        productId: PRODUCT_ID,
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 12800,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('maps a missing product to 404', async () => {
    stubFetch({ rpc: { create_package: { status: 'product_not_found' } } });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        productId: PRODUCT_ID,
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 12800,
      },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a disabled sales mode to 400 SALES_MODE_DISABLED', async () => {
    stubFetch({
      rpc: { create_package: { status: 'sales_mode_disabled', sales_mode: 'private' } },
    });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        productId: PRODUCT_ID,
        salesMode: 'private',
        billingType: 'periodic',
        listPrice: 12800,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODE_DISABLED', salesMode: 'private' },
    });
  });

  it('maps a duplicate internal name to 409 CONFLICT on internalName', async () => {
    stubFetch({ rpc: { create_package: { status: 'internal_name_conflict' } } });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        productId: PRODUCT_ID,
        internalName: '标准版',
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 12800,
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'internalName' } });
  });

  it('maps an unknown feature key to 400 FEATURE_NOT_FOUND', async () => {
    stubFetch({
      rpc: { create_package: { status: 'feature_not_found', feature_key: 'trip.missing' } },
    });

    const response = await call(OPS_ROUTES.createOpsPackage.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        productId: PRODUCT_ID,
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 12800,
        features: [{ featureKey: 'trip.missing', appliesTo: 'both' }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'FEATURE_NOT_FOUND', featureKey: 'trip.missing' },
    });
  });
});

describe('GET /api/v1/ops/packages/{packageId}', () => {
  it('returns the package, its features and the current price version', async () => {
    stubFetch({
      rpc: {
        get_package: {
          status: 'ok',
          package: packageRow(),
          features: [packageFeatureRow()],
          current_price_version: priceVersionRow(),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsPackage.path));

    expect(response.status).toBe(200);
    expect(response.body.package.id).toBe(PACKAGE_ID);
    expect(response.body.features).toEqual([
      {
        featureKey: 'trip.quota',
        displayName: '行程额度',
        enabled: true,
        quotaValue: 100,
        termMonths: null,
        appliesTo: 'both',
      },
    ]);
    expect(response.body.currentPriceVersion).toMatchObject({
      versionNo: 1,
      price: 12800,
    });
  });

  it('keeps currentPriceVersion null for an unpriced draft', async () => {
    stubFetch({
      rpc: {
        get_package: {
          status: 'ok',
          package: packageRow({ status: 'draft', current_price_version_id: null }),
          features: [],
          current_price_version: null,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsPackage.path));

    expect(response.status).toBe(200);
    expect(response.body.currentPriceVersion).toBeNull();
  });

  it('reports a missing package as 404', async () => {
    stubFetch({ rpc: { get_package: { status: 'not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsPackage.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /api/v1/ops/packages/{packageId}', () => {
  const url = path(OPS_ROUTES.updateOpsPackage.path);

  it('sends omitted fields as null and returns the updated package', async () => {
    stubFetch({
      rpc: { update_package: { status: 'ok', package: packageRow({ version: 3 }) } },
    });

    const response = await call(url, {
      method: 'PATCH',
      body: { customerName: '标准版（2027）', version: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ package: { customerName: '标准版套餐', version: 3 } });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_package_id: PACKAGE_ID,
      p_internal_name: null,
      p_customer_name: '标准版（2027）',
      p_features: null,
      p_expected_version: 2,
    });
    // `update_package` 的 RPC 签名里没有 `p_reason`：多传一个参数 PostgREST 会
    // 直接报「函数不存在」，所以这里也断一次「没有这个键」。
    expect(rpcBodies[0]?.body).not.toHaveProperty('p_reason');
  });

  it('sends an empty feature array as "clear all" instead of null', async () => {
    stubFetch({ rpc: { update_package: { status: 'ok', package: packageRow({ version: 3 }) } } });

    await call(url, { method: 'PATCH', body: { features: [], version: 2 } });

    expect(rpcBodies[0]?.body).toMatchObject({ p_features: [] });
  });

  it('reports a stale version as 409 CONFLICT with the current value', async () => {
    stubFetch({ rpc: { update_package: { status: 'version_mismatch', current_version: 9 } } });

    const response = await call(url, { method: 'PATCH', body: { customerName: 'x', version: 2 } });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 9 } });
  });

  it('maps a duplicate internal name to 409 CONFLICT', async () => {
    stubFetch({ rpc: { update_package: { status: 'internal_name_conflict' } } });

    const response = await call(url, {
      method: 'PATCH',
      body: { internalName: '标准版', version: 2 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'internalName' } });
  });

  it('maps an unknown feature key to 400 FEATURE_NOT_FOUND', async () => {
    stubFetch({
      rpc: { update_package: { status: 'feature_not_found', feature_key: 'trip.missing' } },
    });

    const response = await call(url, {
      method: 'PATCH',
      body: { features: [{ featureKey: 'trip.missing', appliesTo: 'both' }], version: 2 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'FEATURE_NOT_FOUND', featureKey: 'trip.missing' },
    });
  });

  it('reports a missing package as 404', async () => {
    stubFetch({ rpc: { update_package: { status: 'not_found' } } });

    const response = await call(url, { method: 'PATCH', body: { customerName: 'x', version: 1 } });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/v1/ops/packages/{packageId}/price-versions', () => {
  const url = path(OPS_ROUTES.listOpsPackagePriceVersions.path);

  it('maps the version list without inventing an id', async () => {
    stubFetch({
      rpc: {
        list_package_price_versions: {
          status: 'ok',
          items: [priceVersionRow({ version_no: 2, price: 13800 })],
        },
      },
    });

    const response = await call(url);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          versionNo: 2,
          price: 13800,
          currency: 'CNY',
          termMonths: 12,
          effectiveFrom: '2026-11-01',
          createdBy: OPERATOR_ID,
          createdAt: '2026-10-01T02:00:00+00:00',
        },
      ],
    });
    // 列表项没有 id：本轮没有「按版本 id 操作」的端点，多给一个键会暗示它存在。
    expect(response.body.items[0]).not.toHaveProperty('id');
  });

  it('reports a missing package as 404', async () => {
    stubFetch({ rpc: { list_package_price_versions: { status: 'not_found' } } });

    const response = await call(url);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('POST /api/v1/ops/packages/{packageId}/price-versions', () => {
  const url = path(OPS_ROUTES.createOpsPackagePriceVersion.path);

  it('returns 201 with the new version and the refreshed package', async () => {
    stubFetch({
      rpc: {
        create_package_price_version: {
          status: 'ok',
          price_version: priceVersionRow({ version_no: 2, price: 13800 }),
          package: packageRow({ list_price: 13800, version: 3 }),
        },
      },
    });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { price: 13800, termMonths: 12, effectiveFrom: '2026-12-01' },
    });

    expect(response.status).toBe(201);
    expect(response.body.priceVersion).toMatchObject({ versionNo: 2, price: 13800 });
    // 新版本会同步刷新当前价，套餐对象要一起回，前端才能就地更新行。
    expect(response.body.package).toMatchObject({ listPrice: 13800, version: 3 });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_package_id: PACKAGE_ID,
      p_price: 13800,
      p_currency: null,
      p_term_months: 12,
      p_effective_from: '2026-12-01',
    });
  });

  it('rejects a create without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, {
      method: 'POST',
      body: { price: 13800, effectiveFrom: '2026-12-01' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects a string price at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    // 契约里价格是 JSON number；"13800.00" 必须在入站被拒，而不是被静默转换。
    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { price: '13800.00', effectiveFrom: '2026-12-01' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('reports a missing package as 404', async () => {
    stubFetch({ rpc: { create_package_price_version: { status: 'not_found' } } });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { price: 13800, effectiveFrom: '2026-12-01' },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a taken version number to 409 CONFLICT on versionNo', async () => {
    stubFetch({ rpc: { create_package_price_version: { status: 'price_version_conflict' } } });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { price: 13800, effectiveFrom: '2026-12-01' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'versionNo' } });
  });
});

describe('POST /api/v1/ops/packages/{packageId}/transition', () => {
  const url = path(OPS_ROUTES.transitionOpsPackage.path);
  const body = { action: 'activate', reason: '定价完成，开放销售', version: 2 };

  it('returns 200 with the new status, version and impact', async () => {
    stubFetch({
      rpc: {
        transition_package: {
          status: 'ok',
          package: { status: 'active', version: 3 },
          impact: { draft_contracts: 0 },
        },
      },
    });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    // 状态迁移不是「新建」，所以是 200 而不是 201。
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      package: { status: 'active', version: 3 },
      impact: { draftContracts: 0 },
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_package_id: PACKAGE_ID,
      p_action: 'activate',
      p_reason: '定价完成，开放销售',
      p_expected_version: 2,
    });
  });

  it('rejects a transition without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, { method: 'POST', body });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects an action outside the closed state machine', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'suspend' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('separates the four refusals by code and reason', async () => {
    stubFetch({
      rpc: { transition_package: { status: 'version_mismatch', current_version: 5 } },
    });
    const stale = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    stubFetch({ rpc: { transition_package: { status: 'invalid_transition' } } });
    const invalid = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'retire' },
    });

    stubFetch({ rpc: { transition_package: { status: 'referenced', impact } } });
    const referenced = await call(url, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { ...body, action: 'retire' },
    });

    stubFetch({ rpc: { transition_package: { status: 'price_version_required' } } });
    const unpriced = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 5 } });
    expect(invalid.status).toBe(409);
    expect(invalid.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
    expect(referenced.status).toBe(409);
    expect(referenced.body).toMatchObject({
      code: 'OBJECT_REFERENCED',
      details: { impact: { draftContracts: 3 } },
    });
    // 契约 §7 把「没有价格版本就激活」归在业务校验失败（400），不是状态冲突。
    expect(unpriced.status).toBe(400);
    expect(unpriced.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'PRICE_VERSION_REQUIRED' },
    });
  });

  it('reports a missing package as 404', async () => {
    stubFetch({ rpc: { transition_package: { status: 'not_found' } } });

    const response = await call(url, { method: 'POST', headers: IDEMPOTENCY_KEY, body });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/v1/ops/features', () => {
  it('maps the list row and turns isActive into a boolean filter', async () => {
    stubFetch({ rpc: { list_features: { status: 'ok', items: [featureListRow()] } } });

    const response = await call(OPS_ROUTES.listOpsFeatures.path, {
      query: { isActive: 'false', keyword: 'quota' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          featureKey: 'trip.quota',
          displayName: '行程额度',
          valueType: 'quota',
          unit: '个',
          isActive: true,
          usageCount: 2,
        },
      ],
    });
    // `z.coerce.boolean()` 会把 "false" 变成 true；这里证明用的是字面量映射。
    expect(rpcBodies[0]?.body).toEqual({ p_is_active: false, p_keyword: 'quota' });
  });

  it('rejects an unknown isActive value', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.listOpsFeatures.path, { query: { isActive: 'yes' } });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/features', () => {
  it('returns 201 with the created feature', async () => {
    stubFetch({ rpc: { create_feature: { status: 'ok', feature: featureRow() } } });

    // 契约 §5.3 的幂等列对 POST /features 也是「必填」——五个写端点里它是最容易
    // 被漏掉的一个，因为「功能键本身就是主键」看起来已经有唯一性兜底了。
    const response = await call(OPS_ROUTES.createOpsFeature.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { featureKey: 'trip.quota', displayName: '行程额度', valueType: 'quota', unit: '个' },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      feature: { featureKey: 'trip.quota', valueType: 'quota', isActive: true },
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_feature_key: 'trip.quota',
      p_display_name: '行程额度',
      p_value_type: 'quota',
      p_unit: '个',
      p_description: null,
    });
  });

  it('rejects a create without Idempotency-Key', async () => {
    stubFetch({ rpc: { create_feature: { status: 'ok', feature: featureRow() } } });

    const response = await call(OPS_ROUTES.createOpsFeature.path, {
      method: 'POST',
      body: { featureKey: 'trip.quota', displayName: '行程额度', valueType: 'quota' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('maps a duplicate key to 409 CONFLICT on featureKey', async () => {
    stubFetch({ rpc: { create_feature: { status: 'feature_key_conflict' } } });

    const response = await call(OPS_ROUTES.createOpsFeature.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { featureKey: 'trip.quota', displayName: '行程额度', valueType: 'quota' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'featureKey' } });
  });
});

describe('PATCH /api/v1/ops/features/{featureKey}', () => {
  const url = path(OPS_ROUTES.updateOpsFeature.path);

  it('returns the updated feature and sends omitted fields as null', async () => {
    stubFetch({
      rpc: { update_feature: { status: 'ok', feature: featureRow({ is_active: false }) } },
    });

    const response = await call(url, {
      method: 'PATCH',
      body: { isActive: false },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ feature: { featureKey: 'trip.quota', isActive: false } });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_feature_key: 'trip.quota',
      p_display_name: null,
      p_unit: null,
      p_description: null,
      p_is_active: false,
    });
  });

  it('rejects an attempt to change featureKey with 400, not 409', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(url, {
      method: 'PATCH',
      body: { featureKey: 'trip.other', displayName: '改主键' },
    });

    // 契约 §6/§7：改主键是入站非法字段（400），不是并发冲突（409）。
    // 宽松对象会把它收下再忽略，于是「保存成功但什么都没改」。
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('reports a missing feature as 404', async () => {
    stubFetch({ rpc: { update_feature: { status: 'not_found' } } });

    const response = await call(url, { method: 'PATCH', body: { displayName: '行程额度' } });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
