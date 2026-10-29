/**
 * 开发态工单桩的**虚构**数据。
 *
 * 硬约束：
 * 1. 全部为虚构客户、虚构工单号、虚构联系人与虚构人名（统一带「（虚构）」后缀），
 *    禁止写入任何真实客户信息与真实姓名；
 * 2. 只在 `VITE_OPS_MOCK=true` 且非生产构建时加载（见 `dev-stub.ts` 的动态 import），
 *    页面同时展示「开发态数据」提示，桩数据绝不冒充真实后端集成；
 * 3. `isOverdue` 在这里是**预先算好的字段**（模拟服务端按 `ticket.dueHours` 判定）：
 *    其中一条刻意构造为「`dueAt` 已过但 `isOverdue=false`」，用于固定
 *    「前端不得用本地时间推断逾期」的口径（源码参考门 §4.2）。
 */
import type {
  TicketAction,
  TicketEventType,
  TicketPriority,
  TicketRefType,
  TicketStatus,
} from './types';

/** 桩会话里的当前运营成员（与 entitlement/billing 桩保持同一 id，便于串联演示）。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

export const STUB_OPERATORS = {
  /** 售后支持·一线（当前登录人常以此身份演示）。 */
  agent: {
    displayName: '售后支持·赵（虚构）',
    id: '00000000-0000-4000-8000-000000000011',
  },
  /** 售后支持·二线，用于演示改派与「分派给我」。 */
  agentB: {
    displayName: '售后支持·钱（虚构）',
    id: '00000000-0000-4000-8000-000000000012',
  },
  /** 售后主管，演示「等待第三方」场景的协作人。 */
  lead: {
    displayName: '售后主管·孙（虚构）',
    id: '00000000-0000-4000-8000-000000000013',
  },
} as const;

/** 联系方式原值用 `*.invalid` / 测试号段，避免任何真实可拨通信息。 */
export const STUB_CUSTOMERS = {
  c1: {
    customerNo: 'KH-2026-000101',
    email: 'finance@example.invalid',
    id: '11111111-1111-4111-8111-111111111301',
    maskedEmail: 'f***@example.invalid',
    maskedPhone: '138****0001',
    name: '示例旅行社甲（虚构）',
    phone: '13800000001',
  },
  c2: {
    customerNo: 'KH-2026-000102',
    email: 'it@example.invalid',
    id: '11111111-1111-4111-8111-111111111302',
    maskedEmail: 'i*@example.invalid',
    maskedPhone: '139****0002',
    name: '示例旅行社乙（虚构）',
    phone: '13900000002',
  },
  c3: {
    customerNo: 'KH-2026-000103',
    email: 'ops@example.invalid',
    id: '11111111-1111-4111-8111-111111111303',
    maskedEmail: 'o**@example.invalid',
    maskedPhone: '137****0003',
    name: '示例旅行社丙（虚构）',
    phone: '13700000003',
  },
} as const;

export const STUB_PRODUCTS = {
  p1: {
    code: 'TRAVEL-SAAS',
    id: '22222222-2222-4222-8222-222222222301',
    name: '旅行社 SaaS 标准版（虚构）',
  },
  p2: {
    code: 'TRAVEL-PRIVATE',
    id: '22222222-2222-4222-8222-222222222302',
    name: '旅行社私有化版（虚构）',
  },
} as const;

/** 桩里的工单行（可变部分由 `dev-stub.ts` 克隆后演进）。 */
export interface StubTicketRow {
  assigneeOperatorId: null | string;
  closedAt?: null | string;
  contractId?: null | string;
  createdAt: string;
  customerId: keyof typeof STUB_CUSTOMERS;
  deploymentInstanceId?: null | string;
  description: string;
  dueAt?: null | string;
  id: string;
  /** 服务端派生字段（见文件头第 3 条）：**不是**前端算的。 */
  isOverdue: boolean;
  issueType: string;
  priority: TicketPriority;
  productId?: null | string;
  reopenCount: number;
  resolutionSummary?: null | string;
  status: TicketStatus;
  subject: string;
  tenantMappingId?: null | string;
  ticketNo: string;
  updatedAt: string;
  version: number;
  waitingOn?: null | string;
}

export interface StubEventRow {
  actorId: string;
  body?: null | string;
  createdAt: string;
  eventType: TicketEventType;
  fromStatus?: null | TicketStatus;
  id: string;
  metadata?: Record<string, unknown>;
  ticketId: string;
  toStatus?: null | TicketStatus;
  waitingOn?: null | string;
}

export interface StubReferenceRow {
  createdAt: string;
  createdBy: string;
  refId: string;
  refLabel?: null | string;
  refType: TicketRefType;
  ticketId: string;
}

export const STUB_TICKET_IDS = {
  closed: '55555555-5555-4555-8555-555555555505',
  inProgress: '55555555-5555-4555-8555-555555555501',
  newUnassigned: '55555555-5555-4555-8555-555555555506',
  resolved: '55555555-5555-4555-8555-555555555504',
  urgentOverdue: '55555555-5555-4555-8555-555555555502',
  waiting: '55555555-5555-4555-8555-555555555503',
} as const;

export const STUB_TICKETS: StubTicketRow[] = [
  {
    assigneeOperatorId: STUB_OPERATORS.agent.id,
    contractId: '33333333-3333-4333-8333-333333333301',
    createdAt: '2026-10-21T01:20:00Z',
    customerId: 'c1',
    description:
      '客户财务来函要求把已开票的抬头由「示例旅行社甲（虚构）」改为「示例旅行社甲·华东分公司（虚构）」，需要确认合同签约主体是否一致。',
    dueAt: '2026-10-30T09:00:00Z',
    id: STUB_TICKET_IDS.inProgress,
    isOverdue: false,
    issueType: '合同/授权咨询',
    priority: 'normal',
    productId: STUB_PRODUCTS.p1.id,
    reopenCount: 0,
    status: 'in_progress',
    subject: '示例旅行社甲·发票抬头修改',
    ticketNo: 'TK-2026-000101',
    updatedAt: '2026-10-28T06:10:00Z',
    version: 4,
  },
  {
    assigneeOperatorId: STUB_OPERATORS.agentB.id,
    createdAt: '2026-10-25T02:00:00Z',
    customerId: 'c2',
    description:
      '客户反馈开通后所有账号无法登录，前端提示「租户未激活」。已确认租户映射状态为 provisioning，需要与同步命令结果核对。',
    dueAt: '2026-10-27T02:00:00Z',
    id: STUB_TICKET_IDS.urgentOverdue,
    isOverdue: true,
    issueType: '数据/权限问题',
    priority: 'urgent',
    productId: STUB_PRODUCTS.p1.id,
    reopenCount: 0,
    status: 'assigned',
    subject: '示例旅行社乙·租户开通后无法登录',
    tenantMappingId: '66666666-6666-4666-8666-666666666301',
    ticketNo: 'TK-2026-000102',
    updatedAt: '2026-10-27T03:30:00Z',
    version: 2,
  },
  {
    assigneeOperatorId: STUB_OPERATORS.lead.id,
    createdAt: '2026-10-20T07:40:00Z',
    customerId: 'c3',
    deploymentInstanceId: '77777777-7777-4777-8777-777777777301',
    description:
      '升级到 3.4.1 后报表导出报错「列名不存在」。已请客户提供导出模板与报错截图，等待回复。',
    dueAt: '2026-11-02T10:00:00Z',
    id: STUB_TICKET_IDS.waiting,
    isOverdue: false,
    issueType: '部署/升级问题',
    priority: 'high',
    productId: STUB_PRODUCTS.p2.id,
    reopenCount: 0,
    status: 'waiting',
    subject: '示例旅行社丙·升级后报表导出报错',
    ticketNo: 'TK-2026-000103',
    updatedAt: '2026-10-26T09:15:00Z',
    version: 3,
    waitingOn: '等待客户提供导出模板与报错截图',
  },
  {
    assigneeOperatorId: STUB_OPERATORS.agent.id,
    contractId: '33333333-3333-4333-8333-333333333302',
    createdAt: '2026-10-18T03:00:00Z',
    customerId: 'c1',
    description: '客户咨询续约后新增的 5 个坐席是否需要单独下单授权。',
    dueAt: '2026-10-29T10:00:00Z',
    id: STUB_TICKET_IDS.resolved,
    isOverdue: false,
    issueType: '合同/授权咨询',
    priority: 'low',
    productId: STUB_PRODUCTS.p1.id,
    reopenCount: 0,
    resolutionSummary:
      '已确认坐席随订阅数量变更走授权变更申请（extend），无需单独下单；客户已确认。',
    status: 'resolved',
    subject: '示例旅行社甲·续约新增坐席是否需单独授权',
    ticketNo: 'TK-2026-000104',
    updatedAt: '2026-10-24T08:00:00Z',
    version: 5,
  },
  {
    assigneeOperatorId: STUB_OPERATORS.agentB.id,
    closedAt: '2026-10-23T09:00:00Z',
    contractId: '33333333-3333-4333-8333-333333333303',
    createdAt: '2026-10-12T01:00:00Z',
    customerId: 'c3',
    description: '客户要求把 9 月发票作废后重开为 10 月账期。',
    dueAt: '2026-10-20T09:00:00Z',
    id: STUB_TICKET_IDS.closed,
    isOverdue: false,
    issueType: '使用咨询',
    priority: 'normal',
    productId: STUB_PRODUCTS.p1.id,
    reopenCount: 1,
    resolutionSummary: '已作废原发票并按 10 月账期重开，客户财务确认收到。',
    status: 'closed',
    subject: '示例旅行社丙·发票作废重开',
    ticketNo: 'TK-2026-000105',
    updatedAt: '2026-10-23T09:00:00Z',
    version: 7,
  },
  {
    assigneeOperatorId: null,
    createdAt: '2026-10-28T02:30:00Z',
    customerId: 'c2',
    description:
      '客户询问能否导出全年订单明细用于年度对账，需要确认导出范围与数据保留策略。',
    dueAt: '2026-11-04T09:00:00Z',
    id: STUB_TICKET_IDS.newUnassigned,
    isOverdue: false,
    issueType: '使用咨询',
    priority: 'normal',
    productId: STUB_PRODUCTS.p1.id,
    reopenCount: 0,
    status: 'new',
    subject: '示例旅行社乙·年度订单明细导出咨询',
    ticketNo: 'TK-2026-000106',
    updatedAt: '2026-10-28T02:30:00Z',
    version: 1,
  },
];

/**
 * 时间线事件（只增不改）。
 *
 * 覆盖全部七种 `event_type`，其中 `comment` 含「内部说明」与「对客沟通摘要」两类，
 * 用于验证时间线能一眼看出「谁、在什么时候、因为什么把状态改成了什么」。
 */
export const STUB_EVENTS: StubEventRow[] = [
  // ---- TK-2026-000101：创建 → 分派 → 开始处理 → 备注
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '客户财务来函要求修改发票抬头，已核对合同签约主体。',
    createdAt: '2026-10-21T01:20:00Z',
    eventType: 'created',
    id: 'evt-101-1',
    ticketId: STUB_TICKET_IDS.inProgress,
    toStatus: 'new',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '按区域分工分派给一线支持',
    createdAt: '2026-10-21T02:05:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'evt-101-2',
    ticketId: STUB_TICKET_IDS.inProgress,
    toStatus: 'assigned',
  },
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '开始处理：已向客户索取加盖公章的抬头变更说明',
    createdAt: '2026-10-22T01:10:00Z',
    eventType: 'status_changed',
    fromStatus: 'assigned',
    id: 'evt-101-3',
    ticketId: STUB_TICKET_IDS.inProgress,
    toStatus: 'in_progress',
  },
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '内部说明：抬头变更涉及签约主体，需法务确认后再开票，暂不承诺时间。',
    createdAt: '2026-10-28T06:10:00Z',
    eventType: 'comment',
    id: 'evt-101-4',
    ticketId: STUB_TICKET_IDS.inProgress,
  },

  // ---- TK-2026-000102：创建 → 分派（超时未响应示例）
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '客户反馈登录失败，暂未定位，先建单。',
    createdAt: '2026-10-25T02:00:00Z',
    eventType: 'created',
    id: 'evt-102-1',
    ticketId: STUB_TICKET_IDS.urgentOverdue,
    toStatus: 'new',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '紧急件，分派给二线并同步值班群',
    createdAt: '2026-10-25T03:30:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'evt-102-2',
    ticketId: STUB_TICKET_IDS.urgentOverdue,
    toStatus: 'assigned',
  },
  {
    actorId: STUB_OPERATORS.agentB.id,
    body: '对客沟通摘要：已告知客户正在核查租户激活命令，承诺今日内给结论。',
    createdAt: '2026-10-27T03:30:00Z',
    eventType: 'comment',
    id: 'evt-102-3',
    ticketId: STUB_TICKET_IDS.urgentOverdue,
  },

  // ---- TK-2026-000103：创建 → 分派 → 开始 → 等待（含 waitingOn）
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '客户升级后导出报错。',
    createdAt: '2026-10-20T07:40:00Z',
    eventType: 'created',
    id: 'evt-103-1',
    ticketId: STUB_TICKET_IDS.waiting,
    toStatus: 'new',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '分派给主管跟进',
    createdAt: '2026-10-20T08:00:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'evt-103-2',
    ticketId: STUB_TICKET_IDS.waiting,
    toStatus: 'assigned',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '已复现，初步判断与导出模板列名有关',
    createdAt: '2026-10-21T02:00:00Z',
    eventType: 'status_changed',
    fromStatus: 'assigned',
    id: 'evt-103-3',
    ticketId: STUB_TICKET_IDS.waiting,
    toStatus: 'in_progress',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '已请客户提供导出模板与报错截图',
    createdAt: '2026-10-26T09:15:00Z',
    eventType: 'status_changed',
    fromStatus: 'in_progress',
    id: 'evt-103-4',
    ticketId: STUB_TICKET_IDS.waiting,
    toStatus: 'waiting',
    waitingOn: '等待客户提供导出模板与报错截图',
  },

  // ---- TK-2026-000104：创建 → 分派 → 解决
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '客户咨询续约新增坐席的授权方式。',
    createdAt: '2026-10-18T03:00:00Z',
    eventType: 'created',
    id: 'evt-104-1',
    ticketId: STUB_TICKET_IDS.resolved,
    toStatus: 'new',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '分派给一线支持',
    createdAt: '2026-10-18T03:20:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'evt-104-2',
    ticketId: STUB_TICKET_IDS.resolved,
    toStatus: 'assigned',
  },
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '已确认坐席随订阅数量变更走授权变更申请，无需单独下单。',
    createdAt: '2026-10-24T08:00:00Z',
    eventType: 'status_changed',
    fromStatus: 'assigned',
    id: 'evt-104-3',
    metadata: {
      reason: '已与客户确认处理结论，等待客户回复后关闭',
      resolutionSummary:
        '已确认坐席随订阅数量变更走授权变更申请（extend），无需单独下单；客户已确认。',
    },
    ticketId: STUB_TICKET_IDS.resolved,
    toStatus: 'resolved',
  },

  // ---- TK-2026-000105：创建 → 分派 → 解决 → 关闭 → 重开 → 关闭（含 reopened）
  {
    actorId: STUB_OPERATORS.agentB.id,
    body: '客户要求作废 9 月发票并重开。',
    createdAt: '2026-10-12T01:00:00Z',
    eventType: 'created',
    id: 'evt-105-1',
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'new',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '分派给二线支持',
    createdAt: '2026-10-12T02:00:00Z',
    eventType: 'assigned',
    fromStatus: 'new',
    id: 'evt-105-2',
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'assigned',
  },
  {
    actorId: STUB_OPERATORS.agentB.id,
    body: '已与财务确认作废流程。',
    createdAt: '2026-10-20T03:00:00Z',
    eventType: 'status_changed',
    fromStatus: 'assigned',
    id: 'evt-105-3',
    metadata: { resolutionSummary: '已作废原发票，等待重开' },
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'resolved',
  },
  {
    actorId: STUB_OPERATORS.agentB.id,
    body: '客户财务确认收到重开发票',
    createdAt: '2026-10-21T09:00:00Z',
    eventType: 'closed',
    fromStatus: 'resolved',
    id: 'evt-105-4',
    metadata: { reason: '客户确认已收到重开发票，本单结束' },
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'closed',
  },
  {
    actorId: STUB_OPERATORS.lead.id,
    body: '客户反馈发票金额币种录入有误，需重新处理',
    createdAt: '2026-10-23T08:00:00Z',
    eventType: 'reopened',
    fromStatus: 'closed',
    id: 'evt-105-5',
    metadata: { reason: '客户反馈重开发票币种有误，需重新处理' },
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'in_progress',
  },
  {
    actorId: STUB_OPERATORS.agentB.id,
    body: '已按 CNY 重新开具并客户确认',
    createdAt: '2026-10-23T09:00:00Z',
    eventType: 'closed',
    fromStatus: 'in_progress',
    id: 'evt-105-6',
    metadata: { reason: '重新开具完成，客户财务确认' },
    ticketId: STUB_TICKET_IDS.closed,
    toStatus: 'closed',
  },

  // ---- TK-2026-000106：仅创建（未分派）
  {
    actorId: STUB_OPERATORS.agent.id,
    body: '客户咨询年度订单明细导出范围。',
    createdAt: '2026-10-28T02:30:00Z',
    eventType: 'created',
    id: 'evt-106-1',
    ticketId: STUB_TICKET_IDS.newUnassigned,
    toStatus: 'new',
  },
];

export const STUB_REFERENCES: StubReferenceRow[] = [
  {
    createdAt: '2026-10-25T02:10:00Z',
    createdBy: STUB_OPERATORS.lead.id,
    refId: '88888888-8888-4888-8888-888888888801',
    refLabel: '开通命令 TC-2026-000231（示例旅行社乙）',
    refType: 'tenant_command',
    ticketId: STUB_TICKET_IDS.urgentOverdue,
  },
  {
    createdAt: '2026-10-20T08:30:00Z',
    createdBy: STUB_OPERATORS.lead.id,
    refId: '99999999-9999-4999-8999-999999999901',
    refLabel: '升级记录 3.4.0 → 3.4.1（示例旅行社丙）',
    refType: 'deployment_version',
    ticketId: STUB_TICKET_IDS.waiting,
  },
];

/** 桩支持的流转动作全集（与 `rules.ts` 的动作名一致）。 */
export const STUB_TRANSITION_ACTIONS: readonly Exclude<
  TicketAction,
  'assign'
>[] = ['start', 'wait', 'resume', 'resolve', 'close', 'reopen'];
