import {
  z,
  type OpsBillingType,
  type OpsCatalogImpact,
  type OpsFeature,
  type OpsFeatureAppliesTo,
  type OpsFeatureListItem,
  type OpsFeatureValueType,
  type OpsPackage,
  type OpsPackageFeature,
  type OpsPackageListItem,
  type OpsPackageStatus,
  type OpsPriceVersion,
  type OpsPriceVersionListItem,
  type OpsProduct,
  type OpsProductLifecycleStatus,
  type OpsProductListItem,
  type OpsSalesMode,
} from '@erp/contracts';

/**
 * RPC 返回值（数据库列名）与出口形状（契约字段名）之间的那一层。
 *
 * 与客户域同构：RPC 一律返回 snake_case（`jsonb_build_object('list_price', …)`），
 * 出口一律 camelCase。直接 `as` 断言会让列改名变成前端拿到 `undefined`，
 * 有了 zod 校验，同样的漂移会以 `ops_rpc_shape_invalid` + RPC 名出现在日志里。
 *
 * **金额是 number**：`numeric(14,2)` 经 `jsonb_build_object` 出来就是 JSON number。
 * 如果哪天数据层改成 `to_char` 返回字符串，这里的 `z.number()` 会立刻失败（503），
 * 而不是让前端 `Number("1,200.00")` 得到 `NaN`。
 */

export const productSalesModeRowSchema = z.object({
  mode: z.enum(['saas', 'private']),
  is_enabled: z.boolean(),
});

export const productRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  lifecycle_status: z.enum(['draft', 'active', 'retired']),
  sales_modes: z.array(productSalesModeRowSchema),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type ProductRow = z.infer<typeof productRowSchema>;

export const productListRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  lifecycle_status: z.enum(['draft', 'active', 'retired']),
  sales_modes: z.array(productSalesModeRowSchema),
  package_count: z.number().int().min(0),
  version: z.number().int(),
});

export type ProductListRow = z.infer<typeof productListRowSchema>;

function toSalesModes(row: { sales_modes: Array<{ mode: string; is_enabled: boolean }> }) {
  return row.sales_modes.map((mode) => ({
    mode: mode.mode as OpsSalesMode,
    isEnabled: mode.is_enabled,
  }));
}

export function toProduct(row: ProductRow): OpsProduct {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    lifecycleStatus: row.lifecycle_status as OpsProductLifecycleStatus,
    salesModes: toSalesModes(row),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toProductListItem(row: ProductListRow): OpsProductListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    lifecycleStatus: row.lifecycle_status as OpsProductLifecycleStatus,
    salesModes: toSalesModes(row),
    packageCount: row.package_count,
    version: row.version,
  };
}

export const packageProductRowSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
});

export const packageRowSchema = z.object({
  id: z.string().min(1),
  product_id: z.string().min(1),
  product: packageProductRowSchema,
  internal_name: z.string().nullable(),
  customer_name: z.string().nullable(),
  sales_mode: z.enum(['saas', 'private']),
  billing_type: z.enum(['periodic', 'fixed_term', 'one_time']),
  default_term_months: z.number().int().nullable(),
  currency: z.string().min(1),
  list_price: z.number().min(0),
  status: z.enum(['draft', 'active', 'retired']),
  effective_from: z.string().nullable(),
  effective_to: z.string().nullable(),
  current_price_version_id: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type PackageRow = z.infer<typeof packageRowSchema>;

export const packageListRowSchema = z.object({
  id: z.string().min(1),
  product_id: z.string().min(1),
  internal_name: z.string().nullable(),
  customer_name: z.string().nullable(),
  sales_mode: z.enum(['saas', 'private']),
  billing_type: z.enum(['periodic', 'fixed_term', 'one_time']),
  price: z.number().min(0),
  currency: z.string().min(1),
  status: z.enum(['draft', 'active', 'retired']),
  effective_from: z.string().nullable(),
  version: z.number().int(),
});

export type PackageListRow = z.infer<typeof packageListRowSchema>;

export function toPackage(row: PackageRow): OpsPackage {
  return {
    id: row.id,
    productId: row.product_id,
    product: { id: row.product.id, code: row.product.code, name: row.product.name },
    internalName: row.internal_name,
    customerName: row.customer_name,
    salesMode: row.sales_mode as OpsSalesMode,
    billingType: row.billing_type as OpsBillingType,
    defaultTermMonths: row.default_term_months,
    currency: row.currency,
    listPrice: row.list_price,
    status: row.status as OpsPackageStatus,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    currentPriceVersionId: row.current_price_version_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPackageListItem(row: PackageListRow): OpsPackageListItem {
  return {
    id: row.id,
    productId: row.product_id,
    internalName: row.internal_name,
    customerName: row.customer_name,
    salesMode: row.sales_mode as OpsSalesMode,
    billingType: row.billing_type as OpsBillingType,
    price: row.price,
    currency: row.currency,
    status: row.status as OpsPackageStatus,
    effectiveFrom: row.effective_from,
    version: row.version,
  };
}

export const priceVersionRowSchema = z.object({
  id: z.string().min(1),
  package_id: z.string().min(1),
  version_no: z.number().int().positive(),
  price: z.number().min(0),
  currency: z.string().min(1),
  term_months: z.number().int().nullable(),
  effective_from: z.string().min(1),
  created_by: z.string().nullable(),
  created_at: z.string().min(1),
});

export type PriceVersionRow = z.infer<typeof priceVersionRowSchema>;

export const priceVersionListRowSchema = z.object({
  version_no: z.number().int().positive(),
  price: z.number().min(0),
  currency: z.string().min(1),
  term_months: z.number().int().nullable(),
  effective_from: z.string().min(1),
  created_by: z.string().nullable(),
  created_at: z.string().min(1),
});

export function toPriceVersion(row: PriceVersionRow): OpsPriceVersion {
  return {
    id: row.id,
    packageId: row.package_id,
    versionNo: row.version_no,
    price: row.price,
    currency: row.currency,
    termMonths: row.term_months,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function toPriceVersionListItem(
  row: z.infer<typeof priceVersionListRowSchema>,
): OpsPriceVersionListItem {
  return {
    versionNo: row.version_no,
    price: row.price,
    currency: row.currency,
    termMonths: row.term_months,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export const packageFeatureRowSchema = z.object({
  feature_key: z.string().min(1),
  display_name: z.string().min(1),
  enabled: z.boolean(),
  quota_value: z.number().nullable(),
  term_months: z.number().int().nullable(),
  applies_to: z.enum(['saas_tenant', 'private_instance', 'both']),
});

export function toPackageFeature(row: z.infer<typeof packageFeatureRowSchema>): OpsPackageFeature {
  return {
    featureKey: row.feature_key,
    displayName: row.display_name,
    enabled: row.enabled,
    quotaValue: row.quota_value,
    termMonths: row.term_months,
    appliesTo: row.applies_to as OpsFeatureAppliesTo,
  };
}

export const featureRowSchema = z.object({
  feature_key: z.string().min(1),
  display_name: z.string().min(1),
  value_type: z.enum(['boolean', 'quota', 'term']),
  unit: z.string().nullable(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export function toFeature(row: z.infer<typeof featureRowSchema>): OpsFeature {
  return {
    featureKey: row.feature_key,
    displayName: row.display_name,
    valueType: row.value_type as OpsFeatureValueType,
    unit: row.unit,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const featureListRowSchema = z.object({
  feature_key: z.string().min(1),
  display_name: z.string().min(1),
  value_type: z.enum(['boolean', 'quota', 'term']),
  unit: z.string().nullable(),
  is_active: z.boolean(),
  usage_count: z.number().int().min(0),
});

export function toFeatureListItem(row: z.infer<typeof featureListRowSchema>): OpsFeatureListItem {
  return {
    featureKey: row.feature_key,
    displayName: row.display_name,
    valueType: row.value_type as OpsFeatureValueType,
    unit: row.unit,
    isActive: row.is_active,
    usageCount: row.usage_count,
  };
}

/**
 * 引用守卫的返回值（§3）。只有 `draft_contracts` 一项：合同域还没落地，
 * 这里加字段就是拿一个猜测去卡一份还没写的迁移。
 */
export const catalogImpactRowSchema = z.object({
  draft_contracts: z.number().int().min(0),
});

export function toImpact(row: z.infer<typeof catalogImpactRowSchema>): OpsCatalogImpact {
  return { draftContracts: row.draft_contracts };
}

/** 三个列表共用的外壳：本轮不分页。 */
export const productListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(productListRowSchema),
});

export const productCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), product: productRowSchema }),
  z.object({ status: z.literal('code_conflict') }),
  /** 至少一条销售方式记录才可销售（§4 约定）。 */
  z.object({ status: z.literal('sales_modes_required') }),
  /**
   * 非法销售方式时，库里回的是 `mode`（元素里那一个值，可能为 null），
   * 而不是 `sales_mode`。两个键都收：前者是当前实现，后者是 §4 文字里的叫法，
   * 谁先改都不该让一个纯拒绝分支变成 503。
   */
  z.object({
    status: z.literal('invalid_sales_mode'),
    mode: z.string().nullish(),
    sales_mode: z.string().nullish(),
  }),
]);

export const productUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), product: productRowSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('referenced'), impact: catalogImpactRowSchema }),
  /** `retired` 是终态：回到 draft/active 是这条（§5），不是 version_mismatch。 */
  z.object({ status: z.literal('invalid_transition') }),
  z.object({ status: z.literal('sales_modes_required') }),
  z.object({
    status: z.literal('invalid_sales_mode'),
    mode: z.string().nullish(),
    sales_mode: z.string().nullish(),
  }),
]);

export const packageListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(packageListRowSchema),
});

export const packageCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    package: packageRowSchema,
    price_version: priceVersionRowSchema,
  }),
  z.object({ status: z.literal('product_not_found') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
  z.object({ status: z.literal('internal_name_conflict') }),
  /** `feature_key` 可空：库对「元素里没带键」回 null，那不是 503，是同一个拒绝分支。 */
  z.object({ status: z.literal('feature_not_found'), feature_key: z.string().nullish() }),
]);

export const packageDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    package: packageRowSchema,
    features: z.array(packageFeatureRowSchema),
    current_price_version: priceVersionRowSchema.nullable(),
  }),
  z.object({ status: z.literal('not_found') }),
]);

export const packageUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), package: packageRowSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('internal_name_conflict') }),
  z.object({ status: z.literal('feature_not_found'), feature_key: z.string().nullish() }),
]);

export const priceVersionCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    price_version: priceVersionRowSchema,
    package: packageRowSchema,
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('price_version_conflict') }),
]);

export const priceVersionListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(priceVersionListRowSchema) }),
  z.object({ status: z.literal('not_found') }),
]);

export const packageTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    package: z.object({
      status: z.enum(['draft', 'active', 'retired']),
      version: z.number().int(),
    }),
    impact: catalogImpactRowSchema,
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('invalid_transition') }),
  z.object({ status: z.literal('referenced'), impact: catalogImpactRowSchema }),
  /** `activate` 前必须至少有一条价格版本（§5）。 */
  z.object({ status: z.literal('price_version_required') }),
]);

export const featureListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(featureListRowSchema),
});

export const featureCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), feature: featureRowSchema }),
  z.object({ status: z.literal('feature_key_conflict') }),
]);

export const featureUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), feature: featureRowSchema }),
  z.object({ status: z.literal('not_found') }),
]);
