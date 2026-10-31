import { describe, expect, it } from 'vitest';
import { OPS_USER, OPS_VIEWER_USER, call, expectStatus, signToken } from './harness';

/**
 * 运营支撑域（售后工单与时间线），跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明的是「回包形状与拒绝形状都来自库」：201/200 说明十个 RPC 的 jsonb
 * 键名与 `protocol.ts` 的 row schema 逐字段对齐（否则 `ops_rpc_shape_invalid`
 * → 503）；403 说明权限按动作码判；400/409 说明 `{status:...}` 信封被 Worker
 * 正确翻译。
 *
 * 用例之间有状态依赖（建单 → 分派 → 提交 → 解决 → 关闭 → 重开，是一条真实工单
 * 的生命周期），所以同一文件内顺序执行。**这正是要证明的东西**：状态机在真实
 * 事务里走得通，而不是只有 pgTAP 里走得通。
 *
 * 三处能力边界如实留空：
 * - **引用存在性**：`tenant_commands` / `entitlement_change_requests` /
 *   `deployment_version_records` 三张表属 o-t09/t10/t11，本轮不存在。集成层只能
 *   证明「表不在时关联被接受」，不能证明「引用不存在时报错」。
 * - **按优先级系数算时限**：U-11 的系数未定，四档同基线（见 C-107）。
 * - **`overdueOnly` 的真实命中**：`due_at` 由服务端按设置算，集成层无法把一张单
 *   改成逾期（没有写 `due_at` 的端点）。逾期判定由 pgTAP 对着边界值证明。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const TICKETS = '/api/v1/ops/tickets';
const CUSTOMERS = '/api/v1/ops/customers';

interface TicketBody {
  id: string;
  ticketNo: string;
  customerId: string;
  customer: { id: string; customerNo: string; name: string };
  subject: string;
  description: string;
  issueType: string;
  priority: string;
  status: string;
  assignee: { id: string; displayName: string; status: string } | null;
  waitingOn: string | null;
  resolutionSummary: string | null;
  dueAt: string | null;
  isOverdue: boolean;
  closedAt: string | null;
  reopenCount: number;
  version: number;
}

interface EventBody {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: { id: string; displayName: string } | null;
  body: string | null;
  waitingOn: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface DetailBody {
  ticket: TicketBody;
  timeline: EventBody[];
  references: Array<{ refType: string; refId: string }>;
  allowedActions: string[];
  assignableOperators: Array<{ id: string; displayName: string; status: string }>;
}

let customerId = '';
/** 生命周期主线上的那张单。 */
let mainTicket: TicketBody;
/** 全程不分派的单，用来证明 `unassigned=true` 能筛出「待分派」。 */
let unassignedTicket: TicketBody;

describe('工单的生命周期（真实状态机）', () => {
  it('creates a customer to attach tickets to', async () => {
    const created = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '工单集成客户', reason: '支撑域集成测试' },
    });
    expectStatus(created, 201);
    customerId = created.body.customer.id;
    expect(customerId).toBeTruthy();
  });

  it('creates a ticket in status new with a calculated dueAt', async () => {
    const created = await call<{ ticket: TicketBody }>(TICKETS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        subject: '登录失败',
        description: '客户反馈 SSO 登录返回 500',
        issueType: 'bug',
        priority: 'high',
      },
    });
    expectStatus(created, 201);

    mainTicket = created.body.ticket;
    expect(mainTicket.status).toBe('new');
    expect(mainTicket.ticketNo).toMatch(/^TK-\d{6}$/);
    expect(mainTicket.assignee).toBeNull();
    // dueAt 由服务端按 settings.ticket.dueHours（48）算，不是前端传的。
    expect(mainTicket.dueAt).not.toBeNull();
    expect(mainTicket.isOverdue).toBe(false);

    const hours = (new Date(mainTicket.dueAt as string).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(46);
    expect(hours).toBeLessThan(50);
  });

  it('lists the ticket for its customer with the list-item shape', async () => {
    // 列表项是摘要：契约 §5.6 的 items 里没有 description 与 version。
    const listed = await call<{ items: Array<Record<string, unknown>>; total: number }>(TICKETS, {
      token: opsToken,
      query: { customerId },
    });
    expectStatus(listed, 200);

    const item = listed.body.items.find((entry) => entry.id === mainTicket.id);
    expect(item).toBeDefined();
    expect(item?.ticketNo).toBe(mainTicket.ticketNo);
    expect(item?.isOverdue).toBe(false);
    expect(item?.description).toBeUndefined();
  });

  it('returns the detail with allowedActions and assignable operators', async () => {
    const detail = await call<DetailBody>(`${TICKETS}/${mainTicket.id}`, { token: opsToken });
    expectStatus(detail, 200);

    // 状态机把「new 只能 assign」交给前端，前端不维护副本。
    expect(detail.body.allowedActions).toEqual(['assign']);
    expect(detail.body.timeline).toHaveLength(1);
    expect(detail.body.timeline[0].eventType).toBe('created');
    expect(detail.body.timeline[0].actor?.displayName).toBeTruthy();
    // 售后角色没有 operator.read，可指派成员必须内联在详情里。
    expect(detail.body.assignableOperators.length).toBeGreaterThan(0);
    expect(detail.body.assignableOperators.every((entry) => entry.status === 'active')).toBe(true);
  });

  it('lists the assignable operators for the creation page', async () => {
    const operators = await call<{ items: Array<{ id: string; displayName: string }> }>(
      `${TICKETS}/assignable-operators`,
      { token: opsToken },
    );
    expectStatus(operators, 200);
    // 静态路由若排在 :ticketId 之后，这里是 400（uuid 解析失败）而不是 200。
    expect(operators.body.items.length).toBeGreaterThan(0);
    expect(operators.body.items[0].displayName).toBeTruthy();
  });

  it('assigns the ticket and moves it to assigned', async () => {
    const assignee = (
      await call<{ items: Array<{ id: string }> }>(`${TICKETS}/assignable-operators`, {
        token: opsToken,
      })
    ).body.items[0].id;

    const assigned = await call<{ ticket: TicketBody; event: { id: string } }>(
      `${TICKETS}/${mainTicket.id}/assign`,
      {
        method: 'POST',
        token: opsToken,
        body: { assigneeOperatorId: assignee, reason: '分给一线', version: mainTicket.version },
      },
    );
    expectStatus(assigned, 200);
    expect(assigned.body.ticket.status).toBe('assigned');
    expect(assigned.body.ticket.assignee?.id).toBe(assignee);
    expect(assigned.body.event.id).toBeTruthy();

    mainTicket = assigned.body.ticket;
  });

  it('starts the ticket and then asks to wait without a waitingOn', async () => {
    const started = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'start', version: mainTicket.version },
    });
    expectStatus(started, 200);
    expect(started.body.ticket.status).toBe('in_progress');
    mainTicket = started.body.ticket;

    const refused = await call<{ details: { reason: string; field: string } }>(
      `${TICKETS}/${mainTicket.id}/transition`,
      { method: 'POST', token: opsToken, body: { action: 'wait', version: mainTicket.version } },
    );
    expectStatus(refused, 400);
    expect(refused.body.details).toMatchObject({
      reason: 'WAITING_ON_REQUIRED',
      field: 'waitingOn',
    });
  });

  it('waits, resumes and proves waitingOn is cleared on resume', async () => {
    const waited = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'wait', waitingOn: '客户回传日志', version: mainTicket.version },
    });
    expectStatus(waited, 200);
    expect(waited.body.ticket.status).toBe('waiting');
    expect(waited.body.ticket.waitingOn).toBe('客户回传日志');
    mainTicket = waited.body.ticket;

    const resumed = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'resume', version: mainTicket.version },
    });
    expectStatus(resumed, 200);
    expect(resumed.body.ticket.status).toBe('in_progress');
    // 离开 waiting 必须清空：留着的话列表会把这张单显示成「正在等客户」。
    expect(resumed.body.ticket.waitingOn).toBeNull();
    mainTicket = resumed.body.ticket;
  });

  it('refuses to resolve without a summary, then resolves with one', async () => {
    const refused = await call<{ details: { reason: string } }>(
      `${TICKETS}/${mainTicket.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'resolve', version: mainTicket.version },
      },
    );
    expectStatus(refused, 400);
    expect(refused.body.details.reason).toBe('RESOLUTION_SUMMARY_REQUIRED');

    const resolved = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: {
        action: 'resolve',
        resolutionSummary: '重置了 SSO 回调地址',
        version: mainTicket.version,
      },
    });
    expectStatus(resolved, 200);
    expect(resolved.body.ticket.status).toBe('resolved');
    expect(resolved.body.ticket.resolutionSummary).toBe('重置了 SSO 回调地址');
    mainTicket = resolved.body.ticket;
  });

  it('closes the ticket and refuses further comments', async () => {
    const closed = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'close', version: mainTicket.version },
    });
    expectStatus(closed, 200);
    expect(closed.body.ticket.status).toBe('closed');
    expect(closed.body.ticket.closedAt).not.toBeNull();
    mainTicket = closed.body.ticket;

    const refused = await call<{ details: { reason: string; allowedActions: string[] } }>(
      `${TICKETS}/${mainTicket.id}/events`,
      { method: 'POST', token: opsToken, body: { body: '关闭之后再补一句' } },
    );
    expectStatus(refused, 409);
    expect(refused.body.details).toMatchObject({
      reason: 'TICKET_CLOSED',
      allowedActions: ['reopen'],
    });
  });

  it('reopens the ticket and resets closedAt / bumps reopenCount', async () => {
    const refused = await call<{ details: { reason: string } }>(
      `${TICKETS}/${mainTicket.id}/transition`,
      { method: 'POST', token: opsToken, body: { action: 'reopen', version: mainTicket.version } },
    );
    expectStatus(refused, 400);
    expect(refused.body.details.reason).toBe('REASON_REQUIRED');

    const reopened = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'reopen', reason: '客户说问题复发', version: mainTicket.version },
    });
    expectStatus(reopened, 200);
    expect(reopened.body.ticket.status).toBe('in_progress');
    expect(reopened.body.ticket.reopenCount).toBe(1);
    expect(reopened.body.ticket.closedAt).toBeNull();
    mainTicket = reopened.body.ticket;
  });

  it('reports the illegal edge with the allowed actions', async () => {
    const refused = await call<{
      details: { reason: string; current: string; action: string; allowedActions: string[] };
    }>(`${TICKETS}/${mainTicket.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'start', version: mainTicket.version },
    });

    expectStatus(refused, 409);
    expect(refused.body.details).toMatchObject({
      reason: 'INVALID_TRANSITION',
      current: 'in_progress',
      action: 'start',
      allowedActions: ['wait', 'resolve'],
    });
  });

  it('appends a comment and shows it in the timeline', async () => {
    const created = await call<{ event: { id: string; eventType: string } }>(
      `${TICKETS}/${mainTicket.id}/events`,
      { method: 'POST', token: opsToken, body: { body: '已按客户提供的日志定位' } },
    );
    expectStatus(created, 201);
    expect(created.body.event.eventType).toBe('comment');

    const timeline = await call<{ items: EventBody[]; total: number }>(
      `${TICKETS}/${mainTicket.id}/timeline`,
      { token: opsToken },
    );
    expectStatus(timeline, 200);
    // created + assigned + start + wait + resume + resolve + close + reopen + comment
    expect(timeline.body.total).toBeGreaterThanOrEqual(9);
    expect(timeline.body.items[0].eventType).toBe('comment');
    expect(timeline.body.items[0].body).toBe('已按客户提供的日志定位');
  });

  it('links a reference and refuses the duplicate', async () => {
    const refId = '00000000-0000-4000-8000-00000000a001';
    const created = await call<{ reference: { refType: string; refId: string } }>(
      `${TICKETS}/${mainTicket.id}/references`,
      { method: 'POST', token: opsToken, body: { refType: 'tenant_command', refId } },
    );
    expectStatus(created, 201);
    expect(created.body.reference).toMatchObject({ refType: 'tenant_command', refId });

    const duplicate = await call<{ details: { reason: string } }>(
      `${TICKETS}/${mainTicket.id}/references`,
      { method: 'POST', token: opsToken, body: { refType: 'tenant_command', refId } },
    );
    expectStatus(duplicate, 409);
    expect(duplicate.body.details.reason).toBe('REFERENCE_EXISTS');
  });

  it('rejects a stale version on PATCH with the current version', async () => {
    const stale = await call<{ details: { currentVersion: number } }>(
      `${TICKETS}/${mainTicket.id}`,
      {
        method: 'PATCH',
        token: opsToken,
        body: { priority: 'urgent', version: mainTicket.version - 5 },
      },
    );
    expectStatus(stale, 409);
    expect(stale.body.details.currentVersion).toBe(mainTicket.version);

    const updated = await call<{ ticket: TicketBody }>(`${TICKETS}/${mainTicket.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { priority: 'urgent', version: mainTicket.version },
    });
    expectStatus(updated, 200);
    expect(updated.body.ticket.priority).toBe('urgent');
    expect(updated.body.ticket.version).toBe(mainTicket.version + 1);
  });
});

describe('工单的筛选与权限', () => {
  it('creates a second ticket that stays unassigned', async () => {
    const created = await call<{ ticket: TicketBody }>(TICKETS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        subject: '开票信息有误',
        description: '发票抬头写错了',
        issueType: 'billing',
        priority: 'normal',
      },
    });
    expectStatus(created, 201);
    unassignedTicket = created.body.ticket;

    const unassigned = await call<{ items: Array<{ id: string }> }>(TICKETS, {
      token: opsToken,
      query: { customerId, unassigned: 'true' },
    });
    expectStatus(unassigned, 200);
    expect(unassigned.body.items.map((entry) => entry.id)).toContain(unassignedTicket.id);
    expect(unassigned.body.items.map((entry) => entry.id)).not.toContain(mainTicket.id);
  });

  it('filters by status without breaking the paging envelope', async () => {
    const filtered = await call<{ items: Array<{ status: string }>; total: number }>(TICKETS, {
      token: opsToken,
      query: { customerId, status: 'new' },
    });
    expectStatus(filtered, 200);
    expect(filtered.body.items.every((entry) => entry.status === 'new')).toBe(true);
    expect(filtered.body.total).toBe(filtered.body.items.length);
  });

  it('lets a reader list but not create', async () => {
    const listed = await call(TICKETS, { token: viewerToken, query: { customerId } });
    expectStatus(listed, 200);

    const refused = await call(`${TICKETS}`, {
      method: 'POST',
      token: viewerToken,
      body: {
        customerId,
        subject: '只读账号建单',
        description: '应当被拒',
        issueType: 'bug',
        priority: 'low',
      },
    });
    expectStatus(refused, 403);
  });

  it('rejects a create without an Idempotency-Key', async () => {
    const refused = await call<{ details: { field: string } }>(TICKETS, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: {
        customerId,
        subject: '缺幂等键',
        description: '应当被拒',
        issueType: 'bug',
        priority: 'low',
      },
    });
    expectStatus(refused, 400);
    expect(refused.body.details.field).toBe('Idempotency-Key');
  });

  it('refuses a reference to another customer contract', async () => {
    const other = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '别家客户', reason: '引用归属测试' },
    });
    expectStatus(other, 201);

    const product = await call<{ product: { id: string } }>('/api/v1/ops/products', {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'SUP-INT-001',
        name: '工单集成产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(product, 201);

    const contract = await call<{ contract: { id: string } }>('/api/v1/ops/contracts', {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: other.body.customer.id,
        salesMode: 'saas',
        businessNote: '别家合同',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 1000 }],
      },
    });
    expectStatus(contract, 201);

    const refused = await call<{ details: { reason: string; field: string } }>(TICKETS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        subject: '错配引用',
        description: '合同属于另一个客户',
        issueType: 'bug',
        priority: 'normal',
        contractId: contract.body.contract.id,
      },
    });
    expectStatus(refused, 400);
    expect(refused.body.details).toMatchObject({
      reason: 'REFERENCE_CUSTOMER_MISMATCH',
      field: 'contractId',
    });
  });

  it('returns 404 for an unknown ticket id', async () => {
    const missing = await call(`${TICKETS}/00000000-0000-4000-8000-00000000a0ff`, {
      token: opsToken,
    });
    expectStatus(missing, 404);
  });
});
