/**
 * catalog 域开发态虚构数据（仅 `VITE_OPS_MOCK=true` 时由 `./mock` 引用）。
 *
 * 全部虚构：产品/套餐名称带「示例」前缀，价格仅为演示用整数金额，
 * 不代表任何真实报价。生产构建随 `./mock` 一起被 tree-shake。
 */
import type {
  FeatureDefinition,
  PackageEntity,
  PackageFeature,
  PackagePriceVersionRef,
  ProductListItem,
} from './index';

export interface FixturePackageRecord {
  package: PackageEntity;
  features: PackageFeature[];
  /** 价格版本按 `versionNo` 升序存放，最后一条即当前版本（只增不改）。 */
  priceVersions: PackagePriceVersionRef[];
}

export const FIXTURE_PRODUCTS: ProductListItem[] = [
  {
    code: 'OPS-SAAS-CORE',
    description: '示例：面向旅行社的 SaaS 主产品，含预订、订单与财务模块',
    id: 'prd-0001',
    lifecycleStatus: 'active',
    name: '示例旅行社管理平台',
    packageCount: 3,
    salesModes: [
      { isEnabled: true, mode: 'saas' },
      { isEnabled: false, mode: 'private' },
    ],
    version: 4,
  },
  {
    code: 'OPS-PRIVATE-SUITE',
    description: '示例：私有化交付套件，含部署与现场支持',
    id: 'prd-0002',
    lifecycleStatus: 'active',
    name: '示例私有化套件',
    packageCount: 1,
    salesModes: [
      { isEnabled: false, mode: 'saas' },
      { isEnabled: true, mode: 'private' },
    ],
    version: 2,
  },
  {
    code: 'OPS-ANALYTICS',
    description: '示例：经营分析插件（未发布）',
    id: 'prd-0003',
    lifecycleStatus: 'draft',
    name: '示例经营分析插件',
    packageCount: 1,
    salesModes: [
      { isEnabled: true, mode: 'saas' },
      { isEnabled: false, mode: 'private' },
    ],
    version: 1,
  },
];

export const FIXTURE_FEATURES: FeatureDefinition[] = [
  {
    description: '示例：是否启用预订模块',
    displayName: '预订管理',
    featureKey: 'core.booking',
    isActive: true,
    unit: null,
    usageCount: 4,
    valueType: 'boolean',
  },
  {
    description: '示例：每月可创建的订单条数上限',
    displayName: '月度订单额度',
    featureKey: 'core.order_quota',
    isActive: true,
    unit: '单/月',
    usageCount: 3,
    valueType: 'quota',
  },
  {
    description: '示例：财务模块启用开关',
    displayName: '财务模块',
    featureKey: 'core.finance',
    isActive: true,
    unit: null,
    usageCount: 2,
    valueType: 'boolean',
  },
  {
    description: '示例：可开通的子账号数量',
    displayName: '子账号数',
    featureKey: 'core.sub_account_quota',
    isActive: true,
    unit: '个',
    usageCount: 3,
    valueType: 'quota',
  },
  {
    description: '示例：私有化授权期限',
    displayName: '授权期限',
    featureKey: 'private.license_term',
    isActive: true,
    unit: '月',
    usageCount: 1,
    valueType: 'term',
  },
  {
    description: '示例：现场支持人天（历史功能键，已停用）',
    displayName: '现场支持人天',
    featureKey: 'private.onsite_support',
    isActive: false,
    unit: '人天',
    usageCount: 1,
    valueType: 'quota',
  },
];

function feature(
  featureKey: string,
  enabled: boolean,
  extra: Partial<PackageFeature> = {},
): PackageFeature {
  const definition = FIXTURE_FEATURES.find(
    (item) => item.featureKey === featureKey,
  );
  return {
    appliesTo: 'both',
    displayName: definition?.displayName ?? featureKey,
    enabled,
    featureKey,
    quota: null,
    termMonths: null,
    ...extra,
  };
}

export const FIXTURE_PACKAGES: FixturePackageRecord[] = [
  {
    features: [
      feature('core.booking', true),
      feature('core.order_quota', true, { quota: 3000 }),
      feature('core.sub_account_quota', true, { quota: 20 }),
      feature('core.finance', false),
    ],
    package: {
      billingType: 'periodic',
      currency: 'CNY',
      currentPriceVersionId: 'pv-0001-2',
      customerName: '标准版',
      defaultTermMonths: 12,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      id: 'pkg-0001',
      internalName: '标准版（示例）',
      listPrice: 128_000,
      productId: 'prd-0001',
      salesMode: 'saas',
      status: 'active',
      version: 3,
    },
    priceVersions: [
      {
        createdBy: '示例商务甲',
        createdAt: '2025-12-20T02:00:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-01-01',
        id: 'pv-0001-1',
        price: 118_000,
        termMonths: 12,
        versionNo: 1,
      },
      {
        createdBy: '示例商务甲',
        createdAt: '2026-06-18T03:10:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-07-01',
        id: 'pv-0001-2',
        price: 128_000,
        termMonths: 12,
        versionNo: 2,
      },
    ],
  },
  {
    features: [
      feature('core.booking', true),
      feature('core.order_quota', true, { quota: 20_000 }),
      feature('core.sub_account_quota', true, { quota: 100 }),
      feature('core.finance', true),
    ],
    package: {
      billingType: 'periodic',
      currency: 'CNY',
      currentPriceVersionId: 'pv-0002-2',
      customerName: '专业版',
      defaultTermMonths: 12,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      id: 'pkg-0002',
      internalName: '专业版（示例）',
      listPrice: 268_000,
      productId: 'prd-0001',
      salesMode: 'saas',
      status: 'active',
      version: 5,
    },
    priceVersions: [
      {
        createdBy: '示例商务甲',
        createdAt: '2025-12-20T02:05:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-01-01',
        id: 'pv-0002-1',
        price: 248_000,
        termMonths: 12,
        versionNo: 1,
      },
      {
        createdBy: '示例商务乙',
        createdAt: '2026-06-18T03:20:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-07-01',
        id: 'pv-0002-2',
        price: 268_000,
        termMonths: 12,
        versionNo: 2,
      },
    ],
  },
  {
    features: [
      feature('private.license_term', true, {
        appliesTo: 'private_instance',
        termMonths: 12,
      }),
      feature('core.finance', true, { appliesTo: 'private_instance' }),
      feature('private.onsite_support', true, {
        appliesTo: 'private_instance',
        quota: 10,
      }),
    ],
    package: {
      billingType: 'fixed_term',
      currency: 'CNY',
      currentPriceVersionId: 'pv-0003-1',
      customerName: '私有化标准授权',
      defaultTermMonths: 12,
      effectiveFrom: '2026-02-01',
      effectiveTo: null,
      id: 'pkg-0003',
      internalName: '私有化标准授权（示例）',
      listPrice: 480_000,
      productId: 'prd-0002',
      salesMode: 'private',
      status: 'active',
      version: 2,
    },
    priceVersions: [
      {
        createdBy: '示例交付丙',
        createdAt: '2026-01-15T06:00:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-02-01',
        id: 'pv-0003-1',
        price: 480_000,
        termMonths: 12,
        versionNo: 1,
      },
    ],
  },
  {
    features: [feature('core.booking', true, { appliesTo: 'saas_tenant' })],
    package: {
      billingType: 'one_time',
      currency: 'CNY',
      currentPriceVersionId: 'pv-0004-1',
      customerName: '实施服务包',
      defaultTermMonths: null,
      effectiveFrom: '2026-03-01',
      effectiveTo: null,
      id: 'pkg-0004',
      internalName: '实施服务包（示例）',
      listPrice: 60_000,
      productId: 'prd-0001',
      salesMode: 'saas',
      status: 'active',
      version: 1,
    },
    priceVersions: [
      {
        createdBy: '示例交付丙',
        createdAt: '2026-02-10T01:00:00Z',
        currency: 'CNY',
        effectiveFrom: '2026-03-01',
        id: 'pv-0004-1',
        price: 60_000,
        termMonths: null,
        versionNo: 1,
      },
    ],
  },
  {
    features: [feature('core.booking', true)],
    package: {
      billingType: 'periodic',
      currency: 'CNY',
      currentPriceVersionId: 'pv-0005-1',
      customerName: '轻量版（已停售）',
      defaultTermMonths: 12,
      effectiveFrom: '2025-06-01',
      effectiveTo: '2026-06-30',
      id: 'pkg-0005',
      internalName: '轻量版（示例·已停售）',
      listPrice: 68_000,
      productId: 'prd-0001',
      salesMode: 'saas',
      status: 'retired',
      version: 6,
    },
    priceVersions: [
      {
        createdBy: '示例商务乙',
        createdAt: '2025-05-20T02:00:00Z',
        currency: 'CNY',
        effectiveFrom: '2025-06-01',
        id: 'pv-0005-1',
        price: 68_000,
        termMonths: 12,
        versionNo: 1,
      },
    ],
  },
];
