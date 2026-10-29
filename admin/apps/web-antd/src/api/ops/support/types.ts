/**
 * 售后工单域类型（support）。
 *
 * 真源：`Docs/ops-api-contract.md` §3.8（表/状态机/约束）与 §5.8（端点）。
 * 规则：
 * 1. 字段名严格照抄契约（`ticket_no` → `ticketNo`、`waiting_on` → `waitingOn`…），
 *    状态与优先级枚举逐字对齐 §3.8 的 `CHECK`。契约没有的枚举一律不发明。
 * 2. 契约未给出的形态显式标注「契约推导」并带 `?`：页面按缺失降级，不假装有值。
 * 3. **逾期不由前端计算**：`isOverdue` 是服务端派生字段（源码参考门 §4.2），缺失时
 *    页面不显示逾期标识，绝不用 `dueAt` 与本地时钟比较（见 `format.ts` 的
 *    `ticketOverdueView`）。
 */

/** 工单状态（契约 §3.8 状态机；与 PRD §8 同一枚举）。 */
export type TicketStatus =
  | 'assigned'
  | 'closed'
  | 'in_progress'
  | 'new'
  | 'resolved'
  | 'waiting';

/** 优先级（契约 §3.8 `CHECK(priority IN ('urgent','high','normal','low'))`）。 */
export type TicketPriority = 'high' | 'low' | 'normal' | 'urgent';

/**
 * 状态流转动作。
 *
 * `start`/`wait`/`resume`/`resolve`/`close`/`reopen` 走 `POST /tickets/{id}/transition`；
 * `assign` 走独立端点 `POST /tickets/{id}/assign`（契约 §5.8 两行分开列）。
 */
export type TicketAction =
  | 'assign'
  | 'close'
  | 'reopen'
  | 'resolve'
  | 'resume'
  | 'start'
  | 'wait';

/** 时间线事件类型（契约 §3.8 `ops.ticket_events.event_type`，七个值，不得增删）。 */
export type TicketEventType =
  | 'assigned'
  | 'closed'
  | 'comment'
  | 'created'
  | 'linked'
  | 'reopened'
  | 'status_changed';

/** 关联引用类型（契约 §3.8 `ops.ticket_references.ref_type`）。 */
export type TicketRefType =
  | 'deployment_version'
  | 'entitlement_change'
  | 'tenant_command';

/** 分页查询公共参数（契约 §2.4）。 */
export interface TicketListSort {
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'priority' | 'ticketNo' | 'updatedAt';
}

/** 分页响应公共形态（契约 §2.4 `{items,total,page,pageSize}`）。 */
export interface TicketPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** 操作者引用：列表/详情可能只给 id，也可能内嵌姓名，两种都要能渲染。 */
export type TicketActorRef = string | { displayName?: string; id: string };

/** 客户引用（契约 §5.8 列表/详情内嵌 `customer{...}`）。 */
export interface TicketCustomerRef {
  customerNo?: string;
  /** 联系方式原值：仅当后端判定具备 `customer.sensitive.read` 时下发。 */
  email?: null | string;
  id: string;
  maskedEmail?: null | string;
  maskedPhone?: null | string;
  name: string;
  phone?: null | string;
}

/** 产品引用（工单可关联产品，契约 §3.8 `product_id`）。 */
export interface TicketProductRef {
  code?: string;
  id: string;
  name: string;
}

/** 分派对象（契约 §5.8 `assignee{...}`）。 */
export interface TicketAssigneeRef {
  displayName?: string;
  id: string;
}

/** 工单（契约 §3.8 `ops.tickets` + §5.8 详情 `ticket{...}`）。 */
export interface Ticket {
  assignee?: null | TicketAssigneeRef;
  assigneeOperatorId?: null | string;
  closedAt?: null | string;
  contractId?: null | string;
  createdAt?: string;
  customer: TicketCustomerRef;
  deploymentInstanceId?: null | string;
  description: string;
  dueAt?: null | string;
  id: string;
  /**
   * 是否逾期：**服务端派生字段**（契约推导，见 journal U-07）。
   * §5.8 的列表响应字段未列它，因此在后端补字段前页面按「未返回」降级：
   * 不显示逾期徽标，也**不**用 `dueAt` 自算（源码参考门 §4.2 硬禁令）。
   */
  isOverdue?: boolean;
  issueType: string;
  priority: TicketPriority;
  product?: null | TicketProductRef;
  reopenCount?: number;
  resolutionSummary?: null | string;
  status: TicketStatus;
  subject: string;
  tenantMappingId?: null | string;
  ticketNo: string;
  updatedAt?: string;
  /** 乐观锁版本：分派/流转/编辑都必须回传。 */
  version?: number;
  waitingOn?: null | string;
}

/** 列表行（契约 §5.8 `GET /tickets` → `items[]`）。 */
export interface TicketListItem {
  assignee?: null | TicketAssigneeRef;
  customer: TicketCustomerRef;
  dueAt?: null | string;
  id: string;
  /** 同上：服务端派生，缺失即降级（契约推导 U-07）。 */
  isOverdue?: boolean;
  priority: TicketPriority;
  status: TicketStatus;
  subject: string;
  ticketNo: string;
  updatedAt: string;
}

/** 列表查询参数（契约 §5.8 + §2.4 分页）。 */
export interface TicketListQuery extends TicketListSort {
  assigneeOperatorId?: string;
  /**
   * 创建时间下界（契约推导 U-07）：§5.8 只列了 `updatedFrom`，
   * 任务书要求「创建时间区间」。后端确认前该参数可能被忽略。
   */
  createdFrom?: string;
  /** 创建时间上界（契约推导 U-07）。 */
  createdTo?: string;
  customerId?: string;
  /** 仅看已逾期：由服务端按内部工作时限判定（`overdueOnly`）。 */
  overdueOnly?: boolean;
  priority?: TicketPriority[];
  productId?: string;
  status?: TicketStatus[];
  /** 未分派筛选（契约推导 U-07：§5.8 只有 `assigneeOperatorId`）。 */
  unassigned?: boolean;
  /** 更新时间下界（契约 §5.8 `updatedFrom`，PRD §6.9「按更新时间筛选」）。 */
  updatedFrom?: string;
}

export type TicketListResult = TicketPagedResult<TicketListItem>;

/** 时间线事件（契约 §3.8 `ops.ticket_events`，仅 INSERT）。 */
export interface TicketEvent {
  actor: TicketActorRef;
  body?: null | string;
  createdAt: string;
  eventType: TicketEventType;
  fromStatus?: null | TicketStatus;
  id: string;
  /** `jsonb`，契约未定义结构；原因按 `metadata.reason` 读取（见 `eventReason`）。 */
  metadata?: Record<string, unknown>;
  /**
   * 原因（契约推导）：`ops.ticket_events` 没有 `reason` 列，
   * 终态原因可能落在 `metadata.reason` 或 `body`，由 `eventReason()` 统一取值。
   */
  reason?: null | string;
  toStatus?: null | TicketStatus;
  waitingOn?: null | string;
}

/** 关联引用（契约 §3.8 `ops.ticket_references`，仅 INSERT）。 */
export interface TicketReference {
  createdAt?: string;
  createdBy?: TicketActorRef;
  refId: string;
  refType: TicketRefType;
  /** 展示用摘要（契约推导：引用对象标题需服务端回填，缺失时只显示 id）。 */
  refLabel?: null | string;
}

/**
 * 工单详情（契约 §5.8 `GET /tickets/{ticketId}`）。
 *
 * `allowedActions` 由服务端给出（非法迁移 409 时同名字段也会回传），前端据此与
 * 本地状态机取交集，避免渲染后端不认的动作。
 */
export interface TicketDetail {
  allowedActions?: string[];
  /** 可被分派的人（契约推导 U-08：`GET /operators` 需 operator.read，售后角色无该权限）。 */
  assignableOperators?: TicketAssigneeRef[];
  references?: TicketReference[];
  ticket: Ticket;
  timeline?: TicketEvent[];
}

export interface CreateTicketInput {
  contractId?: string;
  customerId: string;
  deploymentInstanceId?: string;
  description: string;
  issueType: string;
  priority: TicketPriority;
  productId?: string;
  subject: string;
  tenantMappingId?: string;
}

export interface CreateTicketResult {
  ticket: Ticket;
}

/** 编辑字段（契约 §5.8 `PATCH /tickets/{ticketId}`：不含状态与指派人）。 */
export interface UpdateTicketInput {
  description?: string;
  issueType?: string;
  priority?: TicketPriority;
  subject?: string;
  version: number;
}

export interface UpdateTicketResult {
  ticket: Ticket;
}

/** 分派（契约 §5.8 `POST /tickets/{ticketId}/assign`）。 */
export interface AssignTicketInput {
  assigneeOperatorId: string;
  /** 改派原因（选填；服务端会写 `assigned` 事件的 body/metadata）。 */
  reason?: string;
  version: number;
}

/** 状态流转（契约 §5.8 `POST /tickets/{ticketId}/transition`）。 */
export interface TicketTransitionInput {
  action: Exclude<TicketAction, 'assign'>;
  /** 终态（关闭）与重开必填；其余动作选填（见 `rules.ts` 的前置守卫）。 */
  reason?: string;
  /** `resolve` 必填（契约 §3.8 守卫）。 */
  resolutionSummary?: string;
  version: number;
  /** `wait` 必填（契约 §3.8 守卫）。 */
  waitingOn?: string;
}

export interface TicketMutationResult {
  event: { id: string };
  ticket: {
    /** 服务端在 409 时也会带当前可用动作（契约 §6.3）。 */
    allowedActions?: string[];
  } & Ticket;
}

/** 时间线查询（契约 §5.8 `GET /tickets/{ticketId}/timeline`）。 */
export interface TicketTimelineQuery {
  page?: number;
  pageSize?: number;
}

export interface TicketTimelineResult {
  items: TicketEvent[];
  page?: number;
  pageSize?: number;
  total?: number;
}

/** 追加备注（契约 §5.8 `POST /tickets/{ticketId}/events`，eventType 固定 `comment`）。 */
export interface AddTicketCommentInput {
  body: string;
}

export interface AddTicketCommentResult {
  event: TicketEvent;
}

/** 追加关联（契约 §5.8 `POST /tickets/{ticketId}/references`）。 */
export interface AddTicketReferenceInput {
  refId: string;
  refType: TicketRefType;
}

export interface AddTicketReferenceResult {
  reference: TicketReference;
}
