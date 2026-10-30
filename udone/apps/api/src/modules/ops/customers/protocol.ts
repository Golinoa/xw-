import {
  z,
  type OpsCustomer,
  type OpsCustomerContactView,
  type OpsCustomerCounts,
  type OpsCustomerDuplicateCheckResponse,
  type OpsCustomerDuplicateHint,
  type OpsCustomerImpact,
  type OpsCustomerListItem,
  type OpsCustomerOverviewResponse,
  type OpsCustomerStatus,
} from '@erp/contracts';

/**
 * RPC 返回值（数据库列名）与出口形状（契约字段名）之间的那一层。
 *
 * 中间这一层的作用不是「转换一下」，而是让列改名变成一次失败：直接 `as` 断言的话，
 * `customer_no` 改成 `customerNo` 之后前端拿到 `undefined`，渲染成空字符串，
 * 看起来像「这个客户没有编号」。有了 zod 校验，同样的迁移会让 `ops_rpc_shape_invalid`
 * 出现在日志里，请求 503。
 *
 * **键名口径**：RPC 一律返回 snake_case（与 `ops.list_operators`、`ops.invite_operator`
 * 等既有函数一致，它们都用 `jsonb_build_object('display_name', …)` 这种写法），
 * 因此本文件的所有 row schema 都是 snake_case。嵌套对象跟着走 snake
 * （`primary_contact.masked_phone`、`owner.display_name`）：同一个响应里混两种命名，
 * 是这类 jsonb 接口最常见的漂移来源。
 */

export const customerOwnerRowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().nullable(),
  email: z.string().min(1),
});

export type CustomerOwnerRow = z.infer<typeof customerOwnerRowSchema>;

export const customerRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
  unified_social_credit_code: z.string().nullable(),
  region_code: z.string().nullable(),
  status: z.enum(['signed', 'onboarding', 'active', 'suspended', 'terminated']),
  owner: customerOwnerRowSchema.nullable(),
  source_note: z.string().nullable(),
  internal_note: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type CustomerRow = z.infer<typeof customerRowSchema>;

export const customerPrimaryContactRowSchema = z.object({
  masked_phone: z.string().nullable(),
  masked_email: z.string().nullable(),
});

export const customerListRowSchema = customerRowSchema.extend({
  primary_contact: customerPrimaryContactRowSchema.nullable(),
  active_contract_count: z.number().int().min(0),
});

export type CustomerListRow = z.infer<typeof customerListRowSchema>;

export function toCustomer(row: CustomerRow): OpsCustomer {
  return {
    id: row.id,
    customerNo: row.customer_no,
    name: row.name,
    unifiedSocialCreditCode: row.unified_social_credit_code,
    regionCode: row.region_code,
    status: row.status as OpsCustomerStatus,
    owner:
      row.owner === null
        ? null
        : {
            id: row.owner.id,
            displayName: row.owner.display_name,
            email: row.owner.email,
          },
    sourceNote: row.source_note,
    internalNote: row.internal_note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCustomerListItem(row: CustomerListRow): OpsCustomerListItem {
  return {
    ...toCustomer(row),
    primaryContact:
      row.primary_contact === null
        ? null
        : {
            maskedPhone: row.primary_contact.masked_phone,
            maskedEmail: row.primary_contact.masked_email,
          },
    activeContractCount: row.active_contract_count,
  };
}

/**
 * 联系人的两个 row 形状，与出口的两个形状一一对应，也在这里用 `strictObject` 卡住。
 *
 * 为什么要在这里再卡一次：`respond()` 已经会用同一份 union 校验出站数据，但那时
 * 错误形态是「响应契约违约」（500），日志里看不出是哪条 RPC 出的问题。在信封
 * 解析处就失败，得到的是 `ops_rpc_shape_invalid` + RPC 名，定位一步到位。
 *
 * 半边原值（只有 `phone` 没有 `email`）两个 row 形状都不匹配 → 503。这是刻意的：
 * 它说明库里那条 `has_permission` 分支写错了，而「凑合渲染」会让它在联调里
 * 一直看不见。
 */
const contactRowFieldsShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  job_title: z.string().nullable(),
  phone_masked: z.string().nullable(),
  email_masked: z.string().nullable(),
  is_primary: z.boolean(),
  usage_scene: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
};

export const customerContactPlainRowSchema = z.strictObject(contactRowFieldsShape);

export const customerContactSensitiveRowSchema = z.strictObject({
  ...contactRowFieldsShape,
  phone: z.string().nullable(),
  email: z.string().nullable(),
});

export const customerContactRowSchema = z.union([
  customerContactSensitiveRowSchema,
  customerContactPlainRowSchema,
]);

export type CustomerContactRow = z.infer<typeof customerContactRowSchema>;

/**
 * 原值键是否出现，完全由数据库决定；这里只做「有就带上、没有就不带」。
 *
 * 不写 `phone: row.phone ?? null`：那会把「没权限（键不存在）」改写成
 * 「有权限但没填（键为 null）」，两个语义在响应里就再也分不开了——而 P6 的验收
 * 断言恰恰是「无权限时键不存在」。
 */
export function toContactView(row: CustomerContactRow): OpsCustomerContactView {
  const base = {
    id: row.id,
    name: row.name,
    jobTitle: row.job_title,
    phoneMasked: row.phone_masked,
    emailMasked: row.email_masked,
    isPrimary: row.is_primary,
    usageScene: row.usage_scene,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return 'phone' in row ? { ...base, phone: row.phone, email: row.email } : base;
}

export const customerCountsRowSchema = z.object({
  contracts: z.number().int().min(0),
  receivables: z.number().int().min(0),
  subscriptions: z.number().int().min(0),
  licenses: z.number().int().min(0),
  deployments: z.number().int().min(0),
  tickets: z.number().int().min(0),
});

export function toCounts(row: z.infer<typeof customerCountsRowSchema>): OpsCustomerCounts {
  return {
    contracts: row.contracts,
    receivables: row.receivables,
    subscriptions: row.subscriptions,
    licenses: row.licenses,
    deployments: row.deployments,
    tickets: row.tickets,
  };
}

export const customerImpactRowSchema = z.object({
  contracts: z.number().int().min(0),
  entitlements: z.number().int().min(0),
  tickets: z.number().int().min(0),
  deployments: z.number().int().min(0),
});

export function toImpact(row: z.infer<typeof customerImpactRowSchema>): OpsCustomerImpact {
  return {
    contracts: row.contracts,
    entitlements: row.entitlements,
    tickets: row.tickets,
    deployments: row.deployments,
  };
}

export const customerDuplicateHintRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});

export function toDuplicateHint(
  row: z.infer<typeof customerDuplicateHintRowSchema>,
): OpsCustomerDuplicateHint {
  return { id: row.id, customerNo: row.customer_no, name: row.name, reason: row.reason };
}

export const customerDuplicateCheckItemRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
  match_reason: z.string().min(1),
});

export type CustomerDuplicateCheckItem = OpsCustomerDuplicateCheckResponse['items'][number];

export function toDuplicateCheckItem(
  row: z.infer<typeof customerDuplicateCheckItemRowSchema>,
): CustomerDuplicateCheckItem {
  return { id: row.id, customerNo: row.customer_no, name: row.name, matchReason: row.match_reason };
}

/**
 * 总览的七个摘要数组。
 *
 * 元素只校验到「是对象」（`z.record(z.string(), z.unknown())`）：那七张表还没落地，
 * 在这里写死字段就是拿一个猜测去卡七份还没写的迁移。但**数组本身**要校验——
 * 「`contracts` 是数组还是 `{items,total}`」这件事本轮就能定死，不该等；
 * 元素是对象这件事也该定死，否则一个 `null` 元素会让前端在渲染时炸掉。
 */
const overviewArrays = z.object({
  contracts: z.array(z.record(z.string(), z.unknown())),
  receivables: z.array(z.record(z.string(), z.unknown())),
  subscriptions: z.array(z.record(z.string(), z.unknown())),
  licenses: z.array(z.record(z.string(), z.unknown())),
  tenant_mappings: z.array(z.record(z.string(), z.unknown())),
  deployments: z.array(z.record(z.string(), z.unknown())),
  tickets: z.array(z.record(z.string(), z.unknown())),
});

export function toOverview(row: z.infer<typeof overviewArrays>): OpsCustomerOverviewResponse {
  return {
    contracts: row.contracts,
    receivables: row.receivables,
    subscriptions: row.subscriptions,
    licenses: row.licenses,
    tenantMappings: row.tenant_mappings,
    deployments: row.deployments,
    tickets: row.tickets,
  };
}

/** `{items,total}` 的读端点共用这个外壳。 */
export const customerListEnvelopeSchema = z.object({
  items: z.array(customerListRowSchema),
  total: z.number().int().min(0),
});

export const customerCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    customer: customerRowSchema,
    duplicate_hints: z.array(customerDuplicateHintRowSchema),
  }),
  z.object({ status: z.literal('customer_no_conflict') }),
  z.object({ status: z.literal('unknown_owner'), owner_operator_id: z.string().min(1) }),
]);

export const customerDuplicateCheckEnvelopeSchema = z.object({
  items: z.array(customerDuplicateCheckItemRowSchema),
});

export const customerDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    customer: customerRowSchema,
    contacts: z.array(customerContactRowSchema),
    counts: customerCountsRowSchema,
  }),
  z.object({ status: z.literal('not_found') }),
]);

export const customerUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), customer: customerRowSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
]);

export const customerTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    customer: z.object({
      status: z.enum(['signed', 'onboarding', 'active', 'suspended', 'terminated']),
      version: z.number().int(),
    }),
    impact: customerImpactRowSchema,
  }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('invalid_transition') }),
  z.object({ status: z.literal('contacts_required') }),
  z.object({ status: z.literal('referenced'), impact: customerImpactRowSchema }),
]);

export const customerOverviewEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), ...overviewArrays.shape }),
  z.object({ status: z.literal('not_found') }),
]);

export const customerContactListEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(customerContactRowSchema) }),
  z.object({ status: z.literal('not_found') }),
]);

export const customerContactEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), contact: customerContactRowSchema }),
  z.object({ status: z.literal('not_found') }),
]);

export const customerContactUpdateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), contact: customerContactRowSchema }),
  z.object({ status: z.literal('not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
]);

export const customerContactDeleteEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), deleted_contact_id: z.string().min(1) }),
  z.object({ status: z.literal('not_found') }),
  /** 客户非 `terminated` 时，最后一条联系人不能删（否则客户会失去唯一联系方式）。 */
  z.object({ status: z.literal('last_primary') }),
]);
