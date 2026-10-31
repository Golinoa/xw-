import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';
import { opsBillingTypeSchema, opsFeatureAppliesToSchema } from './catalog';
import { opsSalesModeSchema, opsSupportedCurrencySchema } from './meta';

/**
 * 运营端合同（契约 §3.3 / §5.4 的**十四个**端点）。
 *
 * 十四个，不是十三个：`catalog` 是 13、客户是 11，本域多出来的那一个是
 * `GET /contract-attachments/{id}/access`，它与 `complete` 一起挂在
 * `/contract-attachments/` 下、**不在** `/contracts/{id}/` 前缀里。数错一次
 * 的表现不是类型错误，是其中两条端点 404——类型系统对路径字符串里的段名没有
 * 任何约束，所以清单（`OPS_ROUTES`）与挂载（`index.ts`）必须各自照 §5.4 抄一遍。
 *
 * 金额一律是 JSON number（库里 `numeric(14,2)` 经 `jsonb_build_object` 出来就是
 * 数字，不是字符串）。**入站不收 `amount` / `totalAmount`**：条目金额
 * `amount = quantity * unit_price`、合同总额 `total_amount = sum(amount)` 一律由
 * SQL 重算（§4），CHECK 约束是第二道闸。所以这两个键连可选字段都不是——
 * 它们根本不出现在请求 schema 里，带上了会被 `strictObject` 判 400。
 */

/**
 * 合同状态（契约 §3.3 状态机）。六态封闭：迁移里的 `CHECK`、这里、状态机表同源。
 *
 * `expired` / `terminated` 是终态，任何动作都返回 `invalid_transition`（§2），
 * 但那是库的判定；这里只保证「库不存在的状态值」进不了请求。
 */
export const OPS_CONTRACT_STATUSES = [
  'draft',
  'reviewing',
  'signed',
  'active',
  'expired',
  'terminated',
] as const;
export const opsContractStatusSchema = z.enum(OPS_CONTRACT_STATUSES);
export type OpsContractStatus = z.infer<typeof opsContractStatusSchema>;

/**
 * 状态机动作（§2 的七条边拆出来的六个动作）。
 *
 * 用 `z.enum` 而不是开放字符串：这六个动作是状态机表的全部迁移边，多一个动作
 * 就等于多一条库里不存在的边，而 `invalid_transition` 只能在下传之后才发现。
 * 注意 `expire` 覆盖 `active|signed` 两条边，`terminate` 只有 `active` 一条。
 */
export const OPS_CONTRACT_TRANSITION_ACTIONS = [
  'submit',
  'withdraw',
  'sign',
  'activate',
  'terminate',
  'expire',
] as const;
export const opsContractTransitionActionSchema = z.enum(OPS_CONTRACT_TRANSITION_ACTIONS);
export type OpsContractTransitionAction = z.infer<typeof opsContractTransitionActionSchema>;

/**
 * 变更单状态（**推断**：契约 §3.3 没有把 `contract_amendments.status` 的取值写全，
 * 本文件按 §1 迁移里的 `CHECK` 取五态）。
 */
export const OPS_CONTRACT_AMENDMENT_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'applied',
] as const;
export const opsContractAmendmentStatusSchema = z.enum(OPS_CONTRACT_AMENDMENT_STATUSES);
export type OpsContractAmendmentStatus = z.infer<typeof opsContractAmendmentStatusSchema>;

/**
 * 变更单动作（**推断**：§5.4 只给了端点，没有枚举动作）。
 *
 * 四条边：`submit`（draft → pending_approval）、`approve` / `reject`
 * （pending_approval → approved / rejected）、`apply`（approved → applied）。
 * 与合同主体一样用 `z.enum`：动作集合是封闭的，多一个 400 比下传后得到
 * `invalid_transition` 更早、更好定位。
 */
export const OPS_CONTRACT_AMENDMENT_ACTIONS = ['submit', 'approve', 'reject', 'apply'] as const;
export const opsContractAmendmentActionSchema = z.enum(OPS_CONTRACT_AMENDMENT_ACTIONS);
export type OpsContractAmendmentAction = z.infer<typeof opsContractAmendmentActionSchema>;

/**
 * 附件状态。契约 §3.3 没有这一列，§1 按 §5.4 的两步（`POST attachments` 返回
 * `pending`、`complete` 返回 `stored`）**推断**补出。
 */
export const OPS_CONTRACT_ATTACHMENT_STATUSES = ['pending', 'stored'] as const;
export const opsContractAttachmentStatusSchema = z.enum(OPS_CONTRACT_ATTACHMENT_STATUSES);
export type OpsContractAttachmentStatus = z.infer<typeof opsContractAttachmentStatusSchema>;

/**
 * 附件类型白名单（§8，**推断**：契约只写「类型超限」，没给白名单）。
 *
 * 导出来给前端的文件选择器用（`accept="..."`），**不在入站 schema 里校验**：
 * 白名单的真源是迁移里的约束与 RPC 的判定，服务端再抄一份，就会出现
 * 「前端按这份过滤、服务端按那份拒绝」的两套口径。入站只校验形状，
 * `attachment_type_rejected` 由信封映射成 400（§7）。
 */
export const OPS_CONTRACT_ATTACHMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type OpsContractAttachmentContentType =
  (typeof OPS_CONTRACT_ATTACHMENT_CONTENT_TYPES)[number];

/** 附件大小上限（§8）：25 MiB。与迁移的 `CHECK (byte_size <= 26214400)` 同值。 */
export const OPS_CONTRACT_ATTACHMENT_MAX_BYTES = 26_214_400;

/**
 * 合同责任人。与客户域的 owner 同形同理由（`displayName` 可空是因为 D-02 之前
 * 邀请的账号没有显示名，回落显示邮箱）。
 */
export const opsContractOwnerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  email: z.string().min(1),
});
export type OpsContractOwner = z.infer<typeof opsContractOwnerSchema>;

/**
 * 合同上嵌的客户摘要。
 *
 * 只有三项：合同页要显示「这是谁的合同」，而客户的全量信息在客户域端点上。
 * 把 `status` / `owner` 一起塞进来会让同一份客户数据在两条响应里各有一份快照，
 * 两边刷新时机不同时，页面会把「已终止的客户」显示成「生效中」。
 */
export const opsContractCustomerSummarySchema = z.object({
  id: z.string().min(1),
  customerNo: z.string().min(1),
  name: z.string().min(1),
});
export type OpsContractCustomerSummary = z.infer<typeof opsContractCustomerSummarySchema>;

/**
 * 合同条目。
 *
 * `amount` 是库里算出来的（`quantity * unit_price`），`unitPrice` 可能与套餐当前价
 * 不同（历史价快照），`itemNameSnapshot` 是建行时定格的套餐名——三者都不是
 * 「当前套餐」的投影，改套餐不会回写这里。
 */
export const opsContractItemSchema = z.object({
  id: z.string().min(1),
  lineNo: z.number().int().positive(),
  productId: z.string().nullable(),
  packageId: z.string().nullable(),
  priceVersionId: z.string().nullable(),
  salesMode: opsSalesModeSchema,
  billingType: opsBillingTypeSchema,
  quantity: z.number().int().positive(),
  unitPrice: z.number().min(0),
  amount: z.number().min(0),
  termMonths: z.number().int().positive().nullable(),
  itemNameSnapshot: z.string().min(1),
});
export type OpsContractItem = z.infer<typeof opsContractItemSchema>;

/**
 * 合同对象 —— 详情、创建响应、更新响应、列表项共用。
 *
 * `currentVersionNo` 从 0 起：`draft` 阶段还没有任何 `contract_versions` 行，
 * 迁移刻意把默认值定成 0 而不是契约原文的 1（§1 有理由）。所以这里用
 * `min(0)` 而不是 `positive()`——写成 `positive()` 会让每一张草稿合同在出站
 * 校验时 500。
 *
 * `renewedFromContractId` 是「上一份合同」的指针；续约建**新**合同（§4），
 * 原合同不动，所以这个键只在续约产物上非空。
 */
export const opsContractSchema = z.object({
  id: z.string().min(1),
  contractNo: z.string().min(1),
  customerId: z.string().min(1),
  customer: opsContractCustomerSummarySchema,
  salesOwner: opsContractOwnerSchema.nullable(),
  salesMode: opsSalesModeSchema,
  currency: z.string().min(1),
  totalAmount: z.number().min(0),
  paymentTerms: z.string().nullable(),
  taxNote: z.string().nullable(),
  businessNote: z.string().nullable(),
  status: opsContractStatusSchema,
  signedOn: z.string().nullable(),
  effectiveOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  renewedFromContractId: z.string().nullable(),
  /** 进入当前状态的原因（`terminate` 的 reason 落在这里）。 */
  statusReason: z.string().nullable(),
  /** 已生成的版本快照数；0 = 尚未 activate。 */
  currentVersionNo: z.number().int().min(0),
  /** 乐观锁。PATCH 与 transition 都要回传它（`version_mismatch` → 409）。 */
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsContract = z.infer<typeof opsContractSchema>;

/**
 * 列表项 = 完整合同对象。
 *
 * 与 catalog 的「列表项比详情少几个字段」不同，这里刻意不做裁剪：合同的列表行
 * 是编辑抽屉与「变更状态」弹窗的填充源，少一个 `version` 就必须再发一次详情请求，
 * 而少 `paymentTerms` 会让一次「只改到期日」的保存把付款条件抹成空。
 * 代价是列表响应更大——这已记入交付报告，等契约文档确认列表字段后再收窄。
 */
export const opsContractListItemSchema = opsContractSchema;
export type OpsContractListItem = z.infer<typeof opsContractListItemSchema>;

/**
 * 合同版本快照。
 *
 * `snapshot` 的形状由 §4 写死（`{contract, items, entitlementLines}`），但这里
 * **不按那个形状建模**：快照是「当时那一刻的全字段转储」，随合同字段增删而变，
 * 在这里再写一份 schema 就等于把同一份合同定义写两遍，且历史快照永远匹配不上
 * 新版本的定义（旧快照里没有新字段）。所以按「任意键值对」收，具体字段由读的人
 * 自己按版本号解释。`entitlementLines` 在本轮永远是 `[]`（不是 null）。
 */
export const opsContractVersionSchema = z.object({
  id: z.string().min(1),
  versionNo: z.number().int().positive(),
  snapshot: z.record(z.string(), z.unknown()),
  changeReason: z.string().min(1),
  createdBy: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type OpsContractVersion = z.infer<typeof opsContractVersionSchema>;

/**
 * 变更单。
 *
 * `beforeSummary` / `afterSummary` 同样是「当时那一刻的转储」，理由同版本快照。
 * `approvedBy` 与 `requestedBy` 的职责分离由库的 `CHECK` 保证，契约层不重复实现
 * ——重复实现只会在两边不一致时制造一条查不出的差异。
 */
export const opsContractAmendmentSchema = z.object({
  id: z.string().min(1),
  contractId: z.string().min(1),
  amendmentNo: z.number().int().positive(),
  reason: z.string().min(1),
  beforeSummary: z.record(z.string(), z.unknown()),
  afterSummary: z.record(z.string(), z.unknown()),
  status: opsContractAmendmentStatusSchema,
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  appliedVersionNo: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsContractAmendment = z.infer<typeof opsContractAmendmentSchema>;

/**
 * 附件。
 *
 * `storagePath` 由库按 `contracts/{contractId}/{attachmentId}/{fileName}` 生成（§8），
 * 出站时**照实回传**：下载 URL 的拼装用到它，而换一个拼法就会与库里存的对象路径
 * 不一致。
 */
export const opsContractAttachmentSchema = z.object({
  id: z.string().min(1),
  contractId: z.string().min(1),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().positive(),
  storagePath: z.string().min(1),
  checksumSha256: z.string().nullable(),
  status: opsContractAttachmentStatusSchema,
  accessScope: z.string().min(1),
  uploadedBy: z.string().nullable(),
  uploadedAt: z.string().min(1),
});
export type OpsContractAttachment = z.infer<typeof opsContractAttachmentSchema>;

/**
 * 合同在各未落地域（应收 / 权益 / 租户命令）里的引用计数。
 *
 * 三个键与库函数 `ops.contract_reference_counts` 的返回一一对应（§5）；本轮三张表
 * 都不存在，所以三个值恒为 0。`terminate` 时任一 > 0 会被判 `referenced`。
 */
export const opsContractImpactSchema = z.object({
  receivables: z.number().int().min(0),
  entitlements: z.number().int().min(0),
  tenantCommands: z.number().int().min(0),
});
export type OpsContractImpact = z.infer<typeof opsContractImpactSchema>;

/**
 * 应收摘要。
 *
 * 形状**本轮不定**：`ops.receivables` 属 T-07，字段还没定稿。§5 只写死了
 * `receivables[]` 这类列表在表不存在时返回 `[]`，没有写摘要的形状——在这里编一组
 * `{totalAmount, paidAmount, …}` 等于让一份还没写的迁移去适配一个先写下的形状。
 * 所以按客户域 `overview` 的既定做法收成「任意键值对」，并允许 `null`
 * （表不存在时就是「没有摘要」，与「摘要全为 0」不是同一件事）。
 */
export const opsContractReceivableSummarySchema = z.record(z.string(), z.unknown()).nullable();
export type OpsContractReceivableSummary = z.infer<typeof opsContractReceivableSummarySchema>;

/** 权益预览里的一行（§6：按 `featureKey` 合并后的结果）。 */
export const opsContractEntitlementFeatureSchema = z.object({
  featureKey: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  quota: z.number().nullable(),
  termMonths: z.number().int().positive().nullable(),
  appliesTo: opsFeatureAppliesToSchema,
});
export type OpsContractEntitlementFeature = z.infer<typeof opsContractEntitlementFeatureSchema>;

/**
 * 权益预览的告警（§6：本轮只有一种）。
 *
 * `code` 刻意是开放字符串而不是 `z.literal('PACKAGE_NOT_ACTIVE')`：这是**出站**
 * 校验，字面量会把「后端将来多一种 warning」变成整条响应 503——一个新增提示语
 * 不该让权益页整页打不开。词表由 §6 维护，本轮只有 `PACKAGE_NOT_ACTIVE` 一个，
 * 单测里断言的就是它。
 */
export const opsContractEntitlementWarningSchema = z.object({
  code: z.string().min(1),
  packageId: z.string().min(1),
});
export type OpsContractEntitlementWarning = z.infer<typeof opsContractEntitlementWarningSchema>;

/**
 * 入站：合同条目。
 *
 * 只收五项引用与两项数值，**没有 `amount`**（§4：金额由 SQL 重算）、也没有
 * `lineNo`（行号由库按数组顺序生成，让调用方给号会出现重号）与
 * `itemNameSnapshot`（建行时定格，不由前端决定）。
 *
 * `unitPrice` 可选：给了 `priceVersionId` 但没给价时，服务端读
 * `ops.package_price_versions.price` 填入；两者都给且不一致 → `price_mismatch`（400）。
 */
export const opsContractItemInputSchema = z
  .strictObject({
    productId: z.uuid().optional(),
    packageId: z.uuid().optional(),
    priceVersionId: z.uuid().optional(),
    /** 不传 = 1（表默认值），不是「让服务端猜」。 */
    quantity: z.number().int().positive().max(100_000).optional(),
    unitPrice: z.number().min(0).optional(),
    termMonths: z.number().int().positive().max(120).optional(),
  })
  .refine(
    (item) =>
      item.productId !== undefined ||
      item.packageId !== undefined ||
      item.priceVersionId !== undefined,
    {
      // 三个引用全空的条目在库里是合法行（三列都可空），但它在页面上是一行没有名字、
      // 没有价格来源的空条目——那只能是前端拼错了。这一条是**推断**，已记入交付报告。
      message: 'An item must reference a product, a package or a price version',
      path: ['packageId'],
    },
  );
export type OpsContractItemInput = z.infer<typeof opsContractItemInputSchema>;

/**
 * 合同创建。
 *
 * `items` 必填但允许空数组：空数组交给库判定（`submit` 时 `items_required`），
 * 缺键则是入站 400——「少传一个数组字段」通常是表单接错了，静默建一张空合同
 * 比拒绝更难被发现。
 *
 * 没有 `signedOn` / `effectiveOn`：RPC 签名里没有这两个参数，签署与生效日期走
 * `transition`（`sign` 要 `signedOn`、`activate` 要 `effectiveOn`）。在这里收下来
 * 再丢掉，会让前端以为建单时就能定生效日。
 */
export const opsContractCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  salesMode: opsSalesModeSchema,
  /** 只接受 `OPS_SUPPORTED_CURRENCIES`（v1 仅 CNY）；不传由库里默认值兜底。 */
  currency: opsSupportedCurrencySchema.optional(),
  paymentTerms: z.string().trim().max(500).optional(),
  taxNote: z.string().trim().max(1000).optional(),
  businessNote: z.string().trim().max(4000).optional(),
  items: z.array(opsContractItemInputSchema).max(200),
});
export type OpsContractCreateRequest = z.infer<typeof opsContractCreateRequestSchema>;

/**
 * 合同更新（PATCH）。
 *
 * 四件事刻意不做：
 * - 不收 `status`：状态只能走 `transition`，每条边都带守卫（条目数、客户资格、
 *   销售方式开关），PATCH 能改状态就等于给这些守卫开后门；
 * - 不收 `customerId` / `salesMode` / `currency`：换客户或换销售方式等于换一份合同；
 *   金额口径与权益范围都变，只能新建；
 * - 不收 `totalAmount` / `amount`：金额由库重算（§4）；
 * - 不收 `reason`：`ops.update_contract` 的签名里没有 `p_reason`（§3），
 *   收下来再丢掉会让前端以为这条审计带理由，而库里那一行永远是空的。
 *
 * 空串表示清空（与 catalog 同约定）；不传表示不改。
 * `expiresOn` 只影响尚未生效/生效中的合同，`draft|reviewing` 之外的合同整条 PATCH
 * 会被判 `contract_immutable`（§2）→ 409 `STATE_CONFLICT`。
 */
export const opsContractUpdateRequestSchema = z.strictObject({
  paymentTerms: z.string().trim().max(500).optional(),
  taxNote: z.string().trim().max(1000).optional(),
  businessNote: z.string().trim().max(4000).optional(),
  expiresOn: z.iso.date().optional(),
  /** 不传 = 不动条目；`[]` = 全删（库在 `submit` 时判 `items_required`）。 */
  items: z.array(opsContractItemInputSchema).max(200).optional(),
  /** 乐观锁。不匹配由库判定 `version_mismatch` → 409 `CONFLICT`。 */
  version: z.number().int().positive(),
});
export type OpsContractUpdateRequest = z.infer<typeof opsContractUpdateRequestSchema>;

/**
 * 状态迁移。
 *
 * `reason` 一视同仁地必填：§2 只对 `terminate` 标了「需 reason」，但审计词
 * `contract.transitioned` 的摘要必须带 `{from,to,reason}`（§9）——若理由时有时无，
 * 同一条筛选下拉里会出现「有理由的终止」与「没理由的签署」，前端还得先查动作表
 * 才知道要不要显示理由框。与客户域 / catalog 的 transition 保持同一口径。
 *
 * `confirmImpact` 只在 `terminate` 有意义（§2）。默认 `false`：终止是有副作用的
 * 操作，前端必须显式确认，而不是靠「没传就当同意」。
 */
export const opsContractTransitionRequestSchema = z.strictObject({
  action: opsContractTransitionActionSchema,
  reason: z.string().trim().min(1).max(500),
  /** `sign` 的守卫（§2）。 */
  signedOn: z.iso.date().optional(),
  /** `activate` 的守卫（§2）。 */
  effectiveOn: z.iso.date().optional(),
  confirmImpact: z.boolean().optional(),
  version: z.number().int().positive(),
});
export type OpsContractTransitionRequest = z.infer<typeof opsContractTransitionRequestSchema>;

/**
 * 变更单里「要改的合同头字段」。
 *
 * 与 `opsContractUpdateRequestSchema` 的白名单同源（只是不含 `version`：
 * 变更单的乐观锁在合同主体上，不在变更单上）。单独抽出来是因为它同时出现在
 * 「创建变更单」的 `header` 里，而空对象 `{}` 与「没传」必须能分开
 * （`p_header_provided`）——「这次不动头字段」与「这次把头字段改成空」是两件事。
 */
export const opsContractAmendmentHeaderInputSchema = z.strictObject({
  paymentTerms: z.string().trim().max(500).optional(),
  taxNote: z.string().trim().max(1000).optional(),
  businessNote: z.string().trim().max(4000).optional(),
  expiresOn: z.iso.date().optional(),
});
export type OpsContractAmendmentHeaderInput = z.infer<typeof opsContractAmendmentHeaderInputSchema>;

/** 创建变更单（201）。`header` / `items` 都可省略，省略即「这一部分不改」。 */
export const opsContractAmendmentCreateRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  header: opsContractAmendmentHeaderInputSchema.optional(),
  items: z.array(opsContractItemInputSchema).max(200).optional(),
});
export type OpsContractAmendmentCreateRequest = z.infer<
  typeof opsContractAmendmentCreateRequestSchema
>;

/**
 * 变更单状态迁移。
 *
 * `reason` 必填（同合同主体）：`reject` 必须说明为什么驳回，而 `approve` 的理由
 * 是给审计看的「谁凭什么批的」。`version` 是变更单自己的乐观锁——批的人可能
 * 拿到的是一份已经被改过的快照。
 */
export const opsContractAmendmentTransitionRequestSchema = z.strictObject({
  action: opsContractAmendmentActionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
});
export type OpsContractAmendmentTransitionRequest = z.infer<
  typeof opsContractAmendmentTransitionRequestSchema
>;

/**
 * 续约（201）。
 *
 * 建**新**合同（`draft`），不复用原合同行（§4）：原合同保持 `active`/`expired` 不动，
 * 新合同的 `renewedFromContractId` 指向它。所以响应里回的是新合同。
 *
 * `force` 越过 `renewal_not_due`（§7）：提前续约是合法诉求，但不该是默认行为。
 */
export const opsContractRenewalRequestSchema = z.strictObject({
  effectiveOn: z.iso.date(),
  expiresOn: z.iso.date(),
  /** 不传 = 沿用原合同条目（库负责复制）；`[]` = 新合同没有任何条目。 */
  items: z.array(opsContractItemInputSchema).max(200).optional(),
  reason: z.string().trim().min(1).max(500),
  force: z.boolean().optional(),
});
export type OpsContractRenewalRequest = z.infer<typeof opsContractRenewalRequestSchema>;

/**
 * 创建附件（201）——申请一次上传，不传文件字节。
 *
 * 只校验形状（大小为正、类型非空），**类型白名单与 25 MiB 上限不在这里判**：
 * 两者都由库判定并返回 `attachment_type_rejected` / `attachment_too_large`，
 * 契约层再抄一份就会出现「前端过了、服务端拒了」或反过来的两套口径（§8）。
 */
export const opsContractAttachmentCreateRequestSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(160),
  byteSize: z.number().int().positive(),
});
export type OpsContractAttachmentCreateRequest = z.infer<
  typeof opsContractAttachmentCreateRequestSchema
>;

/**
 * 确认上传完成。
 *
 * `checksumSha256` 可省略但给了就必须是 64 位小写/大写十六进制（§8：`complete`
 * 只校验格式与 `status='pending'`，**不**去 Storage 查对象——本地没有 Storage）。
 * 上界 64 而不是「任意长」：越长越可能在拼 SQL 参数时被截断，而截断后的校验和
 * 比对永远失败，表现为「上传成功但一直显示未完成」。
 */
export const opsContractAttachmentCompleteRequestSchema = z.strictObject({
  checksumSha256: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional(),
});
export type OpsContractAttachmentCompleteRequest = z.infer<
  typeof opsContractAttachmentCompleteRequestSchema
>;

/**
 * 合同列表查询。
 *
 * `status` 是**数组**，对应重复 query 参数（`?status=active&status=signed`）。
 * 读侧必须用 `context.req.queries('status')`，`req.query()` 只保留第一个值——
 * 这个坑的表现是「筛选看起来生效了，其实只筛了一半」。
 *
 * **没有 `sort` / `order`**：`ops.list_contracts` 的签名里没有这两个参数（§3）。
 * 在契约里加上它们，前端会得到一个「传了但被忽略」的排序器——顺序看起来对，
 * 只是因为库恰好按创建时间倒序返回。
 */
export const opsContractListQuerySchema = z.object({
  keyword: z.string().trim().max(120).optional(),
  customerId: z.uuid().optional(),
  status: z.array(opsContractStatusSchema).optional(),
  ownerOperatorId: z.uuid().optional(),
  /** 到期区间（含端点），用于「本月到期」这类筛选。 */
  expiresFrom: z.iso.date().optional(),
  expiresTo: z.iso.date().optional(),
  salesMode: opsSalesModeSchema.optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsContractListQuery = z.infer<typeof opsContractListQuerySchema>;

export const opsContractListResponseSchema = pagedResponseSchema(opsContractListItemSchema);
export type OpsContractListResponse = z.infer<typeof opsContractListResponseSchema>;

export const opsContractCreateResponseSchema = z.object({ contract: opsContractSchema });
export type OpsContractCreateResponse = z.infer<typeof opsContractCreateResponseSchema>;

/**
 * 合同详情。
 *
 * `receivables` / `subscriptions` / `licenses` 在本轮是恒空数组而不是 `null`
 * （§5：表不存在时返回 `[]`）——`null` 与「此刻没有」不可区分，而空数组是确定的。
 * `attachments` 本轮真查。
 */
export const opsContractDetailResponseSchema = z.object({
  contract: opsContractSchema,
  items: z.array(opsContractItemSchema),
  receivableSummary: opsContractReceivableSummarySchema,
  receivables: z.array(z.record(z.string(), z.unknown())),
  subscriptions: z.array(z.record(z.string(), z.unknown())),
  licenses: z.array(z.record(z.string(), z.unknown())),
  attachments: z.array(opsContractAttachmentSchema),
});
export type OpsContractDetailResponse = z.infer<typeof opsContractDetailResponseSchema>;

export const opsContractUpdateResponseSchema = z.object({ contract: opsContractSchema });
export type OpsContractUpdateResponse = z.infer<typeof opsContractUpdateResponseSchema>;

/**
 * 迁移结果。
 *
 * 只回状态与版本：前端拿到它就能更新行内标签与乐观锁，不必重拉详情。
 * `impact` 与 409 `OBJECT_REFERENCED` 的 `details.impact` 同形——终止前要让人
 * 看见「还有 2 笔应收挂着」，而这条信息在成功响应里也该能看到（`terminate`
 * 之前的一次空跑）。
 */
export const opsContractTransitionResponseSchema = z.object({
  contract: z.object({
    status: opsContractStatusSchema,
    version: z.number().int().positive(),
  }),
  impact: opsContractImpactSchema,
  /** `activate` 写了第 N 版快照时才有值（契约 §5.4 的 `createdVersionNo?`）。 */
  createdVersionNo: z.number().int().positive().optional(),
});
export type OpsContractTransitionResponse = z.infer<typeof opsContractTransitionResponseSchema>;

export const opsContractVersionListResponseSchema = z.object({
  items: z.array(opsContractVersionSchema),
});
export type OpsContractVersionListResponse = z.infer<typeof opsContractVersionListResponseSchema>;

export const opsContractAmendmentCreateResponseSchema = z.object({
  amendment: opsContractAmendmentSchema,
});
export type OpsContractAmendmentCreateResponse = z.infer<
  typeof opsContractAmendmentCreateResponseSchema
>;

/** 变更单迁移只回状态与版本，同 `transitionOpsContract` 的理由。 */
export const opsContractAmendmentTransitionResponseSchema = z.object({
  amendment: z.object({
    status: opsContractAmendmentStatusSchema,
    version: z.number().int().positive(),
  }),
  /** `apply` 写了新版本快照时才有值。 */
  createdVersionNo: z.number().int().positive().optional(),
});
export type OpsContractAmendmentTransitionResponse = z.infer<
  typeof opsContractAmendmentTransitionResponseSchema
>;

/** 续约回的是**新**合同（原合同不动）。 */
export const opsContractRenewalResponseSchema = z.object({ contract: opsContractSchema });
export type OpsContractRenewalResponse = z.infer<typeof opsContractRenewalResponseSchema>;

export const opsContractEntitlementPreviewResponseSchema = z.object({
  features: z.array(opsContractEntitlementFeatureSchema),
  warnings: z.array(opsContractEntitlementWarningSchema),
});
export type OpsContractEntitlementPreviewResponse = z.infer<
  typeof opsContractEntitlementPreviewResponseSchema
>;

export const opsContractAttachmentListResponseSchema = z.object({
  items: z.array(opsContractAttachmentSchema),
});
export type OpsContractAttachmentListResponse = z.infer<
  typeof opsContractAttachmentListResponseSchema
>;

/**
 * 创建附件的响应。
 *
 * `uploadUrl` 由 Worker 用 `OPS_STORAGE_PUBLIC_URL` 拼（§8），**不在库里生成**：
 * 库不知道部署环境的公开地址，而把地址写进迁移等于让每个环境共用一份常量。
 * `uploadExpiresAt` 是 `now + 5 分钟`——一个不带过期的上传地址等于长期写权限。
 */
export const opsContractAttachmentCreateResponseSchema = z.object({
  attachment: opsContractAttachmentSchema,
  uploadUrl: z.string().min(1),
  uploadExpiresAt: z.string().min(1),
});
export type OpsContractAttachmentCreateResponse = z.infer<
  typeof opsContractAttachmentCreateResponseSchema
>;

export const opsContractAttachmentCompleteResponseSchema = z.object({
  attachment: opsContractAttachmentSchema,
});
export type OpsContractAttachmentCompleteResponse = z.infer<
  typeof opsContractAttachmentCompleteResponseSchema
>;

/**
 * 附件访问票据。
 *
 * `url` 同样由 Worker 拼，`expiresAt` 与上传同口径（5 分钟）。契约 §5.4 这一行
 * 用的键名就是 `url`（上传那行是 `uploadUrl`），不要自作主张改成 `downloadUrl`：
 * 前端按契约取 `url`，改名等于让签名链接永远取不到。
 * `accessScope` 照实回传（默认 `contract.read`）：前端据此判断链接能不能给
 * 一个只读账号——把它藏起来会让「这张图我能不能转发」变成猜。
 */
export const opsContractAttachmentAccessResponseSchema = z.object({
  attachmentId: z.string().min(1),
  storagePath: z.string().min(1),
  accessScope: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type OpsContractAttachmentAccessResponse = z.infer<
  typeof opsContractAttachmentAccessResponseSchema
>;
