import { z } from 'zod';
import { listQuerySchema, pagedResponseSchema } from '../pagination';

/**
 * 运营端客户与联系人（契约 §3.1 / §5.2 的十一个端点）。
 *
 * 与根目录 `customers.ts` 分开：那份是**租户侧**客户（旅行社自己的旅客与企业客户），
 * 这份是**软件提供方**的签约客户（旅行社本身）。两份都有 `name`、都有联系人、
 * 字段名字面相同而口径完全不同——合成一个文件，最先发生的事是某个页面 import 了
 * 另一份的 `status` 字面量，于是运营客户列表把 `signed`（已签约）渲染成租户侧
 * 那套状态里的意思，而租户侧根本没有这个概念。
 */

/**
 * 客户状态（契约 §3.1 状态机）。五态封闭：迁移里的 `CHECK` 与这张表同源，
 * 新增取值必须同时改三处（迁移、这里、契约文档 §2.6）。
 */
export const OPS_CUSTOMER_STATUSES = [
  'signed',
  'onboarding',
  'active',
  'suspended',
  'terminated',
] as const;
export const opsCustomerStatusSchema = z.enum(OPS_CUSTOMER_STATUSES);
export type OpsCustomerStatus = z.infer<typeof opsCustomerStatusSchema>;

/**
 * 状态机动作（封闭集合，所以可以用 enum）。
 *
 * 与「筛选值是开放字符串」不同：这五个动作是 §3.1 状态机表的全部迁移边，
 * 多一个动作就等于多一条库里不存在的边。用 `z.enum` 让非法动作在入站就被 400，
 * 而不是下传到一个只能靠 `invalid_transition` 兜底的 RPC。
 */
export const OPS_CUSTOMER_TRANSITION_ACTIONS = [
  'start_onboarding',
  'activate',
  'suspend',
  'resume',
  'terminate',
] as const;
export const opsCustomerTransitionActionSchema = z.enum(OPS_CUSTOMER_TRANSITION_ACTIONS);
export type OpsCustomerTransitionAction = z.infer<typeof opsCustomerTransitionActionSchema>;

/**
 * 责任人。
 *
 * 只给 `id`/`displayName`/`email`：列表与详情都要能显示「谁在跟」，而链接到账号
 * 详情不成立——本域没有 `GET /operators/{id}`（账号域刻意没开这条，见 §5.1）。
 * `displayName` 可空：D-02 之前邀请的账号没有显示名，回落显示邮箱。
 */
export const opsCustomerOwnerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  email: z.string().min(1),
});
export type OpsCustomerOwner = z.infer<typeof opsCustomerOwnerSchema>;

/**
 * 客户对象 —— 详情、创建响应、更新响应共用。
 *
 * 可空字段一律写成 `nullable` 而不是 `optional`：这些列在库里就是可空的
 * （`unified_social_credit_code`、`region_code`、两个备注、`owner_operator_id`），
 * 「读出来没有」与「这一次没传」在这里不是同一件事。写侧的「没传」用
 * `.optional()` 表达，读侧用 `null`，两者不共用同一个形状。
 */
export const opsCustomerSchema = z.object({
  id: z.string().min(1),
  customerNo: z.string().min(1),
  name: z.string().min(1),
  unifiedSocialCreditCode: z.string().nullable(),
  regionCode: z.string().nullable(),
  status: opsCustomerStatusSchema,
  owner: opsCustomerOwnerSchema.nullable(),
  sourceNote: z.string().nullable(),
  internalNote: z.string().nullable(),
  /** 乐观锁。PATCH 与 transition 都要回传它（§3.0「PATCH 必须回传 version」）。 */
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsCustomer = z.infer<typeof opsCustomerSchema>;

/**
 * 列表项的主要联系人。
 *
 * 只有掩码值，没有原值键——这是刻意的，不是「暂时没加」：列表页从不展示完整
 * 手机号，而列表是批量读取，一次响应里塞 15 个原值手机号是这层最容易出的泄漏。
 * 原值只出现在联系人子资源上，并且还要 `customer.sensitive.read`。
 */
export const opsCustomerPrimaryContactSchema = z.object({
  maskedPhone: z.string().nullable(),
  maskedEmail: z.string().nullable(),
});
export type OpsCustomerPrimaryContact = z.infer<typeof opsCustomerPrimaryContactSchema>;

/**
 * 列表项。
 *
 * 契约 §5.2 的「响应关键字段」只列了 `id/customerNo/name/status/owner/
 * primaryContact/activeContractCount/createdAt`，本文件按既定口径给的是**完整客户
 * 对象 + 这两个附加字段**：列表页的「编辑」抽屉直接用列表行填充表单，少一个
 * `version` 就必须再发一次详情请求，而少 `regionCode` 会让编辑保存把已有值抹成空。
 * 差异已记入交付报告，等主会话与契约文档对齐。
 */
export const opsCustomerListItemSchema = opsCustomerSchema.extend({
  primaryContact: opsCustomerPrimaryContactSchema.nullable(),
  /** 生效中的合同数。列表页用它显示「在服务 / 未开通」的判断依据。 */
  activeContractCount: z.number().int().min(0),
});
export type OpsCustomerListItem = z.infer<typeof opsCustomerListItemSchema>;

/**
 * 联系人：**两个形状**，不是「一个形状加两个可选字段」。
 *
 * 数据库按 `has_permission('customer.sensitive.read')` 决定返回不返回
 * `phone`/`email` 原值键，Worker 只透传（不加键、不删键、不补 `null`）。于是
 * 出口只允许两种合法形态：
 *
 *   1. `opsCustomerContactSchema`：原值键**不存在**（无权限）；
 *   2. `opsCustomerContactSensitiveSchema`：原值键**必存在**，值可以是 `null`
 *      （有权限，但库里这一栏本来就空）。
 *
 * 两者都必须 strict：宽松对象会把 `{...联系人, phone: null}` 这种「有键没值」
 * 收进来，而它既不是形态 1 也不是形态 2——一旦允许它存在，「这个人有没有权限
 * 看电话」就再也无法从响应里判定。严格模式下它在解析层直接被拒
 * （`respond()` → 500 + `response_contract_violation` 日志），把上游违约变成
 * 一次可见的失败，而不是一次静默降级。
 *
 * 为什么不用 `optional()`：`phone?: …` 允许「键存在、值为 undefined」。那是第三种
 * 状态，而且不可靠——`JSON.stringify` 会把 undefined 的键整个丢掉，同一个对象在
 * Worker 里是「有键」、到了响应体里是「没键」。用 strict + 必存在的原值键之后，
 * 「有没有权限」只剩两个取值，序列化位置不影响判定。
 *
 * 代价写清楚：数据库若只给 `phone` 不给 `email`（一半原值），响应会 500 而不是
 * 「凑合能看」。这正是要的——半边原值说明 S1 的 RPC 分支写错了，必须在联调时
 * 报错，不能靠前端「看起来没坏」蒙混过去。
 */
const contactFieldsShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  jobTitle: z.string().nullable(),
  /** 掩码值恒可用：没有原值权限的人也要能看出「有没有留电话、尾号是多少」。 */
  phoneMasked: z.string().nullable(),
  emailMasked: z.string().nullable(),
  isPrimary: z.boolean(),
  usageScene: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

export const opsCustomerContactSchema = z.strictObject(contactFieldsShape);
export type OpsCustomerContact = z.infer<typeof opsCustomerContactSchema>;

export const opsCustomerContactSensitiveSchema = z.strictObject({
  ...contactFieldsShape,
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type OpsCustomerContactSensitive = z.infer<typeof opsCustomerContactSensitiveSchema>;

/**
 * 联系人的出口形状。敏感形状排在前面：联合按顺序尝试，先匹配「有原值键」，
 * 匹配不上才落到「无原值键」。反过来也能得到同样结果（strict 让两个形状互斥），
 * 但把敏感的那个写在前面，读代码的人第一眼看到的就是「原值是特例，要显式命中」。
 */
export const opsCustomerContactViewSchema = z.union([
  opsCustomerContactSensitiveSchema,
  opsCustomerContactSchema,
]);
export type OpsCustomerContactView = z.infer<typeof opsCustomerContactViewSchema>;

/**
 * 联系人创建/更新共用的输入字段。
 *
 * 单独抽出来，是因为「创建时内嵌在客户里的联系人」与「单独创建联系人」必须是
 * 同一份字段定义：两份定义迟早漂移，而表现是内嵌创建收得下 `usageScene`、
 * 单独创建收不下，前端只能在两处各写一套表单。
 *
 * 长度上限的说明：契约只给了客户侧的长度（`name ≤ 200` 等），联系人四项没写。
 * 这里按同域口径取保守值（见下），**不是**契约原文——已记入交付报告待确认。
 */
const contactInputShape = {
  name: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().max(120).optional(),
  phone: z.string().trim().min(3).max(32).optional(),
  email: z.string().trim().toLowerCase().max(200).pipe(z.email()).optional(),
  isPrimary: z.boolean().optional(),
  usageScene: z.string().trim().max(120).optional(),
};

/**
 * 内嵌在「创建客户」里的联系人草稿。
 *
 * 刻意**不含 `reason`**：审计理由属于这一次写操作的意图（「新签客户」），
 * 不属于第 3 个联系人。让每个元素各带一个 reason，等于让前端把一个理由抄 20 遍，
 * 而抄出来的 19 份永远不会被读到。
 */
export const opsCustomerContactInputSchema = z.object(contactInputShape);
export type OpsCustomerContactInput = z.infer<typeof opsCustomerContactInputSchema>;

/** 客户创建。`reason` 必填，与 ops 现有写侧一致（`operator.manage` 的同类要求）。 */
export const opsCustomerCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unifiedSocialCreditCode: z.string().trim().max(64).optional(),
  regionCode: z.string().trim().max(32).optional(),
  sourceNote: z.string().trim().max(500).optional(),
  internalNote: z.string().trim().max(2000).optional(),
  ownerOperatorId: z.uuid().optional(),
  /**
   * 上限 20：§3.1 没有写条数上限，这里取一个能让「创建即完整」成立、又不会让
   * 单次写事务无限长的值。超过 20 条的导入场景属于批量作业，不该走这个端点。
   */
  contacts: z.array(opsCustomerContactInputSchema).max(20).optional(),
  reason: z.string().trim().min(1).max(500),
});
export type OpsCustomerCreateRequest = z.infer<typeof opsCustomerCreateRequestSchema>;

/**
 * 客户更新（PATCH）。
 *
 * **`status` 与 `ownerOperatorId` 不在白名单里**，两条的理由不同：
 *
 * - `status` 只能走 `POST /customers/{id}/transition`。状态机每一条边都带守卫
 *   （`start_onboarding` 要至少一条联系人、`terminate` 要检查引用），PATCH 能改
 *   状态就等于给这些守卫开了一个后门；
 * - `ownerOperatorId` 在 §5.2 里**没有**对应的写入口（创建后不可换责任人）。
 *   契约没写的事不做，也不要「顺手加一个字段」——加出来的是契约外的行为，
 *   Admin 端不知道它存在，审计里也不会有一条说明责任人换过。
 *
 * 「不传 = 不改」由调用 RPC 时的 `null` 哨兵表达（ops 现有写侧的统一约定），
 * 但**清空**（把 `regionCode` 改回空）在当前形状下无法表达。这是契约缺口，
 * 已记入交付报告，没有在这里自创 `nullable` 语义。
 */
export const opsCustomerUpdateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  unifiedSocialCreditCode: z.string().trim().max(64).optional(),
  regionCode: z.string().trim().max(32).optional(),
  sourceNote: z.string().trim().max(500).optional(),
  internalNote: z.string().trim().max(2000).optional(),
  reason: z.string().trim().min(1).max(500),
  /** 乐观锁。不匹配由库判定为 `version_mismatch` → 409 `CONFLICT`。 */
  version: z.number().int().positive(),
});
export type OpsCustomerUpdateRequest = z.infer<typeof opsCustomerUpdateRequestSchema>;

/**
 * 重复检查。
 *
 * 没有 `reason`：它是一条**读**（POST 只是为了让 `name` 走 body，避免超长文本进
 * URL），不写库、不产生审计。给它加 `reason` 会让前端在「输入框失焦时自动查重」
 * 这种调用里编一个理由出来。
 */
export const opsCustomerDuplicateCheckRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unifiedSocialCreditCode: z.string().trim().max(64).optional(),
});
export type OpsCustomerDuplicateCheckRequest = z.infer<
  typeof opsCustomerDuplicateCheckRequestSchema
>;

/**
 * 状态迁移。
 *
 * `reason` 在 §3.1 里只对 `suspend`/`resume`/`terminate` 标注「需 reason」，
 * 这里对它一视同仁地必填：同一个端点的同一个字段时有时无，前端得先查动作表
 * 才知道要不要显示理由框，而漏显示的那一次会得到 400，用户看到的是「操作失败」
 * 而不是「这里要写原因」。
 */
export const opsCustomerTransitionRequestSchema = z.object({
  action: opsCustomerTransitionActionSchema,
  reason: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
});
export type OpsCustomerTransitionRequest = z.infer<typeof opsCustomerTransitionRequestSchema>;

/** 单独创建联系人。与内嵌草稿同一份字段 + 自己的 `reason`。 */
export const opsCustomerContactCreateRequestSchema = opsCustomerContactInputSchema.extend({
  reason: z.string().trim().min(1).max(500),
});
export type OpsCustomerContactCreateRequest = z.infer<typeof opsCustomerContactCreateRequestSchema>;

/** 联系人更新。`version` 是乐观锁，缺了就无法防「两个人同时改同一个联系人」。 */
export const opsCustomerContactUpdateRequestSchema = opsCustomerContactInputSchema
  .partial()
  .extend({
    reason: z.string().trim().min(1).max(500),
    version: z.number().int().positive(),
  });
export type OpsCustomerContactUpdateRequest = z.infer<typeof opsCustomerContactUpdateRequestSchema>;

/** 排序白名单，首项即默认（`createdAt` 降序 = 最新在前）。 */
export const OPS_CUSTOMER_SORT_FIELDS = ['createdAt', 'updatedAt', 'name'] as const;

/**
 * 列表查询。
 *
 * `status` 是**数组**，对应重复 query 参数（`?status=signed&status=active`）。
 * 读侧要用 `context.req.queries('status')` 才能拿全，`req.query()` 只保留第一个值
 * ——这条在路由里有注释说明，因为它是一个「看起来完全正常、实际只筛了一半」的坑。
 *
 * `contractStatus` 只校验形态不校验取值：§5.2 给了字段名没给取值集合，而合同状态
 * 枚举属于 contract 域（T-06）。在这里自己定义一份，会在两个契约文件之间制造
 * 第二真源；取值是否合法由库函数判定（非法值等价于「筛不出东西」）。
 */
export const opsCustomerListQuerySchema = listQuerySchema(OPS_CUSTOMER_SORT_FIELDS).extend({
  keyword: z.string().trim().max(120).optional(),
  status: z.array(opsCustomerStatusSchema).optional(),
  ownerOperatorId: z.uuid().optional(),
  contractStatus: z.string().trim().max(32).optional(),
  entitlementExpiringInDays: z.coerce.number().int().min(0).optional(),
});
export type OpsCustomerListQuery = z.infer<typeof opsCustomerListQuerySchema>;

export const opsCustomerListResponseSchema = pagedResponseSchema(opsCustomerListItemSchema);
export type OpsCustomerListResponse = z.infer<typeof opsCustomerListResponseSchema>;

/**
 * 重复提示。`reason` 是**匹配原因**（同名 / 同信用代码），与写操作的审计理由同名
 * 不同义；字段名照契约 §5.2，不为了避开撞名改口径。
 */
export const opsCustomerDuplicateHintSchema = z.object({
  id: z.string().min(1),
  customerNo: z.string().min(1),
  name: z.string().min(1),
  reason: z.string().min(1),
});
export type OpsCustomerDuplicateHint = z.infer<typeof opsCustomerDuplicateHintSchema>;

export const opsCustomerCreateResponseSchema = z.object({
  customer: opsCustomerSchema,
  /** 同名/同信用代码只提示不阻断（§3.1「不自动合并」）。空数组是正常结果。 */
  duplicateHints: z.array(opsCustomerDuplicateHintSchema),
});
export type OpsCustomerCreateResponse = z.infer<typeof opsCustomerCreateResponseSchema>;

export const opsCustomerDuplicateCheckResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      customerNo: z.string().min(1),
      name: z.string().min(1),
      matchReason: z.string().min(1),
    }),
  ),
});
export type OpsCustomerDuplicateCheckResponse = z.infer<
  typeof opsCustomerDuplicateCheckResponseSchema
>;

/**
 * 详情页的跨域计数。
 *
 * 六个域（合同、应收、订阅、授权、部署、工单）里的表本轮大部分还不存在。
 * **形状先定成「六个非负整数」**：这是 §5.2 明确写下的，与本轮其他域的落地进度无关；
 * 等各域落地后计数口径由各域的 RPC 提供，这里的形状不需要改。
 */
export const opsCustomerCountsSchema = z.object({
  contracts: z.number().int().min(0),
  receivables: z.number().int().min(0),
  subscriptions: z.number().int().min(0),
  licenses: z.number().int().min(0),
  deployments: z.number().int().min(0),
  tickets: z.number().int().min(0),
});
export type OpsCustomerCounts = z.infer<typeof opsCustomerCountsSchema>;

export const opsCustomerDetailResponseSchema = z.object({
  customer: opsCustomerSchema,
  /** 形状由权限决定：见上面的 union 说明。 */
  contacts: z.array(opsCustomerContactViewSchema),
  counts: opsCustomerCountsSchema,
});
export type OpsCustomerDetailResponse = z.infer<typeof opsCustomerDetailResponseSchema>;

export const opsCustomerUpdateResponseSchema = z.object({ customer: opsCustomerSchema });
export type OpsCustomerUpdateResponse = z.infer<typeof opsCustomerUpdateResponseSchema>;

/**
 * 迁移影响的摘要计数。
 *
 * 挂起/终止前要让人看见「会影响 3 份合同、1 个授权、2 张工单」，所以这里是
 * 计数而不是明细列表——明细在各域端点里，而这个响应要能在确认弹窗里一次说完。
 * 终止被引用时同一形状放进 409 `OBJECT_REFERENCED` 的 `details.impact`。
 */
export const opsCustomerImpactSchema = z.object({
  contracts: z.number().int().min(0),
  entitlements: z.number().int().min(0),
  tickets: z.number().int().min(0),
  deployments: z.number().int().min(0),
});
export type OpsCustomerImpact = z.infer<typeof opsCustomerImpactSchema>;

export const opsCustomerTransitionResponseSchema = z.object({
  /** 只回状态与版本：前端拿到它就能更新行内标签与乐观锁，不必重拉详情。 */
  customer: z.object({
    status: opsCustomerStatusSchema,
    version: z.number().int().positive(),
  }),
  impact: opsCustomerImpactSchema,
});
export type OpsCustomerTransitionResponse = z.infer<typeof opsCustomerTransitionResponseSchema>;

/**
 * 摘要数组的元素形状。
 *
 * 本轮定成「任意键值对」，因为合同/应收/订阅/授权/租户映射/部署/工单七张表里
 * 只有客户域在落地，其余域的具体字段还没定稿。在这里编一组字段名，等于让七份
 * 还没写的迁移去适配一个先写下的形状——顺序反了。各域落地后逐个收紧为具体 schema，
 * 收紧时只改这一处，但要同步改 `respond()` 会校验的响应形状（属于契约破坏性变更）。
 */
const overviewSummarySchema = z.array(z.record(z.string(), z.unknown()));

export const opsCustomerOverviewResponseSchema = z.object({
  contracts: overviewSummarySchema,
  receivables: overviewSummarySchema,
  subscriptions: overviewSummarySchema,
  licenses: overviewSummarySchema,
  tenantMappings: overviewSummarySchema,
  deployments: overviewSummarySchema,
  tickets: overviewSummarySchema,
});
export type OpsCustomerOverviewResponse = z.infer<typeof opsCustomerOverviewResponseSchema>;

export const opsCustomerContactListResponseSchema = z.object({
  items: z.array(opsCustomerContactViewSchema),
});
export type OpsCustomerContactListResponse = z.infer<typeof opsCustomerContactListResponseSchema>;

export const opsCustomerContactResponseSchema = z.object({ contact: opsCustomerContactViewSchema });
export type OpsCustomerContactResponse = z.infer<typeof opsCustomerContactResponseSchema>;

/** 删除回执返回被删 ID：联系人没有软删除，前端要能就地把它从列表里摘掉。 */
export const opsCustomerContactDeleteResponseSchema = z.object({
  deletedContactId: z.string().min(1),
});
export type OpsCustomerContactDeleteResponse = z.infer<
  typeof opsCustomerContactDeleteResponseSchema
>;
