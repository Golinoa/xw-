/**
 * 产品、套餐、价格版本与功能键（catalog 域）API 客户端。
 *
 * 契约真源：`Docs/ops-api-contract.md` §5.3（端点）、§3.2（数据模型与规则）。
 *
 * 关键不变量（前端只遵守、不重算）：
 * - 价格版本**只增不改**（`ops.package_price_versions` 仅 INSERT），页面不提供
 *   「编辑历史价格」入口；改价 = 新增版本，只影响新合同 [PRD §6.3]；
 * - 套餐编辑不回写已生效合同、订阅与授权快照；
 * - `featureKey` 不可变，`valueType` 被快照引用后不可改。
 */
import { getOpsEnv } from '#/api/adapter/env';
import { requestClient } from '#/api/request';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

/** 端点清单：路径只从这里取。 */
export const CATALOG_ENDPOINTS = {
  products: `${OPS_API_PREFIX}/products`,
  product: (productId: string) =>
    `${OPS_API_PREFIX}/products/${encodeURIComponent(productId)}`,
  packages: `${OPS_API_PREFIX}/packages`,
  package: (packageId: string) =>
    `${OPS_API_PREFIX}/packages/${encodeURIComponent(packageId)}`,
  packagePriceVersions: (packageId: string) =>
    `${OPS_API_PREFIX}/packages/${encodeURIComponent(packageId)}/price-versions`,
  packageTransition: (packageId: string) =>
    `${OPS_API_PREFIX}/packages/${encodeURIComponent(packageId)}/transition`,
  features: `${OPS_API_PREFIX}/features`,
  feature: (featureKey: string) =>
    `${OPS_API_PREFIX}/features/${encodeURIComponent(featureKey)}`,
} as const;

/** 销售方式，契约 §3.2（`saas` / `private`）。 */
export type SalesMode = 'private' | 'saas';

/** 产品生命周期状态，契约 §3.2 `products.lifecycle_status`。 */
export type ProductLifecycleStatus = 'active' | 'draft' | 'retired';

/** 计费类型，契约 §3.2 `packages.billing_type`（PRD 三种可配置条目类型）。 */
export type PackageBillingType = 'fixed_term' | 'one_time' | 'periodic';

/**
 * 套餐状态。
 *
 * [推导] 契约 §3.2 未枚举 `packages.status` 取值，只出现 `retired`（§3.2 规则、
 * §6.4 `PACKAGE_RETIRED`）与 `POST /packages/{id}/transition` 的
 * `activate`/`retire`；此处按状态机反推为 `draft`/`active`/`retired`，
 * 已在 `README.md` 登记为待后端确认项。
 */
export type PackageStatus = 'active' | 'draft' | 'retired';

/** 权益适用部署范围，契约 §3.2 `package_features.applies_to`。 */
export type FeatureAppliesTo = 'both' | 'private_instance' | 'saas_tenant';

/** 功能键值类型，契约 §3.2 `feature_definitions.value_type`。 */
export type FeatureValueType = 'boolean' | 'quota' | 'term';

export interface PagedQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

/** 分页 `pageSize` 白名单与默认值，契约 §2.4（`listQuerySchema`）。 */
export const OPS_PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50, 100] as const;
export const OPS_DEFAULT_PAGE_SIZE = 15;

export interface ProductSalesMode {
  mode: SalesMode;
  isEnabled: boolean;
}

/**
 * 产品列表条目，契约 §5.3 `GET /products`。
 *
 * `description`/`version` 为客户端展示与乐观锁所需，契约条目未列全：
 * 契约没有「产品详情」端点，`PATCH /products/{id}` 又要求回传 `version`，
 * 因此列表必须下发这两个字段。已登记为待后端确认（README）。
 */
export interface ProductListItem {
  id: string;
  code: string;
  name: string;
  description: null | string;
  lifecycleStatus: ProductLifecycleStatus;
  salesModes: ProductSalesMode[];
  packageCount: number;
  version: number;
}

export interface ProductListQuery extends PagedQuery {
  keyword?: string;
  lifecycleStatus?: ProductLifecycleStatus;
  salesMode?: SalesMode;
}

export interface ProductPage {
  items: ProductListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductCreateInput {
  code: string;
  name: string;
  description?: string;
  salesModes: ProductSalesMode[];
}

export interface ProductUpdateInput {
  name?: string;
  description?: string;
  lifecycleStatus?: ProductLifecycleStatus;
  salesModes?: ProductSalesMode[];
  version: number;
}

/** 套餐列表条目，契约 §5.3 `GET /packages`（`price` 为当前价格版本的挂牌价）。 */
export interface PackageListItem {
  id: string;
  productId: string;
  internalName: string;
  customerName: string;
  salesMode: SalesMode;
  billingType: PackageBillingType;
  price: number;
  currency: string;
  status: PackageStatus;
  effectiveFrom: null | string;
}

export interface PackageListQuery extends PagedQuery {
  productId?: string;
  salesMode?: SalesMode;
  status?: PackageStatus;
  keyword?: string;
}

export interface PackagePage {
  items: PackageListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 套餐聚合（契约 §3.2 `ops.packages` 的对外可见列）。 */
export interface PackageEntity {
  id: string;
  productId: string;
  internalName: string;
  customerName: string;
  salesMode: SalesMode;
  billingType: PackageBillingType;
  defaultTermMonths: null | number;
  currency: string;
  listPrice: number;
  status: PackageStatus;
  effectiveFrom: null | string;
  effectiveTo: null | string;
  currentPriceVersionId: null | string;
  version: number;
}

/** 套餐权益行，契约 §3.2 `ops.package_features`。 */
export interface PackageFeature {
  featureKey: string;
  displayName: string;
  enabled: boolean;
  quota: null | number;
  termMonths: null | number;
  appliesTo: FeatureAppliesTo;
}

/** 价格版本，契约 §5.3 `GET /packages/{id}/price-versions` 的 `items[]`（只读历史）。 */
export interface PackagePriceVersion {
  /**
   * 价格版本 ID。
   *
   * 契约 §5.3 的 `items[]` 只列了 `versionNo`，但 `POST /contracts` 的条目入参
   * 需要 `priceVersionId`；缺 `id` 时前端只能用 `versionNo` 兜底。
   * 已在 `README.md` 登记为待后端确认项。
   */
  id?: string;
  versionNo: number;
  price: number;
  currency: string;
  termMonths: null | number;
  effectiveFrom: string;
  createdBy: null | string;
  createdAt: null | string;
}

/** 当前价格版本（`GET /packages/{id}` 的 `currentPriceVersion`），带 `id` 供合同条目引用。 */
export interface PackagePriceVersionRef extends PackagePriceVersion {
  id: string;
}

/** 套餐详情，契约 §5.3 `GET /packages/{packageId}`。 */
export interface PackageDetail {
  package: PackageEntity;
  features: PackageFeature[];
  currentPriceVersion: null | PackagePriceVersionRef;
}

export interface PackagePriceVersionList {
  items: PackagePriceVersion[];
}

export interface PackageFeatureInput {
  featureKey: string;
  enabled: boolean;
  quota?: null | number;
  termMonths?: null | number;
  appliesTo: FeatureAppliesTo;
}

export interface PackageCreateInput {
  productId: string;
  internalName: string;
  customerName: string;
  salesMode: SalesMode;
  billingType: PackageBillingType;
  defaultTermMonths?: number;
  currency: string;
  listPrice: number;
  features: PackageFeatureInput[];
  effectiveFrom: string;
}

export interface PackageUpdateInput {
  internalName?: string;
  customerName?: string;
  features?: PackageFeatureInput[];
  version: number;
}

export interface PackageCreateResult {
  package: PackageEntity;
  priceVersion: PackagePriceVersionRef;
}

export interface PackageTransitionInput {
  action: 'activate' | 'retire';
  reason: string;
}

/** 功能键定义，契约 §5.3 `GET /features`。 */
export interface FeatureDefinition {
  featureKey: string;
  displayName: string;
  valueType: FeatureValueType;
  unit: null | string;
  description: null | string;
  isActive: boolean;
  usageCount: number;
}

export interface FeatureListQuery extends PagedQuery {
  isActive?: boolean;
  keyword?: string;
}

export interface FeaturePage {
  items: FeatureDefinition[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FeatureCreateInput {
  featureKey: string;
  displayName: string;
  valueType: FeatureValueType;
  unit?: string;
  description?: string;
}

export interface FeatureUpdateInput {
  displayName?: string;
  unit?: string;
  description?: string;
  isActive?: boolean;
}

export async function fetchProducts(
  query: ProductListQuery = {},
): Promise<ProductPage> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchProducts } = await import('./mock');
    return mockFetchProducts(query);
  }
  return requestClient.get<ProductPage>(CATALOG_ENDPOINTS.products, {
    params: query,
  });
}

/** 新建产品。409 `CONFLICT` = `code` 重复（契约 §5.3）。 */
export async function createProduct(
  body: ProductCreateInput,
): Promise<{ product: ProductListItem }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateProduct } = await import('./mock');
    return mockCreateProduct(body);
  }
  return requestClient.post<{ product: ProductListItem }>(
    CATALOG_ENDPOINTS.products,
    body,
  );
}

/** 编辑产品。409 `OBJECT_REFERENCED` = 停用仍被草拟合同引用。 */
export async function updateProduct(
  productId: string,
  body: ProductUpdateInput,
): Promise<{ product: ProductListItem }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdateProduct } = await import('./mock');
    return mockUpdateProduct(productId, body);
  }
  return requestClient.request<{ product: ProductListItem }>(
    CATALOG_ENDPOINTS.product(productId),
    { data: body, method: 'PATCH' },
  );
}

export async function fetchPackages(
  query: PackageListQuery = {},
): Promise<PackagePage> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchPackages } = await import('./mock');
    return mockFetchPackages(query);
  }
  return requestClient.get<PackagePage>(CATALOG_ENDPOINTS.packages, {
    params: query,
  });
}

/** 新建套餐（同时产生第 1 个价格版本），400 = 销售方式未开放。 */
export async function createPackage(
  body: PackageCreateInput,
): Promise<PackageCreateResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreatePackage } = await import('./mock');
    return mockCreatePackage(body);
  }
  return requestClient.post<PackageCreateResult>(
    CATALOG_ENDPOINTS.packages,
    body,
  );
}

export async function fetchPackage(packageId: string): Promise<PackageDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchPackage } = await import('./mock');
    return mockFetchPackage(packageId);
  }
  return requestClient.get<PackageDetail>(CATALOG_ENDPOINTS.package(packageId));
}

export async function updatePackage(
  packageId: string,
  body: PackageUpdateInput,
): Promise<{ package: PackageEntity }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdatePackage } = await import('./mock');
    return mockUpdatePackage(packageId, body);
  }
  return requestClient.request<{ package: PackageEntity }>(
    CATALOG_ENDPOINTS.package(packageId),
    { data: body, method: 'PATCH' },
  );
}

/** 新增价格版本（只影响新合同，不动历史快照）。409 `CONFLICT` = 版本号冲突。 */
export async function createPackagePriceVersion(
  packageId: string,
  body: {
    currency: string;
    effectiveFrom: string;
    price: number;
    termMonths?: number;
  },
): Promise<{ priceVersion: PackagePriceVersionRef }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreatePackagePriceVersion } = await import('./mock');
    return mockCreatePackagePriceVersion(packageId, body);
  }
  return requestClient.post<{ priceVersion: PackagePriceVersionRef }>(
    CATALOG_ENDPOINTS.packagePriceVersions(packageId),
    body,
  );
}

/** 价格版本历史（只读；仅 INSERT 的表，不存在修改入口）。 */
export async function fetchPackagePriceVersions(
  packageId: string,
): Promise<PackagePriceVersionList> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchPackagePriceVersions } = await import('./mock');
    return mockFetchPackagePriceVersions(packageId);
  }
  return requestClient.get<PackagePriceVersionList>(
    CATALOG_ENDPOINTS.packagePriceVersions(packageId),
  );
}

/** 套餐启停。409 `OBJECT_REFERENCED` = 仍被草拟/审核中合同引用。 */
export async function transitionPackage(
  packageId: string,
  body: PackageTransitionInput,
): Promise<{ package: { status: PackageStatus } }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockTransitionPackage } = await import('./mock');
    return mockTransitionPackage(packageId, body);
  }
  return requestClient.post<{ package: { status: PackageStatus } }>(
    CATALOG_ENDPOINTS.packageTransition(packageId),
    body,
  );
}

export async function fetchFeatures(
  query: FeatureListQuery = {},
): Promise<FeaturePage> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockFetchFeatures } = await import('./mock');
    return mockFetchFeatures(query);
  }
  return requestClient.get<FeaturePage>(CATALOG_ENDPOINTS.features, {
    params: query,
  });
}

/** 新建功能键。409 `CONFLICT` = `featureKey` 已存在。 */
export async function createFeature(
  body: FeatureCreateInput,
): Promise<{ feature: FeatureDefinition }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockCreateFeature } = await import('./mock');
    return mockCreateFeature(body);
  }
  return requestClient.post<{ feature: FeatureDefinition }>(
    CATALOG_ENDPOINTS.features,
    body,
  );
}

/** 编辑功能键（`featureKey`/`valueType` 不可改，契约 §3.2）。 */
export async function updateFeature(
  featureKey: string,
  body: FeatureUpdateInput,
): Promise<{ feature: FeatureDefinition }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { mockUpdateFeature } = await import('./mock');
    return mockUpdateFeature(featureKey, body);
  }
  return requestClient.request<{ feature: FeatureDefinition }>(
    CATALOG_ENDPOINTS.feature(featureKey),
    { data: body, method: 'PATCH' },
  );
}
