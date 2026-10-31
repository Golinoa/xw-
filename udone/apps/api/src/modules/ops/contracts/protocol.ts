import {
  z,
  type OpsBillingType,
  type OpsContract,
  type OpsContractAmendment,
  type OpsContractAmendmentStatus,
  type OpsContractAttachment,
  type OpsContractAttachmentStatus,
  type OpsContractCustomerSummary,
  type OpsContractEntitlementFeature,
  type OpsContractEntitlementWarning,
  type OpsContractImpact,
  type OpsContractItem,
  type OpsContractOwner,
  type OpsContractStatus,
  type OpsContractVersion,
  type OpsFeatureAppliesTo,
  type OpsSalesMode,
} from '@erp/contracts';

/**
 * RPC 返回值（数据库列名）与出口形状（契约字段名）之间的那一层。
 *
 * 与客户域 / catalog 同构：RPC 一律返回 snake_case（`jsonb_build_object('contract_no', …)`），
 * 出口一律 camelCase。直接 `as` 断言会让列改名变成前端拿到 `undefined`，有 zod
 * 校验时同样的漂移会以 `ops_rpc_shape_invalid` + RPC 名出现在日志里。
 *
 * **金额是 number**：`numeric(14,2)` 经 `jsonb_build_object` 出来就是 JSON number。
 * 这里写成 `z.number()`，哪天数据层改成 `to_char` 返回字符串，会立刻 503 而不是
 * 让前端 `Number("1,200.00")` 得到 `NaN`。
 *
 * **信封键名是本轮与 DB 会话的约定**：规格 §3 给了 14 个 RPC 的签名与成功码，
 * 但没给信封形状（catalog 规格是有的）。这里按 §1 的列名 + catalog 的既有命名
 * 规则推出每个信封，并在交付报告里列为联调第一优先核对项——形状对不上时表现得
 * 很清楚（`ops_rpc_shape_invalid` + RPC 名 + 字段路径），不会静默错。
 */

export const contractOwnerRowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().nullable(),
  email: z.string().min(1),
});

export const contractCustomerRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

export const contractRowSchema = z.object({
  id: z.string().min(1),
  contract_no: z.string().min(1),
  customer_id: z.string().min(1),
  customer: contractCustomerRowSchema,
  sales_owner: contractOwnerRowSchema.nullable(),
  sales_mode: z.enum(['saas', 'private']),
  currency: z.string().min(1),
  total_amount: z.number().min(0),
  payment_terms: z.string().nullable(),
  tax_note: z.string().nullable(),
  business_note: z.string().nullable(),
  status: z.enum(['draft', 'reviewing', 'signed', 'active', 'expired', 'terminated']),
  signed_on: z.string().nullable(),
  effective_on: z.string().nullable(),
  expires_on: z.string().nullable(),
  renewed_from_contract_id: z.string().nullable(),
  status_reason: z.string().nullable(),
  /** 0 = 还没有任何版本快照（`draft` 阶段），所以这里不能用 `positive()`。 */
  current_version_no: z.number().int().min(0),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type ContractRow = z.infer<typeof contractRowSchema>;

export function toContract(row: ContractRow): OpsContract {
  const customer: OpsContractCustomerSummary = {
    id: row.customer.id,
    customerNo: row.customer.customer_no,
    name: row.customer.name,
  };
  const salesOwner: OpsContractOwner | null =
    row.sales_owner === null
      ? null
      : {
          id: row.sales_owner.id,
          displayName: row.sales_owner.display_name,
          email: row.sales_owner.email,
        };

  return {
    id: row.id,
    contractNo: row.contract_no,
    customerId: row.customer_id,
    customer,
    salesOwner,
    salesMode: row.sales_mode as OpsSalesMode,
    currency: row.currency,
    totalAmount: row.total_amount,
    paymentTerms: row.payment_terms,
    taxNote: row.tax_note,
    businessNote: row.business_note,
    status: row.status as OpsContractStatus,
    signedOn: row.signed_on,
    effectiveOn: row.effective_on,
    expiresOn: row.expires_on,
    renewedFromContractId: row.renewed_from_contract_id,
    statusReason: row.status_reason,
    currentVersionNo: row.current_version_no,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const contractItemRowSchema = z.object({
  id: z.string().min(1),
  line_no: z.number().int().positive(),
  product_id: z.string().nullable(),
  package_id: z.string().nullable(),
  /** 列名是 `package_price_version_id`（不是 `price_version_id`），与库一致。 */
  package_price_version_id: z.string().nullable(),
  sales_mode: z.enum(['saas', 'private']),
  billing_type: z.enum(['periodic', 'fixed_term', 'one_time']),
  quantity: z.number().int().positive(),
  unit_price: z.number().min(0),
  amount: z.number().min(0),
  term_months: z.number().int().nullable(),
  item_name_snapshot: z.string().min(1),
});

export function toContractItem(row: z.infer<typeof contractItemRowSchema>): OpsContractItem {
  return {
    id: row.id,
    lineNo: row.line_no,
    productId: row.product_id,
    packageId: row.package_id,
    priceVersionId: row.package_price_version_id,
    salesMode: row.sales_mode as OpsSalesMode,
    billingType: row.billing_type as OpsBillingType,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    amount: row.amount,
    termMonths: row.term_months,
    itemNameSnapshot: row.item_name_snapshot,
  };
}

export const contractAttachmentRowSchema = z.object({
  id: z.string().min(1),
  contract_id: z.string().min(1),
  file_name: z.string().min(1),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  storage_path: z.string().min(1),
  checksum_sha256: z.string().nullable(),
  status: z.enum(['pending', 'stored']),
  access_scope: z.string().min(1),
  uploaded_by: z.string().nullable(),
  uploaded_at: z.string().min(1),
});

export function toContractAttachment(
  row: z.infer<typeof contractAttachmentRowSchema>,
): OpsContractAttachment {
  return {
    id: row.id,
    contractId: row.contract_id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    storagePath: row.storage_path,
    checksumSha256: row.checksum_sha256,
    status: row.status as OpsContractAttachmentStatus,
    accessScope: row.access_scope,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

export const contractVersionRowSchema = z.object({
  id: z.string().min(1),
  version_no: z.number().int().positive(),
  snapshot: z.record(z.string(), z.unknown()),
  change_reason: z.string().min(1),
  created_by: z.string().nullable(),
  created_at: z.string().min(1),
});

export function toContractVersion(
  row: z.infer<typeof contractVersionRowSchema>,
): OpsContractVersion {
  return {
    id: row.id,
    versionNo: row.version_no,
    // 快照按「任意键值对」透传：形状由 §4 写在生成侧，读出侧不重新解释一遍。
    snapshot: row.snapshot,
    changeReason: row.change_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export const contractAmendmentRowSchema = z.object({
  id: z.string().min(1),
  contract_id: z.string().min(1),
  amendment_no: z.number().int().positive(),
  reason: z.string().min(1),
  before_summary: z.record(z.string(), z.unknown()),
  after_summary: z.record(z.string(), z.unknown()),
  status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'applied']),
  requested_by: z.string().nullable(),
  approved_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  applied_version_no: z.number().int().nullable(),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export function toContractAmendment(
  row: z.infer<typeof contractAmendmentRowSchema>,
): OpsContractAmendment {
  return {
    id: row.id,
    contractId: row.contract_id,
    amendmentNo: row.amendment_no,
    reason: row.reason,
    beforeSummary: row.before_summary,
    afterSummary: row.after_summary,
    status: row.status as OpsContractAmendmentStatus,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    appliedVersionNo: row.applied_version_no,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `ops.contract_reference_counts` 的返回（§5）。三个键都是「未落地域里的引用数」，
 * 表不存在时恒为 0，T-07/T-09/T-10 落地后自动生效，本层不需要改。
 */
export const contractImpactRowSchema = z.object({
  receivables: z.number().int().min(0),
  entitlements: z.number().int().min(0),
  tenant_commands: z.number().int().min(0),
});

export function toImpact(row: z.infer<typeof contractImpactRowSchema>): OpsContractImpact {
  return {
    receivables: row.receivables,
    entitlements: row.entitlements,
    tenantCommands: row.tenant_commands,
  };
}

/**
 * 权益预览的 row 形状是**驼峰**，与其余 RPC 的 snake_case 不同。
 *
 * `ops.contract_entitlement_preview` 直接按 §6 的输出形状 `jsonb_build_object`
 * （`featureKey` / `termMonths` / `packageId`），没有经过列名口径——这张图是
 * 「算出来的视图」，不是某张表的一行。照实收驼峰，而不是在这里做一次
 * 「驼峰→驼峰」的空转换，是为了让「这一份 RPC 和别人不一样」在代码里看得见。
 */
export const contractEntitlementFeatureRowSchema = z.object({
  featureKey: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  quota: z.number().nullable(),
  termMonths: z.number().int().nullable(),
  appliesTo: z.enum(['saas_tenant', 'private_instance', 'both']),
});

export function toEntitlementFeature(
  row: z.infer<typeof contractEntitlementFeatureRowSchema>,
): OpsContractEntitlementFeature {
  return {
    featureKey: row.featureKey,
    displayName: row.displayName,
    enabled: row.enabled,
    quota: row.quota,
    termMonths: row.termMonths,
    appliesTo: row.appliesTo as OpsFeatureAppliesTo,
  };
}

export const contractEntitlementWarningRowSchema = z.object({
  code: z.string().min(1),
  packageId: z.string().min(1),
});

export function toEntitlementWarning(
  row: z.infer<typeof contractEntitlementWarningRowSchema>,
): OpsContractEntitlementWarning {
  return { code: row.code, packageId: row.packageId };
}

/** 详情里「未落地域」的列表元素：形状随各域定稿，这里只透传。 */
const deferredDomainRowSchema = z.record(z.string(), z.unknown());

export const contractListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(contractRowSchema),
  total: z.number().int().min(0),
});

export const contractCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), contract: contractRowSchema }),
  z.object({ status: z.literal('customer_not_found') }),
  z.object({ status: z.literal('items_required') }),
  z.object({ status: z.literal('price_mismatch') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
  z.object({ status: z.literal('contract_no_conflict') }),
]);

export const contractDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    contract: contractRowSchema,
    items: z.array(contractItemRowSchema),
    /** 表不存在时是 `null`（没有摘要），不是 `{}`——两者含义不同。 */
    receivable_summary: deferredDomainRowSchema.nullish(),
    receivables: z.array(deferredDomainRowSchema),
    subscriptions: z.array(deferredDomainRowSchema),
    licenses: z.array(deferredDomainRowSchema),
    attachments: z.array(contractAttachmentRowSchema),
  }),
  z.object({ status: z.literal('contract_not_found') }),
]);

export const contractUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), contract: contractRowSchema }),
  z.object({ status: z.literal('contract_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  /** 只有 `draft|reviewing` 可改（§2）；带了当前状态，前端才能说明为什么不能改。 */
  z.object({
    status: z.literal('contract_immutable'),
    current: z.string().nullish(),
    current_status: z.string().nullish(),
  }),
  z.object({ status: z.literal('price_mismatch') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
  z.object({ status: z.literal('items_required') }),
]);

export const contractTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    contract: z.object({
      status: z.enum(['draft', 'reviewing', 'signed', 'active', 'expired', 'terminated']),
      version: z.number().int(),
    }),
    impact: contractImpactRowSchema,
    /** 契约 §5.4 的 `createdVersionNo?`：`activate` 写了第 N 版快照才有值。 */
    created_version_no: z.number().int().nullish(),
  }),
  z.object({ status: z.literal('contract_not_found') }),
  /** `submit` 的客户资格守卫，客户行在检查过程中消失时走这一条。 */
  z.object({ status: z.literal('customer_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  /** §2 的信封形状：`{status:'invalid_transition', current, action}`。 */
  z.object({
    status: z.literal('invalid_transition'),
    current: z.string().min(1),
    action: z.string().min(1),
  }),
  z.object({ status: z.literal('referenced'), impact: contractImpactRowSchema }),
  z.object({ status: z.literal('customer_not_eligible') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
  z.object({ status: z.literal('items_required') }),
  z.object({ status: z.literal('total_mismatch') }),
]);

export const contractVersionListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(contractVersionRowSchema) }),
  z.object({ status: z.literal('contract_not_found') }),
]);

export const contractAmendmentCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), amendment: contractAmendmentRowSchema }),
  z.object({ status: z.literal('contract_not_found') }),
  z.object({ status: z.literal('amendment_conflict') }),
  z.object({
    status: z.literal('contract_immutable'),
    current: z.string().nullish(),
    current_status: z.string().nullish(),
  }),
  z.object({ status: z.literal('items_required') }),
  z.object({ status: z.literal('price_mismatch') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
]);

export const contractAmendmentTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    amendment: z.object({
      status: z.enum(['draft', 'pending_approval', 'approved', 'rejected', 'applied']),
      version: z.number().int(),
    }),
    /** `apply` 写了新版本快照时才有值（契约 §5.4 的 `createdVersionNo?`）。 */
    created_version_no: z.number().int().nullish(),
  }),
  z.object({ status: z.literal('amendment_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  /**
   * 职责分离：申请人不能批自己那张（§1 的 `CHECK`）。`reason` 只在这一条分支上
   * 出现（`SELF_APPROVAL`），其余冲突出自 `create_contract_amendment`，没有 reason。
   */
  z.object({
    status: z.literal('amendment_conflict'),
    field: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  /** `apply` 时原合同已经被删（级联），与 `create_contract_amendment` 同一个词。 */
  z.object({ status: z.literal('contract_not_found') }),
  z.object({
    status: z.literal('invalid_transition'),
    current: z.string().min(1),
    action: z.string().min(1),
  }),
]);

export const contractRenewalEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), contract: contractRowSchema }),
  z.object({ status: z.literal('contract_not_found') }),
  z.object({ status: z.literal('customer_not_found') }),
  z.object({ status: z.literal('renewal_not_due') }),
  /** `draft`/`reviewing` 的合同还没有生效过，续约没有意义（`action: 'renew'`）。 */
  z.object({
    status: z.literal('invalid_transition'),
    current: z.string().min(1),
    action: z.string().min(1),
  }),
  z.object({ status: z.literal('contract_no_conflict') }),
  z.object({ status: z.literal('customer_not_eligible') }),
  z.object({ status: z.literal('items_required') }),
  z.object({ status: z.literal('price_mismatch') }),
  z.object({ status: z.literal('sales_mode_disabled'), sales_mode: z.string().min(1) }),
]);

export const contractEntitlementPreviewEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    features: z.array(contractEntitlementFeatureRowSchema),
    warnings: z.array(contractEntitlementWarningRowSchema),
  }),
  z.object({ status: z.literal('contract_not_found') }),
]);

export const contractAttachmentListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(contractAttachmentRowSchema) }),
  z.object({ status: z.literal('contract_not_found') }),
]);

export const contractAttachmentCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), attachment: contractAttachmentRowSchema }),
  z.object({ status: z.literal('contract_not_found') }),
  /**
   * 大小/类型是库判的（§8）。`max_bytes` 允许缺省：库里回不回这个键都只影响
   * `details.maxBytes`，而那个值有契约常量兜底（26214400），不该让一个纯拒绝
   * 分支因为少一个键变成 503。
   */
  z.object({ status: z.literal('attachment_too_large'), max_bytes: z.number().int().nullish() }),
  z.object({ status: z.literal('attachment_type_rejected') }),
  /**
   * 文件名为空。词表里没有 `attachment_name_required`，库里归到通用的
   * `items_required` + `field:'fileName'`（见迁移注释），这里照实收。
   */
  z.object({
    status: z.literal('items_required'),
    field: z.string().nullish(),
  }),
]);

export const contractAttachmentCompleteEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), attachment: contractAttachmentRowSchema }),
  z.object({ status: z.literal('attachment_not_found') }),
  /**
   * 校验和格式不对（不是 64 位十六进制）。
   *
   * 这个词原来借用 `attachment_not_uploaded`，而那个词说的是另一件事——
   * 「文件还没传上来」。两件事共用一个词之后，客户端无法区分「检查你的
   * 请求体」与「先把文件传上来」，只能笼统提示一句。
   */
  z.object({ status: z.literal('invalid_checksum'), field: z.string() }),
]);

/**
 * 附件的存储位置。`complete` 之前先用它拿路径去做对象存在性校验。
 *
 * 顺序是「先读、再核、后改」：如果先改再核，一次失败的校验会留下已经
 * stored 的行，而对象不在存储里——那个状态比拒绝更糟。
 */
export const contractAttachmentLocationEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    storage_path: z.string().min(1),
    file_name: z.string().min(1),
    byte_size: z.number(),
    attachment_status: z.enum(['pending', 'stored']),
  }),
  z.object({ status: z.literal('attachment_not_found') }),
]);

export const contractAttachmentAccessEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), attachment: contractAttachmentRowSchema }),
  z.object({ status: z.literal('attachment_not_found') }),
]);
