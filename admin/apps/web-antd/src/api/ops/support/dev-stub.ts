/**
 * 开发态工单契约桩（仅在 `VITE_OPS_MOCK=true` 的非生产构建里被动态加载）。
 *
 * 目的：在 `udone` 的 ops support API 尚未交付时，页面可以走通全部状态
 * （loading / empty / error / validation / permission / conflict / destructive-confirm），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端不变量，否则前端会在假的成功里漏掉真实错误分支：
 * - 非法迁移 → 409 `STATE_CONFLICT` + `details.allowedActions`（契约 §3.8）；
 * - `version` 不匹配 → 409 `CONFLICT`（他人已流转，前端必须刷新）；
 * - `wait` 缺 `waitingOn`、`resolve` 缺 `resolutionSummary`、`close`/`reopen` 缺 `reason`
 *   → 400 `VALIDATION_ERROR`（契约 §3.8 守卫 + 源码参考门 §4.1）；
 * - `closed` 不可直接分派、不可追加备注 → 409 `STATE_CONFLICT`（契约 §5.8）；
 * - 重复关联同一对象 → 409 `CONFLICT`（契约 §5.8）；
 * - 时间线**只追加**：任何流转都新增事件，历史事件对象不被改写。
 *
 * 注意：桩**不**根据 `dueAt` 重新计算 `isOverdue`——它只透传夹具里预先算好的值，
 * 以此模拟「服务端派生字段」的口径（源码参考门 §4.2 硬禁令）。
 */
import type { StubEventRow, StubReferenceRow, StubTicketRow } from './fixtures';
import type {
  AddTicketCommentInput,
  AddTicketCommentResult,
  AddTicketReferenceInput,
  AddTicketReferenceResult,
  AssignTicketInput,
  CreateTicketInput,
  CreateTicketResult,
  Ticket,
  TicketAssigneeRef,
  TicketCustomerRef,
  TicketDetail,
  TicketEvent,
  TicketListQuery,
  TicketListResult,
  TicketMutationResult,
  TicketProductRef,
  TicketTimelineQuery,
  TicketTimelineResult,
  TicketTransitionInput,
  UpdateTicketInput,
  UpdateTicketResult,
} from './types';

import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_CURRENT_OPERATOR_ID,
  STUB_CUSTOMERS,
  STUB_EVENTS,
  STUB_OPERATORS,
  STUB_PRODUCTS,
  STUB_REFERENCES,
  STUB_TICKETS,
} from './fixtures';

const STUB_LATENCY_MS = 120;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);
const STUB_BASE_TIME = '2026-10-29T09:00:00Z';

interface StubState {
  events: StubEventRow[];
  references: StubReferenceRow[];
  sequence: number;
  tickets: StubTicketRow[];
  /** 每次写操作推进 1 分钟，保证新事件排在历史之后（不依赖本机时钟）。 */
  tick: number;
}

function cloneState(): StubState {
  return {
    events: STUB_EVENTS.map((row) => ({
      ...row,
      metadata: row.metadata ? { ...row.metadata } : undefined,
    })),
    references: STUB_REFERENCES.map((row) => ({ ...row })),
    sequence: 200,
    tickets: STUB_TICKETS.map((row) => ({ ...row })),
    tick: 0,
  };
}

let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubSupportState(): void {
  state = cloneState();
}

function nextTime(): string {
  state.tick += 1;
  return new Date(
    Date.parse(STUB_BASE_TIME) + state.tick * 60_000,
  ).toISOString();
}

function respond<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

function fail(options: {
  code: string;
  details?: Record<string, unknown>;
  message?: string;
  reason?: string;
  status: number;
}): never {
  throw new OpsApiError({
    code: options.code,
    details: options.details,
    kind: 'http',
    raw: undefined,
    reason: options.reason,
    requestId: 'stub-request',
    retryable: false,
    status: options.status,
    userMessage: resolveUserMessage(options.code, options.reason),
  });
}

/** 桩的服务端视图：当前状态允许的动作（独立于前端 `rules.ts` 的第二实现）。 */
function serverAllowedActions(status: string): string[] {
  switch (status) {
    case 'assigned': {
      return ['start'];
    }
    case 'closed': {
      return ['reopen'];
    }
    case 'in_progress': {
      return ['wait', 'resolve'];
    }
    case 'new': {
      return ['assign'];
    }
    case 'resolved': {
      return ['close', 'reopen'];
    }
    case 'waiting': {
      return ['resume', 'resolve'];
    }
    default: {
      return [];
    }
  }
}

/** 流转动作 → 时间线事件类型（契约 §3.8 `event_type` 七个值）。 */
function transitionEventType(
  action: TicketTransitionInput['action'],
): StubEventRow['eventType'] {
  if (action === 'close') {
    return 'closed';
  }
  if (action === 'reopen') {
    return 'reopened';
  }
  return 'status_changed';
}

function paginate<T>(items: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
  const safeSize = PAGE_SIZE_WHITELIST.has(Number(pageSize))
    ? Number(pageSize)
    : DEFAULT_PAGE_SIZE;
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: items.length,
  };
}

function customerRef(customerId: string): TicketCustomerRef {
  const customer =
    STUB_CUSTOMERS[customerId as keyof typeof STUB_CUSTOMERS] ??
    STUB_CUSTOMERS.c1;
  return { ...customer };
}

/** 客户 uuid → 夹具键；找不到返回 null（由调用方决定 404 还是忽略）。 */
function customerKeyOf(customerId: string): keyof typeof STUB_CUSTOMERS | null {
  const entry = Object.entries(STUB_CUSTOMERS).find(
    ([, value]) => value.id === customerId,
  );
  return entry ? (entry[0] as keyof typeof STUB_CUSTOMERS) : null;
}

function productRef(
  productId: null | string | undefined,
): null | TicketProductRef {
  if (!productId) {
    return null;
  }
  const product =
    Object.values(STUB_PRODUCTS).find((item) => item.id === productId) ?? null;
  return product ? { ...product } : null;
}

function operatorRef(
  operatorId: null | string | undefined,
): null | TicketAssigneeRef {
  if (!operatorId) {
    return null;
  }
  const operator =
    Object.values(STUB_OPERATORS).find((item) => item.id === operatorId) ??
    null;
  return operator
    ? { id: operator.id, displayName: operator.displayName }
    : null;
}

function eventActorName(actorId: string): string {
  const operator = Object.values(STUB_OPERATORS).find(
    (item) => item.id === actorId,
  );
  return operator?.displayName ?? actorId;
}

function toTicket(row: StubTicketRow): Ticket {
  const ticket: Ticket = {
    assignee: operatorRef(row.assigneeOperatorId),
    assigneeOperatorId: row.assigneeOperatorId,
    createdAt: row.createdAt,
    customer: customerRef(row.customerId),
    description: row.description,
    dueAt: row.dueAt ?? null,
    id: row.id,
    isOverdue: row.isOverdue,
    issueType: row.issueType,
    priority: row.priority,
    product: productRef(row.productId),
    reopenCount: row.reopenCount,
    status: row.status,
    subject: row.subject,
    ticketNo: row.ticketNo,
    updatedAt: row.updatedAt,
    version: row.version,
  };
  if (row.closedAt) {
    ticket.closedAt = row.closedAt;
  }
  if (row.contractId) {
    ticket.contractId = row.contractId;
  }
  if (row.deploymentInstanceId) {
    ticket.deploymentInstanceId = row.deploymentInstanceId;
  }
  if (row.resolutionSummary) {
    ticket.resolutionSummary = row.resolutionSummary;
  }
  if (row.tenantMappingId) {
    ticket.tenantMappingId = row.tenantMappingId;
  }
  if (row.waitingOn) {
    ticket.waitingOn = row.waitingOn;
  }
  return ticket;
}

function toEvent(row: StubEventRow): TicketEvent {
  const event: TicketEvent = {
    actor: { displayName: eventActorName(row.actorId), id: row.actorId },
    createdAt: row.createdAt,
    eventType: row.eventType,
    id: row.id,
    metadata: row.metadata ? { ...row.metadata } : undefined,
  };
  if (row.body) {
    event.body = row.body;
  }
  if (row.fromStatus) {
    event.fromStatus = row.fromStatus;
  }
  if (row.toStatus) {
    event.toStatus = row.toStatus;
  }
  if (row.waitingOn) {
    event.waitingOn = row.waitingOn;
  }
  return event;
}

function ticketRowById(ticketId: string): StubTicketRow {
  const row = state.tickets.find((item) => item.id === ticketId);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

function assertVersion(row: StubTicketRow, version: number | undefined): void {
  if (version === undefined || version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
}

function appendEvent(
  row: StubTicketRow,
  input: {
    body?: string;
    eventType: StubEventRow['eventType'];
    fromStatus?: StubTicketRow['status'];
    metadata?: Record<string, unknown>;
    toStatus?: StubTicketRow['status'];
    waitingOn?: string;
  },
): StubEventRow {
  const event: StubEventRow = {
    actorId: STUB_CURRENT_OPERATOR_ID,
    body: input.body ?? null,
    createdAt: nextTime(),
    eventType: input.eventType,
    fromStatus: input.fromStatus ?? null,
    id: `evt-stub-${String(state.sequence).padStart(4, '0')}`,
    metadata: input.metadata,
    ticketId: row.id,
    toStatus: input.toStatus ?? null,
    waitingOn: input.waitingOn ?? null,
  };
  state.sequence += 1;
  state.events.push(event);
  return event;
}

function matchesStatus(row: StubTicketRow, query: TicketListQuery): boolean {
  if (!query.status || query.status.length === 0) {
    return true;
  }
  return query.status.includes(row.status);
}

function matchesPriority(row: StubTicketRow, query: TicketListQuery): boolean {
  if (!query.priority || query.priority.length === 0) {
    return true;
  }
  return query.priority.includes(row.priority);
}

function matches(query: TicketListQuery): StubTicketRow[] {
  return state.tickets.filter((row) => {
    if (
      query.customerId &&
      STUB_CUSTOMERS[row.customerId].id !== query.customerId
    ) {
      return false;
    }
    if (query.productId && row.productId !== query.productId) {
      return false;
    }
    if (
      query.assigneeOperatorId &&
      row.assigneeOperatorId !== query.assigneeOperatorId
    ) {
      return false;
    }
    if (query.unassigned && row.assigneeOperatorId) {
      return false;
    }
    if (query.overdueOnly && !row.isOverdue) {
      return false;
    }
    if (query.updatedFrom && row.updatedAt < query.updatedFrom) {
      return false;
    }
    // `createdFrom`/`createdTo` 为推导参数（契约 §5.8 未列），桩按字面语义实现，
    // 便于前端在联调前验证筛选交互。
    if (query.createdFrom && row.createdAt < query.createdFrom) {
      return false;
    }
    if (query.createdTo && row.createdAt > query.createdTo) {
      return false;
    }
    return matchesStatus(row, query) && matchesPriority(row, query);
  });
}

function sortRows(
  rows: StubTicketRow[],
  query: TicketListQuery,
): StubTicketRow[] {
  const order = query.order ?? 'desc';
  const sort = query.sort ?? 'updatedAt';
  const direction = order === 'asc' ? 1 : -1;
  return rows.toSorted((left, right) => {
    if (sort === 'ticketNo') {
      return left.ticketNo.localeCompare(right.ticketNo) * direction;
    }
    if (sort === 'priority') {
      const rank = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
      return (rank[left.priority] - rank[right.priority]) * direction;
    }
    if (sort === 'createdAt') {
      return left.createdAt.localeCompare(right.createdAt) * direction;
    }
    return left.updatedAt.localeCompare(right.updatedAt) * direction;
  });
}

export async function stubListTickets(
  query: TicketListQuery = {},
): Promise<TicketListResult> {
  const rows = sortRows(matches(query), query);
  const page = paginate(rows, query.page, query.pageSize);

  return respond({
    items: page.items.map((row) => {
      const customer = customerRef(row.customerId);
      return {
        assignee: operatorRef(row.assigneeOperatorId),
        // 列表只返回掩码：原值需 `customer.sensitive.read`，由详情接口按权限判定。
        customer: {
          customerNo: customer.customerNo,
          id: customer.id,
          maskedEmail: customer.maskedEmail,
          maskedPhone: customer.maskedPhone,
          name: customer.name,
        },
        dueAt: row.dueAt ?? null,
        id: row.id,
        isOverdue: row.isOverdue,
        priority: row.priority,
        status: row.status,
        subject: row.subject,
        ticketNo: row.ticketNo,
        updatedAt: row.updatedAt,
      };
    }),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
  });
}

export async function stubGetTicket(ticketId: string): Promise<TicketDetail> {
  const row = ticketRowById(ticketId);
  const timeline = state.events
    .filter((event) => event.ticketId === ticketId)
    .map((event) => toEvent(event))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  return respond({
    allowedActions: serverAllowedActions(row.status),
    assignableOperators: [
      {
        displayName: STUB_OPERATORS.agent.displayName,
        id: STUB_OPERATORS.agent.id,
      },
      {
        displayName: STUB_OPERATORS.agentB.displayName,
        id: STUB_OPERATORS.agentB.id,
      },
      {
        displayName: STUB_OPERATORS.lead.displayName,
        id: STUB_OPERATORS.lead.id,
      },
    ],
    references: state.references
      .filter((reference) => reference.ticketId === ticketId)
      .map((reference) => ({
        createdAt: reference.createdAt,
        createdBy: {
          displayName: eventActorName(reference.createdBy),
          id: reference.createdBy,
        },
        refId: reference.refId,
        refLabel: reference.refLabel,
        refType: reference.refType,
      })),
    ticket: toTicket(row),
    timeline,
  });
}

export async function stubCreateTicket(
  input: CreateTicketInput,
): Promise<CreateTicketResult> {
  const customerKey = customerKeyOf(input.customerId);
  if (!customerKey) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject === '' || description === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  state.sequence += 1;
  const now = nextTime();
  const row: StubTicketRow = {
    assigneeOperatorId: null,
    createdAt: now,
    customerId: customerKey,
    description,
    dueAt: null,
    id: `55555555-5555-4555-8555-${String(state.sequence).padStart(12, '0')}`,
    isOverdue: false,
    issueType: input.issueType,
    priority: input.priority,
    productId: input.productId ?? null,
    reopenCount: 0,
    status: 'new',
    subject,
    ticketNo: `TK-2026-${String(state.sequence).padStart(6, '0')}`,
    updatedAt: now,
    version: 1,
  };
  if (input.contractId) {
    row.contractId = input.contractId;
  }
  if (input.deploymentInstanceId) {
    row.deploymentInstanceId = input.deploymentInstanceId;
  }
  if (input.tenantMappingId) {
    row.tenantMappingId = input.tenantMappingId;
  }
  state.tickets.push(row);
  appendEvent(row, {
    body: description,
    eventType: 'created',
    toStatus: 'new',
  });

  return respond({ ticket: toTicket(row) });
}

export async function stubUpdateTicket(
  ticketId: string,
  input: UpdateTicketInput,
): Promise<UpdateTicketResult> {
  const row = ticketRowById(ticketId);
  if (row.status === 'closed') {
    fail({
      code: 'STATE_CONFLICT',
      details: { allowedActions: serverAllowedActions(row.status) },
      status: 409,
    });
  }
  assertVersion(row, input.version);
  if (input.subject !== undefined) {
    row.subject = input.subject;
  }
  if (input.description !== undefined) {
    row.description = input.description;
  }
  if (input.issueType !== undefined) {
    row.issueType = input.issueType;
  }
  if (input.priority !== undefined) {
    row.priority = input.priority;
  }
  row.version += 1;
  row.updatedAt = nextTime();
  return respond({ ticket: toTicket(row) });
}

export async function stubAssignTicket(
  ticketId: string,
  input: AssignTicketInput,
): Promise<TicketMutationResult> {
  const row = ticketRowById(ticketId);
  if (row.status === 'closed') {
    fail({
      code: 'STATE_CONFLICT',
      details: { allowedActions: serverAllowedActions(row.status) },
      status: 409,
    });
  }
  assertVersion(row, input.version);
  if (!operatorRef(input.assigneeOperatorId)) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }

  const fromStatus = row.status;
  row.assigneeOperatorId = input.assigneeOperatorId;
  if (row.status === 'new') {
    row.status = 'assigned';
  }
  row.version += 1;
  row.updatedAt = nextTime();
  const event = appendEvent(row, {
    body: input.reason?.trim() || '分派工单',
    eventType: 'assigned',
    fromStatus,
    toStatus: row.status,
  });

  return respond({
    event: { id: event.id },
    ticket: {
      ...toTicket(row),
      allowedActions: serverAllowedActions(row.status),
    },
  });
}

export async function stubTransitionTicket(
  ticketId: string,
  input: TicketTransitionInput,
): Promise<TicketMutationResult> {
  const row = ticketRowById(ticketId);
  const allowed = serverAllowedActions(row.status);
  if (!allowed.includes(input.action)) {
    fail({
      code: 'STATE_CONFLICT',
      details: { allowedActions: allowed },
      status: 409,
    });
  }
  assertVersion(row, input.version);

  if (input.action === 'wait' && (input.waitingOn ?? '').trim() === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (
    input.action === 'resolve' &&
    (input.resolutionSummary ?? '').trim() === ''
  ) {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  if (
    (input.action === 'close' || input.action === 'reopen') &&
    (input.reason ?? '').trim() === ''
  ) {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }

  const fromStatus = row.status;
  const reason = input.reason?.trim() ?? '';

  switch (input.action) {
    case 'close': {
      row.closedAt = nextTime();
      row.status = 'closed';
      break;
    }
    case 'reopen': {
      row.closedAt = null;
      row.reopenCount += 1;
      row.resolutionSummary = null;
      row.status = 'in_progress';
      break;
    }
    case 'resolve': {
      row.resolutionSummary = input.resolutionSummary?.trim() ?? '';
      row.status = 'resolved';
      row.waitingOn = null;
      break;
    }
    case 'resume': {
      row.status = 'in_progress';
      row.waitingOn = null;
      break;
    }
    case 'start': {
      row.status = 'in_progress';
      break;
    }
    case 'wait': {
      row.status = 'waiting';
      row.waitingOn = input.waitingOn?.trim() ?? '';
      break;
    }
    default: {
      fail({ code: 'VALIDATION_ERROR', status: 400 });
    }
  }
  row.version += 1;
  row.updatedAt = nextTime();

  const event = appendEvent(row, {
    body:
      input.action === 'resolve'
        ? (input.resolutionSummary?.trim() ?? '')
        : reason || input.waitingOn?.trim() || '状态推进',
    eventType: transitionEventType(input.action),
    fromStatus,
    metadata: {
      ...(reason ? { reason } : {}),
      ...(input.action === 'resolve'
        ? { resolutionSummary: input.resolutionSummary?.trim() ?? '' }
        : {}),
    },
    toStatus: row.status,
    waitingOn: input.waitingOn?.trim(),
  });

  return respond({
    event: { id: event.id },
    ticket: {
      ...toTicket(row),
      allowedActions: serverAllowedActions(row.status),
    },
  });
}

export async function stubListTicketTimeline(
  ticketId: string,
  query: TicketTimelineQuery = {},
): Promise<TicketTimelineResult> {
  ticketRowById(ticketId);
  const items = state.events
    .filter((event) => event.ticketId === ticketId)
    .map((event) => toEvent(event))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const page = paginate(items, query.page, query.pageSize);
  return respond({
    items: page.items,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
  });
}

export async function stubAddTicketComment(
  ticketId: string,
  input: AddTicketCommentInput,
): Promise<AddTicketCommentResult> {
  const row = ticketRowById(ticketId);
  if (row.status === 'closed') {
    fail({
      code: 'STATE_CONFLICT',
      details: { allowedActions: serverAllowedActions(row.status) },
      status: 409,
    });
  }
  const body = input.body.trim();
  if (body === '') {
    fail({ code: 'VALIDATION_ERROR', status: 400 });
  }
  row.version += 1;
  row.updatedAt = nextTime();
  const event = appendEvent(row, { body, eventType: 'comment' });
  return respond({ event: toEvent(event) });
}

export async function stubAddTicketReference(
  ticketId: string,
  input: AddTicketReferenceInput,
): Promise<AddTicketReferenceResult> {
  const row = ticketRowById(ticketId);
  const exists = state.references.some(
    (reference) =>
      reference.ticketId === ticketId &&
      reference.refType === input.refType &&
      reference.refId === input.refId,
  );
  if (exists) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  const createdAt = nextTime();
  const reference: StubReferenceRow = {
    createdAt,
    createdBy: STUB_CURRENT_OPERATOR_ID,
    refId: input.refId,
    refLabel: null,
    refType: input.refType,
    ticketId: row.id,
  };
  state.references.push(reference);
  appendEvent(row, {
    body: '关联业务对象',
    eventType: 'linked',
    metadata: { refId: input.refId, refType: input.refType },
  });
  return respond({
    reference: {
      createdAt,
      createdBy: {
        displayName: eventActorName(STUB_CURRENT_OPERATOR_ID),
        id: STUB_CURRENT_OPERATOR_ID,
      },
      refId: reference.refId,
      refLabel: reference.refLabel,
      refType: reference.refType,
    },
  });
}
