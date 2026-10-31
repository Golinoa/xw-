import { describe, expect, it } from 'vitest';
import { OPS_USER, OPS_VIEWER_USER, call, expectStatus, signToken } from './harness';

/**
 * 运营 catalog 域，跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明的是「回包形状与拒绝形状都来自库」：2xx 说明 13 个 RPC 的 jsonb 键名与
 * `protocol.ts` 的 row schema 逐字段对齐（否则 `ops_rpc_shape_invalid` → 503）；
 * 403 说明权限按动作码判；404/409 说明 `{status:...}` 信封被 Worker 正确翻译。
 *
 * 三处能力边界如实留空，不在这里假装：
 * - `OBJECT_REFERENCED`：合同表还没有（T-06），`draftContracts` 恒为 0，产品/套餐停用
 *   永远成功。这条分支由 pgTAP 用同一事务里的临时替身表证明。
 * - `price_version_required`：`create_package` 一定同时写首条价格版本，从 API 走不出
 *   「没有价格版本的套餐」，所以这条只在 pgTAP 里测。
 * - `PATCH /features` 改 `featureKey`：schema 层就 400 了，库里的 409 分支不可达
 *   （契约 §6 §7 也要求 400）。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const PRODUCTS = '/api/v1/ops/products';
const PACKAGES = '/api/v1/ops/packages';
const FEATURES = '/api/v1/ops/features';

interface FeatureBody {
  featureKey: string;
  displayName: string;
  valueType: string;
  unit: string | null;
  isActive: boolean;
  version?: number;
}

interface ProductBody {
  id: string;
  code: string;
  name: string;
  lifecycleStatus: string;
  salesModes: Array<{ mode: string; isEnabled: boolean }>;
  version: number;
}

interface PackageBody {
  id: string;
  productId: string;
  internalName: string | null;
  customerName: string | null;
  salesMode: string;
  billingType: string;
  currency: string;
  listPrice: number;
  status: string;
  currentPriceVersionId: string | null;
  version: number;
}

interface PriceVersionBody {
  id: string;
  packageId: string;
  versionNo: number;
  price: number;
  currency: string;
  termMonths: number | null;
  effectiveFrom: string;
  createdBy: string | null;
}

const FEATURE_KEY = 'integration_seats';
const PRODUCT_CODE = 'CAT-INT-001';

let mainProduct: ProductBody;
let mainPackage: PackageBody;

describe('GET /api/v1/ops/features', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(FEATURES, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('returns the feature list to an operator with catalog.read', async () => {
    const response = await call<{ items: Array<{ featureKey: string; usageCount: number }> }>(
      FEATURES,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('rejects an unknown isActive filter instead of ignoring it', async () => {
    // 静默忽略会让 `?isActive=yes` 返回全集，看起来像「筛选没生效」。
    const response = await call(FEATURES, { token: viewerToken, query: { isActive: 'maybe' } });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/v1/ops/features', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(FEATURES, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { featureKey: 'no_key_feature', displayName: '缺幂等键', valueType: 'boolean' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses an operator without catalog.write', async () => {
    const response = await call(FEATURES, {
      method: 'POST',
      token: viewerToken,
      body: { featureKey: 'viewer_feature', displayName: '只读账号', valueType: 'boolean' },
    });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('creates a feature key', async () => {
    const response = await call<{ feature: FeatureBody }>(FEATURES, {
      method: 'POST',
      token: opsToken,
      body: {
        featureKey: FEATURE_KEY,
        displayName: '并发坐席数',
        valueType: 'quota',
        unit: '席',
        description: '集成测试用功能键',
      },
    });
    expectStatus(response, 201);
    expect(response.body.feature).toMatchObject({
      featureKey: FEATURE_KEY,
      displayName: '并发坐席数',
      valueType: 'quota',
      unit: '席',
      isActive: true,
    });
  });

  it('refuses a duplicate feature key with CONFLICT', async () => {
    const response = await call(FEATURES, {
      method: 'POST',
      token: opsToken,
      body: { featureKey: FEATURE_KEY, displayName: '重复键', valueType: 'boolean' },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { field: 'featureKey' },
    });
  });

  it('lists the new feature with its usage count', async () => {
    const response = await call<{ items: Array<{ featureKey: string; usageCount: number }> }>(
      FEATURES,
      { token: opsToken, query: { keyword: FEATURE_KEY } },
    );
    expectStatus(response, 200);
    const found = response.body.items.find((item) => item.featureKey === FEATURE_KEY);
    expect(found).toBeDefined();
    // 还没被任何套餐引用。
    expect(found?.usageCount).toBe(0);
  });
});

describe('PATCH /api/v1/ops/features/{featureKey}', () => {
  it('updates the display name', async () => {
    const response = await call<{ feature: FeatureBody }>(`${FEATURES}/${FEATURE_KEY}`, {
      method: 'PATCH',
      token: opsToken,
      body: { displayName: '并发坐席数（含只读）' },
    });
    expectStatus(response, 200);
    expect(response.body.feature).toMatchObject({
      featureKey: FEATURE_KEY,
      displayName: '并发坐席数（含只读）',
    });
  });

  it('rejects a body that tries to change the feature key (contract §6 requires 400)', async () => {
    const response = await call(`${FEATURES}/${FEATURE_KEY}`, {
      method: 'PATCH',
      token: opsToken,
      body: { featureKey: 'renamed_key' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns 404 for an unknown feature key', async () => {
    const response = await call(`${FEATURES}/does_not_exist`, {
      method: 'PATCH',
      token: opsToken,
      body: { displayName: '不存在' },
    });
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/v1/ops/products', () => {
  it('returns the product list', async () => {
    const response = await call<{ items: Array<{ code: string; packageCount: number }> }>(
      PRODUCTS,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('rejects an unknown lifecycleStatus filter', async () => {
    const response = await call(PRODUCTS, {
      token: viewerToken,
      query: { lifecycleStatus: 'actve' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/v1/ops/products', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { code: 'NO-KEY-001', name: '缺幂等键产品', salesModes: [] },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a product with one enabled sales mode', async () => {
    const response = await call<{ product: ProductBody }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: PRODUCT_CODE,
        name: '集成产品甲',
        description: '集成测试用产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(response, 201);
    expect(response.body.product).toMatchObject({
      code: PRODUCT_CODE,
      name: '集成产品甲',
      lifecycleStatus: 'draft',
      version: 1,
    });
    expect(response.body.product.salesModes).toEqual([{ mode: 'saas', isEnabled: true }]);
    mainProduct = response.body.product;
  });

  it('refuses a duplicate code with CONFLICT', async () => {
    const response = await call(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: PRODUCT_CODE,
        name: '重复编码',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'code' } });
  });

  it('refuses an empty salesModes array (库判定，不是契约层第二份规则)', async () => {
    const response = await call(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: { code: 'CAT-INT-EMPTY', name: '没有销售方式', salesModes: [] },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODES_REQUIRED' },
    });
  });
});

describe('PATCH /api/v1/ops/products/{productId}', () => {
  it('refuses a stale version with CONFLICT and the current version', async () => {
    const response = await call(`${PRODUCTS}/${mainProduct.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { name: '并发改名', version: 99 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { currentVersion: 1 },
    });
  });

  it('updates the name and flips lifecycle to active', async () => {
    const response = await call<{ product: ProductBody }>(`${PRODUCTS}/${mainProduct.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { name: '集成产品甲（已上架）', lifecycleStatus: 'active', version: 1 },
    });
    expectStatus(response, 200);
    expect(response.body.product).toMatchObject({
      name: '集成产品甲（已上架）',
      lifecycleStatus: 'active',
      version: 2,
    });
    mainProduct = response.body.product;
  });
});

describe('POST /api/v1/ops/packages', () => {
  it('returns 404 for an unknown product', async () => {
    const response = await call(PACKAGES, {
      method: 'POST',
      token: opsToken,
      body: {
        productId: '00000000-0000-4000-8000-000000000000',
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 100,
      },
    });
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a sales mode the product has not enabled', async () => {
    const response = await call(PACKAGES, {
      method: 'POST',
      token: opsToken,
      body: {
        productId: mainProduct.id,
        internalName: '私有化版',
        salesMode: 'private',
        billingType: 'one_time',
        listPrice: 200000,
      },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'SALES_MODE_DISABLED', salesMode: 'private' },
    });
  });

  it('creates a package together with its first price version', async () => {
    const response = await call<{ package: PackageBody; priceVersion: PriceVersionBody }>(
      PACKAGES,
      {
        method: 'POST',
        token: opsToken,
        body: {
          productId: mainProduct.id,
          internalName: '标准版年付',
          customerName: '标准版（年付）',
          salesMode: 'saas',
          billingType: 'periodic',
          defaultTermMonths: 12,
          listPrice: 13800,
          features: [
            {
              featureKey: FEATURE_KEY,
              enabled: true,
              quotaValue: 50,
              appliesTo: 'saas_tenant',
            },
          ],
          effectiveFrom: '2026-11-01',
        },
      },
    );
    expectStatus(response, 201);
    expect(response.body.package).toMatchObject({
      productId: mainProduct.id,
      internalName: '标准版年付',
      salesMode: 'saas',
      billingType: 'periodic',
      currency: 'CNY',
      listPrice: 13800,
      status: 'draft',
      version: 1,
    });
    expect(response.body.package.currentPriceVersionId).toBe(response.body.priceVersion.id);
    expect(response.body.priceVersion).toMatchObject({
      versionNo: 1,
      price: 13800,
      currency: 'CNY',
      termMonths: 12,
    });
    mainPackage = response.body.package;
  });

  it('refuses a duplicate internal name for the same product and sales mode', async () => {
    const response = await call(PACKAGES, {
      method: 'POST',
      token: opsToken,
      body: {
        productId: mainProduct.id,
        internalName: '标准版年付',
        salesMode: 'saas',
        billingType: 'periodic',
        listPrice: 100,
      },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { field: 'internalName' },
    });
  });
});

describe('GET /api/v1/ops/packages', () => {
  it('filters by product id', async () => {
    const response = await call<{ items: Array<{ id: string; price: number }> }>(PACKAGES, {
      token: viewerToken,
      query: { productId: mainProduct.id },
    });
    expectStatus(response, 200);
    const found = response.body.items.find((item) => item.id === mainPackage.id);
    expect(found).toBeDefined();
    expect(found?.price).toBe(13800);
  });
});

describe('GET /api/v1/ops/packages/{packageId}', () => {
  it('returns the package with its features and current price version', async () => {
    const response = await call<{
      package: PackageBody;
      features: Array<{ featureKey: string; displayName: string; quotaValue: number | null }>;
      currentPriceVersion: PriceVersionBody | null;
    }>(`${PACKAGES}/${mainPackage.id}`, { token: viewerToken });
    expectStatus(response, 200);
    expect(response.body.package.id).toBe(mainPackage.id);
    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0]).toMatchObject({
      featureKey: FEATURE_KEY,
      // displayName 来自功能键定义，不是套餐上的副本。
      displayName: '并发坐席数（含只读）',
      quotaValue: 50,
    });
    expect(response.body.currentPriceVersion?.versionNo).toBe(1);
  });

  it('returns 404 for an unknown package', async () => {
    const response = await call(`${PACKAGES}/00000000-0000-4000-8000-000000000000`, {
      token: viewerToken,
    });
    expectStatus(response, 404);
  });
});

describe('PATCH /api/v1/ops/packages/{packageId}', () => {
  it('refuses a stale version with CONFLICT', async () => {
    const response = await call(`${PACKAGES}/${mainPackage.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { customerName: '并发改名', version: 99 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { currentVersion: 1 },
    });
  });

  it('replaces the feature set and bumps the version', async () => {
    const response = await call<{ package: PackageBody }>(`${PACKAGES}/${mainPackage.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: {
        customerName: '标准版（年付，含实施）',
        features: [
          { featureKey: FEATURE_KEY, enabled: true, quotaValue: 80, appliesTo: 'saas_tenant' },
        ],
        version: 1,
      },
    });
    expectStatus(response, 200);
    expect(response.body.package).toMatchObject({
      customerName: '标准版（年付，含实施）',
      version: 2,
    });
    mainPackage = response.body.package;
  });

  it('refuses an unknown feature key in the replacement set', async () => {
    const response = await call(`${PACKAGES}/${mainPackage.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: {
        features: [{ featureKey: 'no_such_feature', appliesTo: 'both' }],
        version: 2,
      },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'FEATURE_NOT_FOUND', featureKey: 'no_such_feature' },
    });
  });
});

describe('POST /api/v1/ops/packages/{packageId}/price-versions', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${PACKAGES}/${mainPackage.id}/price-versions`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { price: 15000, effectiveFrom: '2026-12-01' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('appends version 2 and syncs the current price back onto the package', async () => {
    const response = await call<{ priceVersion: PriceVersionBody; package: PackageBody }>(
      `${PACKAGES}/${mainPackage.id}/price-versions`,
      {
        method: 'POST',
        token: opsToken,
        body: { price: 15800, termMonths: 12, effectiveFrom: '2026-12-01' },
      },
    );
    expectStatus(response, 201);
    expect(response.body.priceVersion).toMatchObject({
      versionNo: 2,
      price: 15800,
      currency: 'CNY',
      termMonths: 12,
    });
    // 新版本即当前价：不刷新的话价格版本在列表里就不可见了。
    expect(response.body.package.listPrice).toBe(15800);
    expect(response.body.package.currentPriceVersionId).toBe(response.body.priceVersion.id);
  });
});

describe('GET /api/v1/ops/packages/{packageId}/price-versions', () => {
  it('lists both versions in ascending order', async () => {
    const response = await call<{ items: PriceVersionBody[] }>(
      `${PACKAGES}/${mainPackage.id}/price-versions`,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(response.body.items).toHaveLength(2);
    // 列表项按契约不带 id；只要序号与价格。
    expect(response.body.items.map((item) => item.versionNo)).toEqual([1, 2]);
    expect(response.body.items.map((item) => item.price)).toEqual([13800, 15800]);
  });
});

describe('POST /api/v1/ops/packages/{packageId}/transition', () => {
  it('activates the package', async () => {
    const response = await call<{ package: { status: string; version: number } }>(
      `${PACKAGES}/${mainPackage.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'activate', reason: '标准版开售', version: mainPackage.version },
      },
    );
    expectStatus(response, 200);
    expect(response.body.package).toMatchObject({ status: 'active', version: 3 });
    mainPackage = { ...mainPackage, ...response.body.package };
  });

  it('retires the package', async () => {
    const response = await call<{ package: { status: string; version: number } }>(
      `${PACKAGES}/${mainPackage.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'retire', reason: '被新版替代', version: mainPackage.version },
      },
    );
    expectStatus(response, 200);
    expect(response.body.package).toMatchObject({ status: 'retired', version: 4 });
    mainPackage = { ...mainPackage, ...response.body.package };
  });

  it('refuses a second retire on a terminal package', async () => {
    const response = await call(`${PACKAGES}/${mainPackage.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'retire', reason: '再停一次', version: mainPackage.version },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
  });
});

describe('PATCH /api/v1/ops/products/{productId} — 生命周期终态', () => {
  it('retires the product', async () => {
    const response = await call<{ product: ProductBody }>(`${PRODUCTS}/${mainProduct.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { lifecycleStatus: 'retired', version: mainProduct.version },
    });
    expectStatus(response, 200);
    expect(response.body.product).toMatchObject({ lifecycleStatus: 'retired', version: 3 });
    mainProduct = response.body.product;
  });

  it('refuses to bring a retired product back to draft', async () => {
    const response = await call(`${PRODUCTS}/${mainProduct.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { lifecycleStatus: 'draft', version: mainProduct.version },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
  });
});
