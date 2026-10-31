import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsTicketRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站查询
 * 与请求体怎么变成 RPC 参数。
 *
 * 规则本身（状态机八条边、`allowedActions`、逾期判定、`waiting_on` 清空、
 * 引用归属）由 `supabase/tests/ops_support_domain.sql` 在真库上断言。同一条规则
 * 两处各测一遍只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 属于本层的四类例外：
 *   1. **入站形状**：`strictObject` 拒绝 `status`（PATCH 不能改状态）、
 *      `transition` 不接受 `assign`（它有自己的端点）；
 *   2. **幂等键**：全局中间件对缺键放行，三个标「必填」的写端点只能在这里证明；
 *   3. **查询翻译**：`status`/`priority` 多值、布尔串、`page` → `offset`；
 *   4. **静态路由顺序**：`/tickets/assignable-operators` 必须先于 `/tickets/:id`。
 */

const TICKET_ID = '00000000-0000-4000-8000-000000000801';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000802';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const ASSIGNEE_ID = '00000000-0000-4000-8000-000000000003';
const EVENT_ID = '00000000-0000-4000-8000-000000000804';

const ALL_PERMISSIONS = [
  'ticket.read',
  'ticket.create',
  'ticket.assign',
  'ticket.update',
  'ticket.close',
];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'support@example.test',
    operator_display_name: '售后',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['support_agent'],
    role_names: ['售后支持'],
    permission_codes: permissions,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET_ID,
    ticket_no: 'TK-000001',
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    product_id: null,
    contract_id: null,
    tenant_mapping_id: null,
    deployment_instance_id: null,
    subject: '登录失败',
    description: '客户反馈 SSO 登录返回 500',
    issue_type: 'bug',
    priority: 'high',
    status: 'in_progress',
    assignee: { id: ASSIGNEE_ID, display_name: '售后甲', status: 'active' },
    waiting_on: null,
    resolution_summary: null,
    due_at: '2026-11-02T02:00:00+00:00',
    is_overdue: false,
    closed_at: null,
    reopen_count: 0,
    version: 3,
    created_at: '2026-10-31T02:00:00+00:00',
    updated_at: '2026-10-31T03:00:00+00:00',
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    event_type: 'status_changed',
    from_status: 'assigned',
    to_status: 'in_progress',
    actor: { id: OPERATOR_ID, display_name: '售后', status: 'active' },
    body: null,
    waiting_on: null,
    metadata: { action: 'start' },
    created_at: '2026-10-31T03:00:00+00:00',
    ...overrides,
  };
}

interface StubOptions {
  permissions?: string[];
  rpc?: Record<string, unknown>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const rpcBodies: Array<{ name: string; body: Record<string, unknown> }> = [];

function stubFetch(options: StubOptions = {}) {
  const permissions = options.permissions ?? ALL_PERMISSIONS;
  const called: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rpcName = url.split('/rpc/')[1]?.split('?')[0];

    if (rpcName === 'get_current_ops_context') return json([opsContextRow(permissions)]);
    if (!rpcName) throw new Error(`unexpected request: ${url}`);

    called.push(rpcName);
    rpcBodies.push({
      name: rpcName,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (!(rpcName in (options.rpc ?? {}))) {
      throw new Error(`rpc ${rpcName} was not expected`);
    }
    return json(options.rpc?.[rpcName]);
  });

  vi.stubGlobal('fetch', fetchMock);
  return called;
}

const app = new Hono<ApiEnvironment>();
app.onError(errorHandler);
app.route('/', opsTicketRoutes);

const env = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  RATE_LIMIT_PER_MINUTE: '100000',
} satisfies Partial<ApiEnvironment['Bindings']>;

interface CallOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
}

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-support-0001' };

async function call(path: string, options: CallOptions = {}) {
  const url = new URL(path, 'http://ops.test');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  const response = await app.request(
    url.toString(),
    {
      method: options.method ?? 'GET',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env,
  );
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text };
  }
}

/** 路径一律从注册表取：测试里手写路径会让「清单改了、测试没改」悄悄通过。 */
function path(template: string, values: Record<string, string> = {}) {
  let result = template;
  for (const [name, value] of Object.entries({ ticketId: TICKET_ID, ...values })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /tickets', () => {
  it('keeps every status and priority value when the query repeats the key', async () => {
    stubFetch({ rpc: { list_tickets: { status: 'ok', items: [], total: 0 } } });

    await call(path(OPS_ROUTES.listOpsTickets.path), {
      query: { status: ['new', 'waiting'], priority: ['urgent', 'high'] },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_tickets')?.body ?? {};
    // 用 req.query() 取只会剩最后一个值，筛选条数因此总比预期少。
    expect(body.p_statuses).toEqual(['new', 'waiting']);
    expect(body.p_priorities).toEqual(['urgent', 'high']);
  });

  it('translates page into offset and keeps the date filters as dates', async () => {
    stubFetch({ rpc: { list_tickets: { status: 'ok', items: [], total: 0 } } });

    await call(path(OPS_ROUTES.listOpsTickets.path), {
      query: { page: '3', pageSize: '10', createdFrom: '2026-10-01', updatedFrom: '2026-10-05' },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_tickets')?.body ?? {};
    expect(body.p_limit).toBe(10);
    expect(body.p_offset).toBe(20);
    // 日期原样传，不许在这里折算时区：库里的 business_day_start 才是唯一口径。
    expect(body.p_created_from).toBe('2026-10-01');
    expect(body.p_updated_from).toBe('2026-10-05');
  });

  it('reads unassigned=false as false instead of coercing any non-empty string', async () => {
    stubFetch({ rpc: { list_tickets: { status: 'ok', items: [], total: 0 } } });

    await call(path(OPS_ROUTES.listOpsTickets.path), { query: { unassigned: 'false' } });

    const body = rpcBodies.find((entry) => entry.name === 'list_tickets')?.body ?? {};
    expect(body.p_unassigned).toBe(false);
  });

  it('rejects a status value outside the enum', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.listOpsTickets.path), {
      query: { status: ['pending'] },
    });

    expect(result.status).toBe(400);
  });

  it('forbids listing without ticket.read', async () => {
    stubFetch({ permissions: [] });

    const result = await call(path(OPS_ROUTES.listOpsTickets.path));

    expect(result.status).toBe(403);
  });

  it('maps list items to camelCase and keeps isOverdue from the database', async () => {
    stubFetch({
      rpc: {
        list_tickets: {
          status: 'ok',
          items: [ticketRow({ is_overdue: true, due_at: '2026-10-01T02:00:00+00:00' })],
          total: 1,
        },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsTickets.path));

    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({
      ticketNo: 'TK-000001',
      isOverdue: true,
      customer: { customerNo: 'CUS-000001' },
      assignee: { displayName: '售后甲' },
    });
    // 列表项是摘要，不是整张工单：契约 §5.6 的 items 形状里没有 description。
    expect(result.body.items[0].description).toBeUndefined();
    expect(result.body.total).toBe(1);
  });
});

describe('GET /tickets/assignable-operators', () => {
  it('is matched before the ticketId route', async () => {
    stubFetch({
      rpc: {
        list_assignable_operators: {
          status: 'ok',
          items: [{ id: ASSIGNEE_ID, display_name: '售后甲', status: 'active' }],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsTicketAssignableOperators.path));

    // 若 :ticketId 先注册，这里会是 400（uuid 解析失败）而不是 200。
    expect(result.status).toBe(200);
    expect(result.body.items[0]).toEqual({
      id: ASSIGNEE_ID,
      displayName: '售后甲',
      status: 'active',
    });
  });

  it('passes the keyword through', async () => {
    stubFetch({ rpc: { list_assignable_operators: { status: 'ok', items: [] } } });

    await call(path(OPS_ROUTES.listOpsTicketAssignableOperators.path), {
      query: { keyword: '售后' },
    });

    const body = rpcBodies.find((entry) => entry.name === 'list_assignable_operators')?.body ?? {};
    expect(body.p_keyword).toBe('售后');
  });
});

describe('POST /tickets', () => {
  it('requires an idempotency key', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsTicket.path), {
      method: 'POST',
      body: {
        customerId: CUSTOMER_ID,
        subject: '登录失败',
        description: '详情',
        issueType: 'bug',
        priority: 'high',
      },
    });

    expect(result.status).toBe(400);
    expect(result.body.details.field).toBe('Idempotency-Key');
  });

  it('creates a ticket and sends optional references as null', async () => {
    stubFetch({ rpc: { create_ticket: { status: 'ok', ticket: ticketRow({ status: 'new' }) } } });

    const result = await call(path(OPS_ROUTES.createOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        subject: '登录失败',
        description: '详情',
        issueType: 'bug',
        priority: 'high',
      },
    });

    expect(result.status).toBe(201);
    expect(result.body.ticket.ticketNo).toBe('TK-000001');
    const body = rpcBodies.find((entry) => entry.name === 'create_ticket')?.body ?? {};
    // 未传的可选引用必须显式传 null：RPC 的参数默认值不会因为「键缺失」而生效，
    // 而 PostgREST 会按「缺键 = 默认值」处理——两种行为不一致时，最省事的是永远传全。
    expect(body.p_contract_id).toBeNull();
    expect(body.p_product_id).toBeNull();
  });

  it('maps a missing customer to 404 with the resource name', async () => {
    stubFetch({ rpc: { create_ticket: { status: 'customer_not_found' } } });

    const result = await call(path(OPS_ROUTES.createOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        subject: '登录失败',
        description: '详情',
        issueType: 'bug',
        priority: 'high',
      },
    });

    expect(result.status).toBe(404);
    expect(result.body.details.resource).toBe('customer');
  });

  it('maps a cross-customer reference to 400 REFERENCE_CUSTOMER_MISMATCH', async () => {
    stubFetch({
      rpc: {
        create_ticket: { status: 'reference_customer_mismatch', field: 'contractId' },
      },
    });

    const result = await call(path(OPS_ROUTES.createOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        subject: '登录失败',
        description: '详情',
        issueType: 'bug',
        priority: 'high',
        contractId: TICKET_ID,
      },
    });

    expect(result.status).toBe(400);
    expect(result.body.details.reason).toBe('REFERENCE_CUSTOMER_MISMATCH');
    expect(result.body.details.field).toBe('contractId');
  });

  it('rejects unknown body keys instead of silently ignoring them', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        subject: '登录失败',
        description: '详情',
        issueType: 'bug',
        priority: 'high',
        status: 'closed',
      },
    });

    expect(result.status).toBe(400);
  });
});

describe('GET /tickets/{ticketId}', () => {
  it('returns the ticket, timeline, allowed actions and assignable operators', async () => {
    stubFetch({
      rpc: {
        get_ticket: {
          status: 'ok',
          ticket: ticketRow(),
          timeline: [eventRow()],
          references: [
            {
              ref_type: 'tenant_command',
              ref_id: ASSIGNEE_ID,
              created_by: OPERATOR_ID,
              created_at: '2026-10-31T03:10:00+00:00',
            },
          ],
          allowed_actions: ['wait', 'resolve'],
          assignable_operators: [{ id: ASSIGNEE_ID, display_name: '售后甲', status: 'active' }],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.getOpsTicket.path));

    expect(result.status).toBe(200);
    expect(result.body.allowedActions).toEqual(['wait', 'resolve']);
    expect(result.body.timeline[0].fromStatus).toBe('assigned');
    expect(result.body.references[0].refType).toBe('tenant_command');
    expect(result.body.assignableOperators[0].displayName).toBe('售后甲');
    expect(result.body.ticket.version).toBe(3);
  });

  it('returns 404 when the RPC says the ticket is missing', async () => {
    stubFetch({ rpc: { get_ticket: { status: 'ticket_not_found' } } });

    const result = await call(path(OPS_ROUTES.getOpsTicket.path));

    expect(result.status).toBe(404);
    expect(result.body.details.resource).toBe('ticket');
  });

  it('rejects a non-uuid ticketId before reaching the RPC', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.getOpsTicket.path, { ticketId: 'not-a-uuid' }));

    expect(result.status).toBe(400);
    expect(rpcBodies.find((entry) => entry.name === 'get_ticket')).toBeUndefined();
  });
});

describe('PATCH /tickets/{ticketId}', () => {
  it('maps a version mismatch to 409 CONFLICT with the current version', async () => {
    stubFetch({ rpc: { update_ticket: { status: 'version_mismatch', current_version: 7 } } });

    const result = await call(path(OPS_ROUTES.updateOpsTicket.path), {
      method: 'PATCH',
      body: { priority: 'urgent', version: 3 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details.currentVersion).toBe(7);
  });

  it('refuses to change status through PATCH', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.updateOpsTicket.path), {
      method: 'PATCH',
      body: { status: 'closed', version: 3 },
    });

    expect(result.status).toBe(400);
  });

  it('sends null for every field the caller left out', async () => {
    stubFetch({ rpc: { update_ticket: { status: 'ok', ticket: ticketRow() } } });

    await call(path(OPS_ROUTES.updateOpsTicket.path), {
      method: 'PATCH',
      body: { subject: '新标题', version: 3 },
    });

    const body = rpcBodies.find((entry) => entry.name === 'update_ticket')?.body ?? {};
    expect(body.p_subject).toBe('新标题');
    // NULL 的语义是「不改」：传空串会变成「改成空」，两者在库里不是一回事。
    expect(body.p_description).toBeNull();
    expect(body.p_priority).toBeNull();
  });
});

describe('POST /tickets/{ticketId}/assign', () => {
  it('requires an idempotency key', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.assignOpsTicket.path), {
      method: 'POST',
      body: { assigneeOperatorId: ASSIGNEE_ID, version: 1 },
    });

    expect(result.status).toBe(400);
    expect(result.body.details.field).toBe('Idempotency-Key');
  });

  it('maps an inactive assignee to 409 STATE_CONFLICT with the reason', async () => {
    stubFetch({
      rpc: { assign_ticket: { status: 'assignee_inactive', assignee_status: 'disabled' } },
    });

    const result = await call(path(OPS_ROUTES.assignOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { assigneeOperatorId: ASSIGNEE_ID, version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details.reason).toBe('ASSIGNEE_INACTIVE');
    expect(result.body.details.assigneeStatus).toBe('disabled');
  });

  it('returns allowedActions when the ticket is closed', async () => {
    stubFetch({
      rpc: { assign_ticket: { status: 'ticket_closed', allowed_actions: ['reopen'] } },
    });

    const result = await call(path(OPS_ROUTES.assignOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { assigneeOperatorId: ASSIGNEE_ID, version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details.reason).toBe('TICKET_CLOSED');
    expect(result.body.details.allowedActions).toEqual(['reopen']);
  });

  it('maps an unknown assignee to 404 with the operator resource', async () => {
    stubFetch({ rpc: { assign_ticket: { status: 'assignee_not_found' } } });

    const result = await call(path(OPS_ROUTES.assignOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { assigneeOperatorId: ASSIGNEE_ID, version: 1 },
    });

    expect(result.status).toBe(404);
    expect(result.body.details.resource).toBe('operator');
  });
});

describe('POST /tickets/{ticketId}/transition', () => {
  it('requires an idempotency key', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.transitionOpsTicket.path), {
      method: 'POST',
      body: { action: 'start', version: 2 },
    });

    expect(result.status).toBe(400);
    expect(result.body.details.field).toBe('Idempotency-Key');
  });

  it('returns the current status, the action and the allowed actions on an illegal edge', async () => {
    stubFetch({
      rpc: {
        transition_ticket: {
          status: 'invalid_transition',
          current: 'new',
          action: 'start',
          allowed_actions: ['assign'],
        },
      },
    });

    const result = await call(path(OPS_ROUTES.transitionOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'start', version: 1 },
    });

    expect(result.status).toBe(409);
    expect(result.body.details).toMatchObject({
      reason: 'INVALID_TRANSITION',
      current: 'new',
      action: 'start',
      allowedActions: ['assign'],
    });
  });

  it('maps missing action-specific fields to 400 with the field name', async () => {
    stubFetch({ rpc: { transition_ticket: { status: 'waiting_on_required' } } });

    const result = await call(path(OPS_ROUTES.transitionOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'wait', version: 2 },
    });

    expect(result.status).toBe(400);
    expect(result.body.details).toMatchObject({
      reason: 'WAITING_ON_REQUIRED',
      field: 'waitingOn',
    });
  });

  it('does not accept assign through the transition endpoint', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.transitionOpsTicket.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'assign', version: 2 },
    });

    expect(result.status).toBe(400);
  });
});

describe('GET /tickets/{ticketId}/timeline', () => {
  it('pages the timeline and maps events to camelCase', async () => {
    stubFetch({
      rpc: {
        list_ticket_timeline: { status: 'ok', total: 1, items: [eventRow()] },
      },
    });

    const result = await call(path(OPS_ROUTES.listOpsTicketTimeline.path), {
      query: { page: '2', pageSize: '10' },
    });

    expect(result.status).toBe(200);
    const body = rpcBodies.find((entry) => entry.name === 'list_ticket_timeline')?.body ?? {};
    expect(body.p_limit).toBe(10);
    expect(body.p_offset).toBe(10);
    expect(result.body.items[0].eventType).toBe('status_changed');
    expect(result.body.total).toBe(1);
  });

  it('returns 404 for an unknown ticket', async () => {
    stubFetch({ rpc: { list_ticket_timeline: { status: 'ticket_not_found' } } });

    const result = await call(path(OPS_ROUTES.listOpsTicketTimeline.path));

    expect(result.status).toBe(404);
  });
});

describe('POST /tickets/{ticketId}/events', () => {
  it('appends a comment and returns the event id', async () => {
    stubFetch({
      rpc: { add_ticket_event: { status: 'ok', event: { id: EVENT_ID, event_type: 'comment' } } },
    });

    const result = await call(path(OPS_ROUTES.createOpsTicketEvent.path), {
      method: 'POST',
      body: { body: '已按日志定位' },
    });

    expect(result.status).toBe(201);
    expect(result.body.event).toEqual({ id: EVENT_ID, eventType: 'comment' });
  });

  it('refuses a comment on a closed ticket with allowedActions', async () => {
    stubFetch({
      rpc: { add_ticket_event: { status: 'ticket_closed', allowed_actions: ['reopen'] } },
    });

    const result = await call(path(OPS_ROUTES.createOpsTicketEvent.path), {
      method: 'POST',
      body: { body: '关闭之后再补一句' },
    });

    expect(result.status).toBe(409);
    expect(result.body.details.allowedActions).toEqual(['reopen']);
  });

  it('rejects an empty note before reaching the RPC', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsTicketEvent.path), {
      method: 'POST',
      body: { body: '   ' },
    });

    expect(result.status).toBe(400);
  });
});

describe('POST /tickets/{ticketId}/references', () => {
  it('maps a duplicate reference to 409 CONFLICT', async () => {
    stubFetch({ rpc: { add_ticket_reference: { status: 'reference_exists' } } });

    const result = await call(path(OPS_ROUTES.createOpsTicketReference.path), {
      method: 'POST',
      body: { refType: 'tenant_command', refId: ASSIGNEE_ID },
    });

    expect(result.status).toBe(409);
    expect(result.body.details.reason).toBe('REFERENCE_EXISTS');
  });

  it('rejects an unknown refType before reaching the RPC', async () => {
    stubFetch({});

    const result = await call(path(OPS_ROUTES.createOpsTicketReference.path), {
      method: 'POST',
      body: { refType: 'invoice', refId: ASSIGNEE_ID },
    });

    expect(result.status).toBe(400);
  });
});
