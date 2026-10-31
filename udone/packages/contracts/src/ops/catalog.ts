import { z } from 'zod';
import { opsSalesModeSchema, opsSupportedCurrencySchema } from './meta';

/**
 * 运营端产品目录（契约 §3.2 / §5.3 的十三个端点）。
 *
 * 三个实体共用一份文件而不是拆成 product/package/feature 三份：套餐的筛选参数带
 * `salesMode`（产品的枚举）、套餐详情嵌产品摘要、权益键来自 `feature_definitions`。
 * 拆开之后，`OPS_SALES_MODES` 会被三份文件各自 import 一次，其中一份迟早会漏改
 * ——而漏改的表现是「套餐创建收得下 `private`，产品列表筛不出 `private`」。
 *
 * **金额一律是 JSON number**：库里 `numeric(14,2)` 经 `jsonb_build_object` 出来就是
 * 数字，不是字符串。按字符串建模会让前端每处金额都要 `Number()`，且 `"0.00"` 与
 * `0` 在比较里不相等——价格判断错一次就是算错钱。
 *
 * 销售方式与币种也不在这里重新定义：直接用 `./meta` 的 `opsSalesModeSchema` 与
 * `opsSupportedCurrencySchema`（`GET /meta` 的 `supportedSalesModes` /
 * `supportedCurrencies` 与本域必须是同一份常量，T-01 验收要求「seed 与常量不得
 * 各写一份」）。币种只在入站收紧（v1 仅 CNY）；读侧不收紧：历史数据里万一出现
 * 别的币种，应当读得出来并在页面上显示，而不是整条响应 500。
 */

/**
 * 产品生命周期（§5 状态机）。三态封闭：迁移里的 `CHECK`、这里、状态机表必须同源。
 *
 * `retired` 是终态，不允许回到 `draft`/`active`。这条规则由 `update_product` 判定
 * （产品走 PATCH 而不是 transition 端点），契约层只负责让非法取值在入站就 400。
 */
export const OPS_PRODUCT_LIFECYCLE_STATUSES = ['draft', 'active', 'retired'] as const;
export const opsProductLifecycleStatusSchema = z.enum(OPS_PRODUCT_LIFECYCLE_STATUSES);
export type OpsProductLifecycleStatus = z.infer<typeof opsProductLifecycleStatusSchema>;

export const OPS_BILLING_TYPES = ['periodic', 'fixed_term', 'one_time'] as const;
export const opsBillingTypeSchema = z.enum(OPS_BILLING_TYPES);
export type OpsBillingType = z.infer<typeof opsBillingTypeSchema>;

/**
 * 套餐状态（**推断**：契约 §3.2 没有枚举 `packages.status`，§5.3 只给了
 * `activate`/`retire` 两个动作；三态与产品对齐）。与产品一样是封闭集合。
 */
export const OPS_PACKAGE_STATUSES = ['draft', 'active', 'retired'] as const;
export const opsPackageStatusSchema = z.enum(OPS_PACKAGE_STATUSES);
export type OpsPackageStatus = z.infer<typeof opsPackageStatusSchema>;

/**
 * 套餐状态机动作（§5）。只有两条边：`draft → active`、`draft|active → retired`。
 *
 * 与客户域同理用 `z.enum`：动作是封闭集合，多一个就等于多一条库里不存在的边。
 * 用枚举在入站就 400，不必下传到一个只能靠 `invalid_transition` 兜底的 RPC。
 */
export const OPS_PACKAGE_TRANSITION_ACTIONS = ['activate', 'retire'] as const;
export const opsPackageTransitionActionSchema = z.enum(OPS_PACKAGE_TRANSITION_ACTIONS);
export type OpsPackageTransitionAction = z.infer<typeof opsPackageTransitionActionSchema>;

/**
 * 功能键的取值类型。`boolean` 只管开关，`quota` 带额度（`quotaValue`），
 * `term` 带期限（`termMonths`）——三者在权益表里是同一行，靠这一列决定读哪一栏。
 */
export const OPS_FEATURE_VALUE_TYPES = ['boolean', 'quota', 'term'] as const;
export const opsFeatureValueTypeSchema = z.enum(OPS_FEATURE_VALUE_TYPES);
export type OpsFeatureValueType = z.infer<typeof opsFeatureValueTypeSchema>;

/**
 * 权益的适用范围。`both` 是显式取值而不是「两个字段都空」：私有化与 SaaS 的
 * 权益集合经常不一致，用空值表达「都适用」会让「没配」与「都适用」分不开。
 */
export const OPS_FEATURE_APPLIES_TO = ['saas_tenant', 'private_instance', 'both'] as const;
export const opsFeatureAppliesToSchema = z.enum(OPS_FEATURE_APPLIES_TO);
export type OpsFeatureAppliesTo = z.infer<typeof opsFeatureAppliesToSchema>;

/** 产品上的一种销售方式及其开关。列表与详情共用。 */
export const opsProductSalesModeSchema = z.object({
  mode: opsSalesModeSchema,
  isEnabled: z.boolean(),
});
export type OpsProductSalesMode = z.infer<typeof opsProductSalesModeSchema>;

/** 产品对象 —— 创建、更新响应共用。 */
export const opsProductSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  lifecycleStatus: opsProductLifecycleStatusSchema,
  /** 按 `mode` 升序，保证同一行多次读取顺序稳定（见形状函数 §2）。 */
  salesModes: z.array(opsProductSalesModeSchema),
  /** 乐观锁。PATCH 要回传它。 */
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsProduct = z.infer<typeof opsProductSchema>;

/**
 * 产品列表项。
 *
 * 比产品对象少 `description`/`createdAt`/`updatedAt`、多 `packageCount`：
 * 列表页要显示「这个产品下有几个套餐」，而描述与时间戳在列表里不展示。
 * `packageCount` 只能由 RPC 聚合——这也是本域读侧不让前端直读表的理由
 * （§1 迁移头注释：直读拿不到聚合，会得到字段缺失的第二种形状）。
 */
export const opsProductListItemSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  lifecycleStatus: opsProductLifecycleStatusSchema,
  salesModes: z.array(opsProductSalesModeSchema),
  packageCount: z.number().int().min(0),
  version: z.number().int().positive(),
});
export type OpsProductListItem = z.infer<typeof opsProductListItemSchema>;

/** 套餐详情里嵌的产品摘要。只带能显示的三项，不做完整产品对象。 */
export const opsPackageProductSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
});
export type OpsPackageProduct = z.infer<typeof opsPackageProductSchema>;

/**
 * 套餐对象。
 *
 * `listPrice` 是**当前价**（`create_package_price_version` 成功后同步刷新），
 * 不是「建套餐时定的价」。历史价在价格版本里，已生效合同用 `unit_price` 快照。
 */
export const opsPackageSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  product: opsPackageProductSchema,
  internalName: z.string().nullable(),
  customerName: z.string().nullable(),
  salesMode: opsSalesModeSchema,
  billingType: opsBillingTypeSchema,
  defaultTermMonths: z.number().int().positive().nullable(),
  currency: z.string().min(1),
  listPrice: z.number().min(0),
  status: opsPackageStatusSchema,
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  currentPriceVersionId: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsPackage = z.infer<typeof opsPackageSchema>;

/**
 * 套餐列表项。
 *
 * 用 `price`（当前版本的价）而不是 `listPrice`：契约 §5.3 的列表字段就叫 `price`，
 * 与详情/价格版本同名同义。两个名字指同一列会让人以为是两个价——那是最容易
 * 在页面上并排显示、然后显示成不一致的一处。
 */
export const opsPackageListItemSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  internalName: z.string().nullable(),
  customerName: z.string().nullable(),
  salesMode: opsSalesModeSchema,
  billingType: opsBillingTypeSchema,
  price: z.number().min(0),
  currency: z.string().min(1),
  status: opsPackageStatusSchema,
  effectiveFrom: z.string().nullable(),
  version: z.number().int().positive(),
});
export type OpsPackageListItem = z.infer<typeof opsPackageListItemSchema>;

/**
 * 价格版本。
 *
 * `price` 同样是 number；`termMonths` 可空（一次性买断没有期限）。
 * 这张表**只 INSERT**：没有更新/删除端点，涨价靠新版本。
 */
export const opsPriceVersionSchema = z.object({
  id: z.string().min(1),
  packageId: z.string().min(1),
  versionNo: z.number().int().positive(),
  price: z.number().min(0),
  currency: z.string().min(1),
  termMonths: z.number().int().positive().nullable(),
  effectiveFrom: z.string().min(1),
  createdBy: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type OpsPriceVersion = z.infer<typeof opsPriceVersionSchema>;

/**
 * 价格版本列表项。
 *
 * 没有 `id`：契约的列表只给业务键 `versionNo`，而写入口（新建版本）不需要选
 * 具体版本行。多给一个 `id` 会让前端以为可以按 id 操作它——本轮没有这条端点。
 */
export const opsPriceVersionListItemSchema = z.object({
  versionNo: z.number().int().positive(),
  price: z.number().min(0),
  currency: z.string().min(1),
  termMonths: z.number().int().positive().nullable(),
  effectiveFrom: z.string().min(1),
  createdBy: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type OpsPriceVersionListItem = z.infer<typeof opsPriceVersionListItemSchema>;

/** 套餐上的一条权益。`displayName` 来自功能键定义（同一键在所有套餐里显示一致）。 */
export const opsPackageFeatureSchema = z.object({
  featureKey: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  quotaValue: z.number().nullable(),
  termMonths: z.number().int().positive().nullable(),
  appliesTo: opsFeatureAppliesToSchema,
});
export type OpsPackageFeature = z.infer<typeof opsPackageFeatureSchema>;

/** 功能键定义。 */
export const opsFeatureSchema = z.object({
  featureKey: z.string().min(1),
  displayName: z.string().min(1),
  valueType: opsFeatureValueTypeSchema,
  unit: z.string().nullable(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsFeature = z.infer<typeof opsFeatureSchema>;

/** 功能键列表项。`usageCount` = 被多少个套餐引用，只能由 RPC 聚合。 */
export const opsFeatureListItemSchema = z.object({
  featureKey: z.string().min(1),
  displayName: z.string().min(1),
  valueType: opsFeatureValueTypeSchema,
  unit: z.string().nullable(),
  isActive: z.boolean(),
  usageCount: z.number().int().min(0),
});
export type OpsFeatureListItem = z.infer<typeof opsFeatureListItemSchema>;

/**
 * 状态迁移的影响计数。
 *
 * 本轮只有合同域会引用产品/套餐，而合同表还没落地（T-06）。形状先按「唯一已知
 * 计数」定成 `draftContracts`：等合同域接进来时，这里才需要加字段——现在编
 * `entitlements`/`deployments` 会是拿客户域的 impact 形状去猜一个还没写的域。
 */
export const opsCatalogImpactSchema = z.object({
  draftContracts: z.number().int().min(0),
});
export type OpsCatalogImpact = z.infer<typeof opsCatalogImpactSchema>;

/**
 * 入站：产品上的一种销售方式。
 *
 * 用 `strictObject`：未知字段一律 400。`isEnabled` 默认 `false`，与表默认值同口径
 * ——前端传 `{mode:'saas'}` 的意思是「这条记录存在」，不是「打开它」。
 */
export const opsProductSalesModeInputSchema = z.strictObject({
  mode: opsSalesModeSchema,
  isEnabled: z.boolean().default(false),
});
export type OpsProductSalesModeInput = z.infer<typeof opsProductSalesModeInputSchema>;

/**
 * 产品创建。
 *
 * `salesModes` 必填但允许空数组：空数组在库里返回 `sales_modes_required`
 * （§4 约定「产品至少要有一条销售方式记录才可销售」），由库做唯一判定，
 * 契约层不写第二份规则。
 *
 * `code`/`name` 的长度上限契约没写，按同域保守值取；已记入交付报告。
 */
export const opsProductCreateRequestSchema = z.strictObject({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  salesModes: z.array(opsProductSalesModeInputSchema),
});
export type OpsProductCreateRequest = z.infer<typeof opsProductCreateRequestSchema>;

/**
 * 产品更新（PATCH）。
 *
 * 四件事刻意不做：
 * - 不收 `code`：编码是外部引用键，改了等于换一个产品；
 * - 不收 `version` 以外的状态机字段：`lifecycleStatus` 走同一个 PATCH，
 *   但 `retired → draft/active` 由库返回 `invalid_transition`；
 * - 不收 `reason` 以外的审计字段；
 * - 不收未知键——`strictObject` 让「顺手多传一个字段」变成 400。
 *
 * `description: ''` 表示清空（§4 约定「空串表示清空」）；不传表示不改。
 */
export const opsProductUpdateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  lifecycleStatus: opsProductLifecycleStatusSchema.optional(),
  /** 不传 = 不动；`[]` = 全删（库返回 `sales_modes_required`）。 */
  salesModes: z.array(opsProductSalesModeInputSchema).optional(),
  /**
   * 审计理由。契约 §5.3 的请求体没写这一栏，但 RPC 签名有 `p_reason`（§4），
   * 这里按签名收成可选、缺省传 `null`；不擅自把它变成必填（那会拒掉契约允许的请求）。
   */
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});
export type OpsProductUpdateRequest = z.infer<typeof opsProductUpdateRequestSchema>;

/** 产品列表查询。枚举值非法 → 400，不静默忽略（§7）。 */
export const opsProductListQuerySchema = z.object({
  keyword: z.string().trim().max(64).optional(),
  lifecycleStatus: opsProductLifecycleStatusSchema.optional(),
  salesMode: opsSalesModeSchema.optional(),
});
export type OpsProductListQuery = z.infer<typeof opsProductListQuerySchema>;

/**
 * 入站：套餐上的一条权益。
 *
 * `appliesTo` 必填（表里是 NOT NULL）。`enabled` 默认 `true`，与表默认值一致；
 * 让「不写」有一个确定值，而不是把 `null` 下传后在 INSERT 时撞 NOT NULL。
 */
export const opsPackageFeatureInputSchema = z.strictObject({
  featureKey: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  quotaValue: z.number().min(0).nullable().optional(),
  termMonths: z.number().int().positive().nullable().optional(),
  appliesTo: opsFeatureAppliesToSchema,
});
export type OpsPackageFeatureInput = z.infer<typeof opsPackageFeatureInputSchema>;

/**
 * 套餐创建。创建时同时写首条价格版本（`versionNo = 1`），所以这里带价格字段。
 *
 * `listPrice` 是 JSON number；`currency` 缺省由库里默认 `CNY` 兜底（传 `null`）。
 */
export const opsPackageCreateRequestSchema = z.strictObject({
  productId: z.uuid(),
  internalName: z.string().trim().max(120).optional(),
  customerName: z.string().trim().max(200).optional(),
  salesMode: opsSalesModeSchema,
  billingType: opsBillingTypeSchema,
  defaultTermMonths: z.number().int().positive().max(120).optional(),
  /** 只接受 `OPS_SUPPORTED_CURRENCIES`（v1 仅 CNY）；不传由库里默认值兜底。 */
  currency: opsSupportedCurrencySchema.optional(),
  listPrice: z.number().min(0),
  /** 不传 = 空权益；`[]` 同义。 */
  features: z.array(opsPackageFeatureInputSchema).optional(),
  effectiveFrom: z.iso.date().optional(),
});
export type OpsPackageCreateRequest = z.infer<typeof opsPackageCreateRequestSchema>;

/**
 * 套餐更新（PATCH）。
 *
 * 只收「能改的三项」：`salesMode`/`billingType`/`productId` 不在内——换销售方式
 * 等于换一个套餐（价格口径与权益范围都变），换产品更是。状态走 transition。
 *
 * 也**不收 `reason`**：`ops.update_package` 的签名里没有 `p_reason`（只有
 * `update_product` 与 `transition_package` 有）。收下来再丢掉，会让前端以为
 * 这条审计带理由，而库里那一行永远是空的。
 */
export const opsPackageUpdateRequestSchema = z.strictObject({
  internalName: z.string().trim().max(120).optional(),
  customerName: z.string().trim().max(200).optional(),
  /** `NULL` = 不动；`[]` = 清空全部权益。**整体替换**，不是合并（§4 约定）。 */
  features: z.array(opsPackageFeatureInputSchema).optional(),
  version: z.number().int().positive(),
});
export type OpsPackageUpdateRequest = z.infer<typeof opsPackageUpdateRequestSchema>;

/** 套餐列表查询。 */
export const opsPackageListQuerySchema = z.object({
  productId: z.uuid().optional(),
  salesMode: opsSalesModeSchema.optional(),
  status: opsPackageStatusSchema.optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type OpsPackageListQuery = z.infer<typeof opsPackageListQuerySchema>;

/**
 * 新建价格版本。
 *
 * 没有 `versionNo`：号由库在 `FOR UPDATE` 保护下取 `max(version_no)+1`（§4）。
 * 让调用方给号，两个人同时点「调价」就会撞同一个号。
 */
export const opsPackagePriceVersionCreateRequestSchema = z.strictObject({
  price: z.number().min(0),
  currency: opsSupportedCurrencySchema.optional(),
  termMonths: z.number().int().positive().max(120).optional(),
  effectiveFrom: z.iso.date(),
});
export type OpsPackagePriceVersionCreateRequest = z.infer<
  typeof opsPackagePriceVersionCreateRequestSchema
>;

/**
 * 套餐状态迁移。
 *
 * `reason` 必填：与客户域 transition 同理，理由时有时无会让前端得先查动作表。
 */
export const opsPackageTransitionRequestSchema = z.strictObject({
  action: opsPackageTransitionActionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
});
export type OpsPackageTransitionRequest = z.infer<typeof opsPackageTransitionRequestSchema>;

/** 功能键创建。`featureKey` 是业务主键，创建后不可改（PATCH 里没有这一栏）。 */
export const opsFeatureCreateRequestSchema = z.strictObject({
  featureKey: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(120),
  valueType: opsFeatureValueTypeSchema,
  unit: z.string().trim().max(32).optional(),
  description: z.string().trim().max(2000).optional(),
});
export type OpsFeatureCreateRequest = z.infer<typeof opsFeatureCreateRequestSchema>;

/**
 * 功能键更新（PATCH）。
 *
 * **`featureKey` 不在白名单里**，而且这里是 `strictObject`：前端若把整个对象回传
 * （含 `featureKey`），请求是 400 而不是 409——契约 §6/§7 要求「试图改主键」
 * 属于入站非法字段，不是「并发冲突」。用宽松对象收下来再忽略，会把一次前端
 * 误用变成「保存成功但没改」，用户以为改了名字。
 *
 * 没有 `version`：`feature_definitions` 表没有 version 列（§1）。
 */
export const opsFeatureUpdateRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120).optional(),
  unit: z.string().trim().max(32).optional(),
  description: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
});
export type OpsFeatureUpdateRequest = z.infer<typeof opsFeatureUpdateRequestSchema>;

/**
 * 功能键列表查询。
 *
 * `isActive` 只认 `'true'`/`'false'` 两个字面量，不用 `z.coerce.boolean()`：
 * 后者把字符串 `'false'` 转成 `true`（非空字符串即真），于是「只看停用的」
 * 会返回全部启用的键——一个看起来完全正常的筛选参数。
 */
export const opsFeatureListQuerySchema = z.object({
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  keyword: z.string().trim().max(64).optional(),
});
export type OpsFeatureListQuery = z.infer<typeof opsFeatureListQuerySchema>;

/** 三个列表响应共用的外壳：本轮列表不分页（RPC 签名没有 page/pageSize）。 */
export const opsProductListResponseSchema = z.object({
  items: z.array(opsProductListItemSchema),
});
export type OpsProductListResponse = z.infer<typeof opsProductListResponseSchema>;

export const opsProductResponseSchema = z.object({ product: opsProductSchema });
export type OpsProductResponse = z.infer<typeof opsProductResponseSchema>;

export const opsPackageListResponseSchema = z.object({
  items: z.array(opsPackageListItemSchema),
});
export type OpsPackageListResponse = z.infer<typeof opsPackageListResponseSchema>;

/** 创建套餐会同时回填首条价格版本（`versionNo = 1`），两个对象一起回。 */
export const opsPackageCreateResponseSchema = z.object({
  package: opsPackageSchema,
  priceVersion: opsPriceVersionSchema,
});
export type OpsPackageCreateResponse = z.infer<typeof opsPackageCreateResponseSchema>;

export const opsPackageDetailResponseSchema = z.object({
  package: opsPackageSchema,
  features: z.array(opsPackageFeatureSchema),
  /** 未定价的套餐是合法的（`draft` 阶段），所以这一栏可空。 */
  currentPriceVersion: opsPriceVersionSchema.nullable(),
});
export type OpsPackageDetailResponse = z.infer<typeof opsPackageDetailResponseSchema>;

export const opsPackageUpdateResponseSchema = z.object({ package: opsPackageSchema });
export type OpsPackageUpdateResponse = z.infer<typeof opsPackageUpdateResponseSchema>;

export const opsPackagePriceVersionCreateResponseSchema = z.object({
  priceVersion: opsPriceVersionSchema,
  /** 返回套餐：新版本会把 `listPrice`/`currency` 同步改掉，前端要就地更新行。 */
  package: opsPackageSchema,
});
export type OpsPackagePriceVersionCreateResponse = z.infer<
  typeof opsPackagePriceVersionCreateResponseSchema
>;

export const opsPriceVersionListResponseSchema = z.object({
  items: z.array(opsPriceVersionListItemSchema),
});
export type OpsPriceVersionListResponse = z.infer<typeof opsPriceVersionListResponseSchema>;

/**
 * 迁移结果。
 *
 * 只回状态与版本：前端拿到它就能更新行内标签与乐观锁，不必重拉详情。
 * `impact` 与 409 `OBJECT_REFERENCED` 的 `details.impact` 同形。
 */
export const opsPackageTransitionResponseSchema = z.object({
  package: z.object({
    status: opsPackageStatusSchema,
    version: z.number().int().positive(),
  }),
  impact: opsCatalogImpactSchema,
});
export type OpsPackageTransitionResponse = z.infer<typeof opsPackageTransitionResponseSchema>;

export const opsFeatureListResponseSchema = z.object({
  items: z.array(opsFeatureListItemSchema),
});
export type OpsFeatureListResponse = z.infer<typeof opsFeatureListResponseSchema>;

export const opsFeatureResponseSchema = z.object({ feature: opsFeatureSchema });
export type OpsFeatureResponse = z.infer<typeof opsFeatureResponseSchema>;
