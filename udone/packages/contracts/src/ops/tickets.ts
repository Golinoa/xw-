import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  pageNumberSchema,
  pageSizeSchema,
  pagedResponseSchema,
} from '../pagination';

/**
 * 支撑域（契约 §3.6 / §5.6 的十个端点：售后工单与时间线）。
 *
 * 三处口径写在类型里而不是散在实现里：
 *
 * 1. **`status` 六态、`priority` 四档、`action` 七种全部是常量数组 + `z.enum`**。
 *    与审计动作词不同（那个刻意不用枚举），这三组是**契约写死的封闭集合**：
 *    新增一个状态意味着状态机多一条边，服务端与前端必须同一次发布，枚举正好
 *    把这个约束变成编译期错误。审计词会持续增长，所以那里不能用枚举。
 *
 * 2. **`isOverdue` 由服务端算好**（契约 §5.6 脚注：前端禁止自行比较时间）。
 *    本机时钟与时区不一致会产生假逾期，而这类误报比不显示更难排查——所以它不是
 *    「可选优化」，是响应里必须存在的布尔值。
 *
 * 3. **`dueAt` 是创建时的快照**，不随 `settings.ticket.dueHours` 变化。改设置只
 *    影响之后创建的工单：把「urgent 从 48 小时改成 12 小时」不该让上周已创建的单子
 *    集体变成逾期。
 */

export const OPS_TICKET_STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'waiting',
  'resolved',
  'closed',
] as const;
export const opsTicketStatusSchema = z.enum(OPS_TICKET_STATUSES);
export type OpsTicketStatus = z.infer<typeof opsTicketStatusSchema>;

export const OPS_TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export const opsTicketPrioritySchema = z.enum(OPS_TICKET_PRIORITIES);
export type OpsTicketPriority = z.infer<typeof opsTicketPrioritySchema>;

/**
 * 状态机能产生的动作（契约 §3.6 的八条边）。
 *
 * `create` 不在里面：它不是迁移，是创建。`assign` 在里面，因为它确实是
 * `new → assigned` 那条边（改派不算迁移，见下）。
 */
export const OPS_TICKET_ACTIONS = [
  'assign',
  'start',
  'wait',
  'resume',
  'resolve',
  'close',
  'reopen',
] as const;
export const opsTicketActionSchema = z.enum(OPS_TICKET_ACTIONS);
export type OpsTicketAction = z.infer<typeof opsTicketActionSchema>;

/**
 * `transition` 端点接受的动作 = 状态机动作去掉 `assign`（它有自己的端点，要带
 * 被分派人）。分成两个枚举而不是在 handler 里 `if action === 'assign' throw`：
 * 类型上就不允许，前端也不会拿 `transition` 去分派。
 */
export const OPS_TICKET_TRANSITION_ACTIONS = [
  'start',
  'wait',
  'resume',
  'resolve',
  'close',
  'reopen',
] as const;
export const opsTicketTransitionActionSchema = z.enum(OPS_TICKET_TRANSITION_ACTIONS);
export type OpsTicketTransitionAction = z.infer<typeof opsTicketTransitionActionSchema>;

export const OPS_TICKET_REF_TYPES = [
  'tenant_command',
  'entitlement_change',
  'deployment_version',
] as const;
export const opsTicketRefTypeSchema = z.enum(OPS_TICKET_REF_TYPES);
export type OpsTicketRefType = z.infer<typeof opsTicketRefTypeSchema>;

/**
 * 人员摘要（负责人 / 事件 actor / 可指派成员共用）。
 *
 * 只给 `id` / `displayName` / `status`：售后角色通常没有 `operator.read`，
 * 让前端另调 `/operators` 会 403（契约 §5.6 脚注）。**不带邮箱**——`ticket.read`
 * 是低危权限，`operator.read` 不是，带邮箱等于把后者的效果塞进前者。
 */
export const opsTicketActorSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  status: z.string(),
});
export type OpsTicketActor = z.infer<typeof opsTicketActorSchema>;

export const opsTicketCustomerSchema = z.object({
  id: z.uuid(),
  customerNo: z.string(),
  name: z.string(),
});
export type OpsTicketCustomer = z.infer<typeof opsTicketCustomerSchema>;

/** 列表项（契约 §5.6 第一条的 `items` 形状，是工单的摘要）。 */
export const opsTicketListItemSchema = z.object({
  id: z.uuid(),
  ticketNo: z.string(),
  subject: z.string(),
  customer: opsTicketCustomerSchema,
  priority: opsTicketPrioritySchema,
  status: opsTicketStatusSchema,
  assignee: opsTicketActorSchema.nullable(),
  updatedAt: z.string(),
  dueAt: z.string().nullable(),
  isOverdue: z.boolean(),
});
export type OpsTicketListItem = z.infer<typeof opsTicketListItemSchema>;

/** 整张工单：详情、创建与写操作的返回都用它。 */
export const opsTicketSchema = opsTicketListItemSchema.extend({
  description: z.string(),
  issueType: z.string(),
  productId: z.uuid().nullable(),
  contractId: z.uuid().nullable(),
  tenantMappingId: z.uuid().nullable(),
  deploymentInstanceId: z.uuid().nullable(),
  waitingOn: z.string().nullable(),
  resolutionSummary: z.string().nullable(),
  closedAt: z.string().nullable(),
  reopenCount: z.number().int().min(0),
  version: z.number().int().min(1),
  createdAt: z.string(),
});
export type OpsTicket = z.infer<typeof opsTicketSchema>;

/**
 * 时间线事件。`metadata` 用松形状：它按事件类型带不同键（分派带前后负责人，
 * 关联带 refType/refId），固定成一个对象会让新增事件类型变成 breaking change。
 */
export const opsTicketEventSchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  fromStatus: opsTicketStatusSchema.nullable(),
  toStatus: opsTicketStatusSchema.nullable(),
  actor: opsTicketActorSchema.nullable(),
  body: z.string().nullable(),
  waitingOn: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type OpsTicketEvent = z.infer<typeof opsTicketEventSchema>;

export const opsTicketReferenceSchema = z.object({
  refType: opsTicketRefTypeSchema,
  refId: z.uuid(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
});
export type OpsTicketReference = z.infer<typeof opsTicketReferenceSchema>;

/**
 * 列表查询。
 *
 * `createdFrom` / `createdTo` / `unassigned` 三个参数**契约 §5.6 没有**（那里只有
 * `updatedFrom`），是实现补的：列表页的「查看某天进来的单子」与「待分派队列」都
 * 需要它们，而 `assigneeOperatorId` 表达不了「没有负责人」。已登记 C-108 待回写。
 *
 * 日期一律 `YYYY-MM-DD`，按 `Asia/Shanghai` 整天切——`createdTo` 含当天。让调用方
 * 传时刻会把时区判断推回前端，而那正是 §5.6 脚注明令禁止的事。
 */
export const opsTicketListQuerySchema = z.object({
  customerId: z.uuid().optional(),
  status: z.array(opsTicketStatusSchema).optional(),
  priority: z.array(opsTicketPrioritySchema).optional(),
  assigneeOperatorId: z.uuid().optional(),
  productId: z.uuid().optional(),
  updatedFrom: z.iso.date().optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  unassigned: z.coerce.boolean().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  page: pageNumberSchema.default(1),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),
});
export type OpsTicketListQuery = z.infer<typeof opsTicketListQuerySchema>;

/**
 * 创建。
 *
 * `issueType` 只约束长度、不约束取值：契约 §3.6 写的是 `text NOT NULL`，没有词表。
 * 自己编一套会让前端下拉先被实现绑死（见 C-108）。
 */
export const opsTicketCreateRequestSchema = z.strictObject({
  customerId: z.uuid(),
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  issueType: z.string().trim().min(1).max(60),
  priority: opsTicketPrioritySchema,
  productId: z.uuid().optional(),
  contractId: z.uuid().optional(),
  tenantMappingId: z.uuid().optional(),
  deploymentInstanceId: z.uuid().optional(),
});
export type OpsTicketCreateRequest = z.infer<typeof opsTicketCreateRequestSchema>;

/**
 * 编辑。`version` 必填（乐观锁）：两个人同时改优先级，后到的必须看见冲突，
 * 而不是把前一次的改动悄悄覆盖。
 *
 * `status` / `assignee` / `resolution` **不在白名单里**：能改状态的 PATCH 等于给
 * 状态机开后门（契约 §7.4 P13 同一条理由）。`strictObject` 让多传的键直接 400，
 * 而不是被静默忽略——「传了但不生效」比报错更难查。
 */
export const opsTicketUpdateRequestSchema = z.strictObject({
  subject: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  issueType: z.string().trim().min(1).max(60).optional(),
  priority: opsTicketPrioritySchema.optional(),
  version: z.number().int().min(1),
});
export type OpsTicketUpdateRequest = z.infer<typeof opsTicketUpdateRequestSchema>;

export const opsTicketAssignRequestSchema = z.strictObject({
  assigneeOperatorId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().min(1),
});
export type OpsTicketAssignRequest = z.infer<typeof opsTicketAssignRequestSchema>;

/**
 * 状态迁移。
 *
 * 三个条件参数按动作区分必填：`wait` 要 `waitingOn`、`resolve` 要
 * `resolutionSummary`、`reopen` 要 `reason`。这里只约束「传了就有内容」，
 * 按动作的必填判定交给库（它才有当前状态，能说出「这条边不存在」而不是
 * 「你少传了字段」）。
 */
export const opsTicketTransitionRequestSchema = z.strictObject({
  action: opsTicketTransitionActionSchema,
  waitingOn: z.string().trim().min(1).max(200).optional(),
  resolutionSummary: z.string().trim().min(1).max(2000).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  version: z.number().int().min(1),
});
export type OpsTicketTransitionRequest = z.infer<typeof opsTicketTransitionRequestSchema>;

export const opsTicketEventCreateRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(4000),
});
export type OpsTicketEventCreateRequest = z.infer<typeof opsTicketEventCreateRequestSchema>;

export const opsTicketReferenceCreateRequestSchema = z.strictObject({
  refType: opsTicketRefTypeSchema,
  refId: z.uuid(),
});
export type OpsTicketReferenceCreateRequest = z.infer<typeof opsTicketReferenceCreateRequestSchema>;

export const opsTicketListResponseSchema = pagedResponseSchema(opsTicketListItemSchema);
export type OpsTicketListResponse = z.infer<typeof opsTicketListResponseSchema>;

export const opsTicketResponseSchema = z.object({ ticket: opsTicketSchema });
export type OpsTicketResponse = z.infer<typeof opsTicketResponseSchema>;

/** 写操作返回新工单 + 事件 id：前端拿 `event.id` 可以立刻定位刚追加的那条。 */
export const opsTicketWriteResponseSchema = z.object({
  ticket: opsTicketSchema,
  event: z.object({ id: z.uuid() }),
});
export type OpsTicketWriteResponse = z.infer<typeof opsTicketWriteResponseSchema>;

export const opsTicketDetailResponseSchema = z.object({
  ticket: opsTicketSchema,
  timeline: z.array(opsTicketEventSchema),
  references: z.array(opsTicketReferenceSchema),
  /** 当前状态允许的动作；前端按它渲染按钮，不维护状态机副本。 */
  allowedActions: z.array(z.string()),
  assignableOperators: z.array(opsTicketActorSchema),
});
export type OpsTicketDetailResponse = z.infer<typeof opsTicketDetailResponseSchema>;

export const opsTicketTimelineResponseSchema = pagedResponseSchema(opsTicketEventSchema);
export type OpsTicketTimelineResponse = z.infer<typeof opsTicketTimelineResponseSchema>;

/** 可指派成员（创建页用：此时还没有工单可取详情）。 */
export const opsTicketAssignableOperatorsResponseSchema = z.object({
  items: z.array(opsTicketActorSchema),
});
export type OpsTicketAssignableOperatorsResponse = z.infer<
  typeof opsTicketAssignableOperatorsResponseSchema
>;

export const opsTicketEventCreateResponseSchema = z.object({
  event: z.object({ id: z.uuid(), eventType: z.string() }),
});
export type OpsTicketEventCreateResponse = z.infer<typeof opsTicketEventCreateResponseSchema>;

export const opsTicketReferenceCreateResponseSchema = z.object({
  reference: opsTicketReferenceSchema,
});
export type OpsTicketReferenceCreateResponse = z.infer<
  typeof opsTicketReferenceCreateResponseSchema
>;
