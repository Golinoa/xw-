import type { FixturePackageRecord } from './fixtures';
import type {
  FeatureCreateInput,
  FeatureDefinition,
  FeatureListQuery,
  FeaturePage,
  FeatureUpdateInput,
  PackageCreateInput,
  PackageCreateResult,
  PackageDetail,
  PackageEntity,
  PackageListQuery,
  PackagePage,
  PackagePriceVersion,
  PackagePriceVersionRef,
  PackageStatus,
  PackageTransitionInput,
  PackageUpdateInput,
  ProductCreateInput,
  ProductListItem,
  ProductListQuery,
  ProductPage,
  ProductUpdateInput,
} from './index';

/**
 * catalog 域开发态桩（仅 `VITE_OPS_MOCK=true`）。
 *
 * 行为尽量贴契约：价格版本只增不改、套餐停用检查草拟合同引用、
 * 功能键不可改名。桩内的「草拟合同引用」是硬编码的演示规则，
 * 真实判定必须由后端完成（见 `README.md`）。
 */
import { OpsApiError } from '#/api/adapter/errors';

import {
  FIXTURE_FEATURES,
  FIXTURE_PACKAGES,
  FIXTURE_PRODUCTS,
} from './fixtures';

const STUB_LATENCY_MS = 60;

/** 契约 §2.2 金额上限：`numeric(14,2)`。 */
const MAX_AMOUNT = 999_999_999_999.99;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

const products: ProductListItem[] = clone(FIXTURE_PRODUCTS);
const packages: FixturePackageRecord[] = clone(FIXTURE_PACKAGES);
const features: FeatureDefinition[] = clone(FIXTURE_FEATURES);

/** 演示用「被草拟合同引用」的套餐（契约 §3.2：停用前必须检查草拟合同引用）。 */
const DRAFT_REFERENCED_PACKAGE_IDS = new Set(['pkg-0002']);

let packageSequence = 5;
let priceVersionSequence = 5;

function conflict(message: string): OpsApiError {
  return new OpsApiError({
    code: 'CONFLICT',
    kind: 'http',
    retryable: false,
    status: 409,
    userMessage: message,
  });
}

function notFound(message: string): OpsApiError {
  return new OpsApiError({
    code: 'NOT_FOUND',
    kind: 'http',
    retryable: false,
    status: 404,
    userMessage: message,
  });
}

function validation(message: string): OpsApiError {
  return new OpsApiError({
    code: 'VALIDATION_ERROR',
    kind: 'http',
    retryable: false,
    status: 400,
    userMessage: message,
  });
}

function paginate<T>(rows: T[], page = 1, pageSize = 15) {
  const start = (page - 1) * pageSize;
  return {
    items: rows.slice(start, start + pageSize),
    page,
    pageSize,
    total: rows.length,
  };
}

function currentPrice(
  record: FixturePackageRecord,
): null | PackagePriceVersionRef {
  const versions = record.priceVersions.toSorted(
    (left, right) => right.versionNo - left.versionNo,
  );
  return versions[0] ?? null;
}

function toPackageListItem(record: FixturePackageRecord) {
  const price = currentPrice(record);
  return {
    billingType: record.package.billingType,
    currency: record.package.currency,
    customerName: record.package.customerName,
    effectiveFrom: record.package.effectiveFrom,
    id: record.package.id,
    internalName: record.package.internalName,
    price: price?.price ?? record.package.listPrice,
    productId: record.package.productId,
    salesMode: record.package.salesMode,
    status: record.package.status,
  };
}

function findPackage(packageId: string): FixturePackageRecord {
  const record = packages.find((item) => item.package.id === packageId);
  if (!record) {
    throw notFound('套餐不存在或已被移除');
  }
  return record;
}

export async function mockFetchProducts(
  query: ProductListQuery = {},
): Promise<ProductPage> {
  const keyword = (query.keyword ?? '').trim();
  const rows = products.filter((product) => {
    if (
      query.lifecycleStatus &&
      product.lifecycleStatus !== query.lifecycleStatus
    ) {
      return false;
    }
    if (
      query.salesMode &&
      !product.salesModes.some(
        (item) => item.mode === query.salesMode && item.isEnabled,
      )
    ) {
      return false;
    }
    if (
      keyword !== '' &&
      !`${product.name} ${product.code}`.includes(keyword)
    ) {
      return false;
    }
    return true;
  });
  return delay(paginate(rows, query.page, query.pageSize));
}

export async function mockCreateProduct(
  body: ProductCreateInput,
): Promise<{ product: ProductListItem }> {
  const code = body.code.trim();
  if (code === '' || body.name.trim() === '') {
    throw validation('产品编码与名称不能为空');
  }
  if (products.some((item) => item.code === code)) {
    throw conflict(`产品编码 ${code} 已存在`);
  }
  const product: ProductListItem = {
    code,
    description: body.description ?? null,
    id: `prd-${String(products.length + 1).padStart(4, '0')}`,
    lifecycleStatus: 'draft',
    name: body.name.trim(),
    packageCount: 0,
    salesModes: body.salesModes.map((item) => ({ ...item })),
    version: 1,
  };
  products.unshift(product);
  return delay({ product: clone(product) });
}

export async function mockUpdateProduct(
  productId: string,
  body: ProductUpdateInput,
): Promise<{ product: ProductListItem }> {
  const target = products.find((item) => item.id === productId);
  if (!target) {
    throw notFound('产品不存在或已被移除');
  }
  if (body.version !== target.version) {
    throw conflict('产品已被他人修改，请刷新后重试');
  }
  if (
    body.lifecycleStatus === 'retired' &&
    packages.some(
      (item) =>
        item.package.productId === productId &&
        item.package.status === 'active',
    )
  ) {
    throw new OpsApiError({
      code: 'OBJECT_REFERENCED',
      kind: 'http',
      retryable: false,
      status: 409,
      userMessage: '该产品下仍有在售套餐或草拟合同引用，不能停用',
    });
  }
  Object.assign(target, {
    description: body.description ?? target.description,
    lifecycleStatus: body.lifecycleStatus ?? target.lifecycleStatus,
    name: body.name?.trim() ?? target.name,
    salesModes: body.salesModes ?? target.salesModes,
    version: target.version + 1,
  });
  return delay({ product: clone(target) });
}

export async function mockFetchPackages(
  query: PackageListQuery = {},
): Promise<PackagePage> {
  const keyword = (query.keyword ?? '').trim();
  const rows = packages
    .filter((record) => {
      if (query.productId && record.package.productId !== query.productId) {
        return false;
      }
      if (query.salesMode && record.package.salesMode !== query.salesMode) {
        return false;
      }
      if (query.status && record.package.status !== query.status) {
        return false;
      }
      if (
        keyword !== '' &&
        !`${record.package.internalName} ${record.package.customerName}`.includes(
          keyword,
        )
      ) {
        return false;
      }
      return true;
    })
    .map((record) => toPackageListItem(record));
  return delay(paginate(rows, query.page, query.pageSize));
}

export async function mockCreatePackage(
  body: PackageCreateInput,
): Promise<PackageCreateResult> {
  const product = products.find((item) => item.id === body.productId);
  if (!product) {
    throw notFound('产品不存在或已被移除');
  }
  if (
    !product.salesModes.some(
      (item) => item.mode === body.salesMode && item.isEnabled,
    )
  ) {
    throw validation('该产品未开放此销售方式，不能创建套餐');
  }
  if (!(body.listPrice >= 0 && body.listPrice <= MAX_AMOUNT)) {
    throw validation('挂牌价必须在 0 到 999,999,999,999.99 之间');
  }
  if (
    packages.some(
      (item) =>
        item.package.productId === body.productId &&
        item.package.salesMode === body.salesMode &&
        item.package.internalName === body.internalName.trim(),
    )
  ) {
    throw conflict('同一产品与销售方式下已存在同名套餐');
  }

  packageSequence += 1;
  const packageId = `pkg-${String(packageSequence).padStart(4, '0')}`;
  priceVersionSequence += 1;
  const priceVersion: PackagePriceVersionRef = {
    createdBy: '示例运营（桩）',
    createdAt: new Date().toISOString(),
    currency: body.currency,
    effectiveFrom: body.effectiveFrom,
    id: `pv-${String(priceVersionSequence).padStart(4, '0')}`,
    price: body.listPrice,
    termMonths: body.defaultTermMonths ?? null,
    versionNo: 1,
  };
  const entity: PackageEntity = {
    billingType: body.billingType,
    currency: body.currency,
    currentPriceVersionId: priceVersion.id,
    customerName: body.customerName.trim(),
    defaultTermMonths: body.defaultTermMonths ?? null,
    effectiveFrom: body.effectiveFrom,
    effectiveTo: null,
    id: packageId,
    internalName: body.internalName.trim(),
    listPrice: body.listPrice,
    productId: body.productId,
    salesMode: body.salesMode,
    status: 'draft',
    version: 1,
  };
  packages.unshift({
    features: body.features.map((item) => {
      const definition = features.find(
        (featureItem) => featureItem.featureKey === item.featureKey,
      );
      return {
        appliesTo: item.appliesTo,
        displayName: definition?.displayName ?? item.featureKey,
        enabled: item.enabled,
        featureKey: item.featureKey,
        quota: item.quota ?? null,
        termMonths: item.termMonths ?? null,
      };
    }),
    package: entity,
    priceVersions: [priceVersion],
  });
  product.packageCount += 1;
  return delay({
    package: clone(entity),
    priceVersion: clone(priceVersion),
  });
}

export async function mockFetchPackage(
  packageId: string,
): Promise<PackageDetail> {
  const record = findPackage(packageId);
  return delay({
    currentPriceVersion: currentPrice(record),
    features: clone(record.features),
    package: clone(record.package),
  });
}

export async function mockUpdatePackage(
  packageId: string,
  body: PackageUpdateInput,
): Promise<{ package: PackageEntity }> {
  const record = findPackage(packageId);
  if (body.version !== record.package.version) {
    throw conflict('套餐已被他人修改，请刷新后重试');
  }
  const entity: PackageEntity = {
    ...record.package,
    customerName: body.customerName?.trim() ?? record.package.customerName,
    internalName: body.internalName?.trim() ?? record.package.internalName,
    version: record.package.version + 1,
  };
  record.package = entity;
  if (body.features) {
    record.features = body.features.map((item) => {
      const definition = features.find(
        (featureItem) => featureItem.featureKey === item.featureKey,
      );
      return {
        appliesTo: item.appliesTo,
        displayName: definition?.displayName ?? item.featureKey,
        enabled: item.enabled,
        featureKey: item.featureKey,
        quota: item.quota ?? null,
        termMonths: item.termMonths ?? null,
      };
    });
  }
  return delay({ package: clone(entity) });
}

export async function mockCreatePackagePriceVersion(
  packageId: string,
  body: {
    currency: string;
    effectiveFrom: string;
    price: number;
    termMonths?: number;
  },
): Promise<{ priceVersion: PackagePriceVersionRef }> {
  const record = findPackage(packageId);
  if (!(body.price >= 0 && body.price <= MAX_AMOUNT)) {
    throw validation('价格必须在 0 到 999,999,999,999.99 之间');
  }
  const latest = currentPrice(record);
  if (latest && body.effectiveFrom < latest.effectiveFrom) {
    throw validation('新价格版本的生效日不得早于当前版本');
  }
  priceVersionSequence += 1;
  const created: PackagePriceVersionRef = {
    createdBy: '示例运营（桩）',
    createdAt: new Date().toISOString(),
    currency: body.currency,
    effectiveFrom: body.effectiveFrom,
    id: `pv-${String(priceVersionSequence).padStart(4, '0')}`,
    price: body.price,
    termMonths: body.termMonths ?? null,
    versionNo: (latest?.versionNo ?? 0) + 1,
  };
  // 只追加：历史版本原样保留，不覆盖、不删除（契约 §3.2 仅 INSERT）
  record.priceVersions.push(created);
  record.package.currentPriceVersionId = created.id;
  record.package.listPrice = created.price;
  record.package.version += 1;
  return delay({ priceVersion: clone(created) });
}

export async function mockFetchPackagePriceVersions(
  packageId: string,
): Promise<{ items: PackagePriceVersion[] }> {
  const record = findPackage(packageId);
  const items = record.priceVersions
    .toSorted((left, right) => right.versionNo - left.versionNo)
    .map((item) => ({
      createdAt: item.createdAt,
      createdBy: item.createdBy,
      currency: item.currency,
      effectiveFrom: item.effectiveFrom,
      id: item.id,
      price: item.price,
      termMonths: item.termMonths,
      versionNo: item.versionNo,
    }));
  return delay({ items });
}

const ALLOWED_TRANSITION: Record<'activate' | 'retire', PackageStatus[]> = {
  activate: ['draft', 'retired'],
  retire: ['active', 'draft'],
};

export async function mockTransitionPackage(
  packageId: string,
  body: PackageTransitionInput,
): Promise<{ package: { status: PackageStatus } }> {
  const record = findPackage(packageId);
  if (!body.reason?.trim()) {
    throw validation('该操作必须填写原因');
  }
  if (!ALLOWED_TRANSITION[body.action].includes(record.package.status)) {
    throw new OpsApiError({
      code: 'STATE_CONFLICT',
      kind: 'http',
      retryable: false,
      status: 409,
      userMessage: `当前状态（${record.package.status}）不允许执行该操作`,
    });
  }
  if (body.action === 'retire' && DRAFT_REFERENCED_PACKAGE_IDS.has(packageId)) {
    throw new OpsApiError({
      code: 'OBJECT_REFERENCED',
      kind: 'http',
      retryable: false,
      status: 409,
      userMessage: '仍有草拟/审核中的合同引用该套餐，不能停用',
    });
  }
  record.package.status = body.action === 'activate' ? 'active' : 'retired';
  record.package.version += 1;
  return delay({ package: { status: record.package.status } });
}

export async function mockFetchFeatures(
  query: FeatureListQuery = {},
): Promise<FeaturePage> {
  const keyword = (query.keyword ?? '').trim();
  const rows = features.filter((feature) => {
    if (query.isActive !== undefined && feature.isActive !== query.isActive) {
      return false;
    }
    if (
      keyword !== '' &&
      !`${feature.featureKey} ${feature.displayName}`.includes(keyword)
    ) {
      return false;
    }
    return true;
  });
  return delay(paginate(rows, query.page, query.pageSize));
}

export async function mockCreateFeature(
  body: FeatureCreateInput,
): Promise<{ feature: FeatureDefinition }> {
  const featureKey = body.featureKey.trim();
  if (featureKey === '' || body.displayName.trim() === '') {
    throw validation('功能键与显示名称不能为空');
  }
  if (features.some((item) => item.featureKey === featureKey)) {
    throw conflict(`功能键 ${featureKey} 已存在`);
  }
  const feature: FeatureDefinition = {
    description: body.description ?? null,
    displayName: body.displayName.trim(),
    featureKey,
    isActive: true,
    unit: body.unit ?? null,
    usageCount: 0,
    valueType: body.valueType,
  };
  features.unshift(feature);
  return delay({ feature: clone(feature) });
}

export async function mockUpdateFeature(
  featureKey: string,
  body: FeatureUpdateInput,
): Promise<{ feature: FeatureDefinition }> {
  const target = features.find((item) => item.featureKey === featureKey);
  if (!target) {
    throw notFound('功能键不存在');
  }
  Object.assign(target, {
    description: body.description ?? target.description,
    displayName: body.displayName?.trim() ?? target.displayName,
    isActive: body.isActive ?? target.isActive,
    unit: body.unit ?? target.unit,
  });
  return delay({ feature: clone(target) });
}
