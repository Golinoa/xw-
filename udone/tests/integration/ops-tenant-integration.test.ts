import { beforeAll, describe, expect, it } from 'vitest';
import {
  OPS_SALES_USER,
  OPS_USER,
  OPS_VIEWER_USER,
  call,
  expectStatus,
  restRequest,
  signServiceToken,
  signToken,
} from './harness';

/**
 * tenant-integration 集成测试：真实 PostgREST + 真实 RLS/RPC。
 *
 * 这一份里唯一「不像别的域」的地方：**推进命令终态的那一半走 service_role**。
 * 那不是绕过安全模型——`record_tenant_command_attempt` 的设计调用方就是下发方
 * （service_role），运营端令牌在这一跳会 403。所以这里先用运营令牌证明它
 * 真的被挡住，再换下发方的令牌走完整条链路。少了前一条，这整个文件就变成
 * 「用超级权限把业务跑一遍」，全绿也不说明任何事。
 *
 * 另一处：命令的状态机有五个状态，而 HTTP 面只能让命令进入 `pending` /
 * `retrying` / `cancelled`。`succeeded` 与 `failed` 必须由远端结果驱动——
 * 这正是 202 的含义，也是本文件要证明的东西。
 */

const MAPPINGS = '/api/v1/ops/tenant-mappings';
const COMMANDS = '/api/v1/ops/tenant-commands';
const PRODUCTS = '/api/v1/ops/products';
const CUSTOMERS = '/api/v1/ops/customers';

const opsToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);
const viewerToken = signToken(OPS_VIEWER_USER);
const serviceToken = signServiceToken();

const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000d1';
const OTHER_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000d2';
const MISSING_ID = '00000000-0000-4000-8000-00000000ffff';

interface MappingBody {
  id: string;
  mappingNo: string;
  udoneOrganizationId: string | null;
  externalRef: string | null;
  mappingStatus: string;
  syncVersion: number;
  version: number;
  lastKnownState: string | null;
}

interface CommandBody {
  id: string;
  commandNo: string;
  status: string;
  attemptCount: number;
  lastErrorCategory: string | null;
  nextRetryAt: string | null;
  expectedSyncVersion: number | null;
}

interface AttemptBody {
  attemptNo: number;
  outcome: string;
  httpStatus: number | null;
  errorCategory: string | null;
}

let customerId: string;
let productId: string;
let mapping: MappingBody;
let secondMapping: MappingBody;
let provisionCommand: CommandBody;
let activateCommand: CommandBody;
let retriedCommand: CommandBody;
let permanentCommand: CommandBody;
let timeoutCommand: CommandBody;
let cancelledCommand: CommandBody;

/**
 * 下发方的调用：只有 service_role 能推进命令终态。
 *
 * 这里直连 PostgREST 而不是走 `/api/v1`，所以看到的是 SQL 层的原始形状：
 * snake_case、`{ status, command, attempt, mapping }`。camelCase 是
 * `protocol.ts` 出站时才做的转换，这条路径不经过它。断言写成 camelCase
 * 会因为取到 `undefined` 而「恰好」通过（`undefined?.x` 不报错）——
 * 这正是第一版把 `mapping` 写成 `undefined` 却没炸在断言上的原因。
 */
interface RawMapping {
  udone_organization_id: string | null;
  mapping_status: string;
  sync_version: number;
  last_known_state: string | null;
}

interface RawCommand {
  status: string;
  attempt_count: number;
  next_retry_at: string | null;
}

async function recordAttempt(commandId: string, body: Record<string, unknown>) {
  return restRequest<{
    status: string;
    current_status?: string;
    command?: RawCommand;
    mapping?: RawMapping;
  }>('rpc/record_tenant_command_attempt', {
    method: 'POST',
    token: serviceToken,
    profile: 'ops',
    body: { p_command_id: commandId, ...body },
  });
}

describe('租户映射与命令的引用前置', () => {
  beforeAll(async () => {
    const product = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'TEN-INT-001',
        name: '租户集成产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(product, 201);
    productId = product.body.product.id;

    const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '租户集成客户', reason: '租户域集成测试' },
    });
    expectStatus(customer, 201);
    customerId = customer.body.customer.id;

    // 映射 A：走完整开通链路（建的时候还没有 org id）。
    const created = await call<{ mapping: MappingBody }>(MAPPINGS, {
      method: 'POST',
      token: opsToken,
      body: { customerId, productId, externalRef: 'CRM-01', reason: '首次开通' },
    });
    expectStatus(created, 201);
    mapping = created.body.mapping;

    // 映射 B：只用来验 PATCH 与租户占用冲突。
    const second = await call<{ mapping: MappingBody }>(MAPPINGS, {
      method: 'POST',
      token: opsToken,
      body: { customerId, productId, reason: '第二张映射' },
    });
    expectStatus(second, 201);
    secondMapping = second.body.mapping;
  });

  it('夹具就绪', () => {
    expect(mapping.udoneOrganizationId).toBeNull();
    expect(mapping.mappingStatus).toBe('pending');
    expect(secondMapping.id).not.toBe(mapping.id);
  });
});

describe('GET /api/v1/ops/tenant-mappings', () => {
  it('按客户筛，两个运营身份都能读', async () => {
    const opsList = await call<{ items: MappingBody[]; total: number }>(MAPPINGS, {
      token: opsToken,
      query: { customerId },
    });
    expectStatus(opsList, 200);
    expect(opsList.body.total).toBeGreaterThanOrEqual(2);
    expect(opsList.body.items[0]?.mappingNo).toMatch(/^TM-\d{6}$/);

    const viewerList = await call(MAPPINGS, { token: viewerToken });
    expectStatus(viewerList, 200);

    // sales_ops 有 tenant.read，能不能读与「能不能开通」无关。
    const salesList = await call(MAPPINGS, { token: salesToken });
    expectStatus(salesList, 200);
  });
});

describe('POST /api/v1/ops/tenant-mappings', () => {
  it('没有 tenant.provision 的两个身份都被挡住', async () => {
    for (const token of [salesToken, viewerToken]) {
      const response = await call(MAPPINGS, {
        method: 'POST',
        token,
        body: { customerId, productId },
      });
      expectStatus(response, 403);
    }
  });

  it('缺 Idempotency-Key 回 400', async () => {
    const response = await call(MAPPINGS, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: { customerId, productId },
    });
    expectStatus(response, 400);
  });
});

describe('PATCH /api/v1/ops/tenant-mappings/{id}', () => {
  it('pending 期间可以补外部 ID，版本前进一格', async () => {
    const response = await call<{ mapping: MappingBody }>(`${MAPPINGS}/${secondMapping.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { udoneOrganizationId: OTHER_ORGANIZATION_ID, version: 0 },
    });

    expectStatus(response, 200);
    expect(response.body.mapping.udoneOrganizationId).toBe(OTHER_ORGANIZATION_ID);
    expect(response.body.mapping.version).toBe(1);
    secondMapping = response.body.mapping;
  });

  it('版本落后回 409 CONFLICT', async () => {
    const response = await call(`${MAPPINGS}/${secondMapping.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { externalRef: 'CRM-02', version: 0 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('VERSION_MISMATCH');
  });

  it('同一个 org id 不能被第二个客户占用', async () => {
    const response = await call(MAPPINGS, {
      method: 'POST',
      token: opsToken,
      body: { customerId, productId, udoneOrganizationId: OTHER_ORGANIZATION_ID },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('TENANT_MAPPING_CONFLICT');
  });
});

describe('POST /api/v1/ops/tenant-mappings/{id}/commands', () => {
  it('建 provision 命令回 202 且 status 是 pending', async () => {
    const response = await call<{ command: CommandBody; mapping: MappingBody | null }>(
      `${MAPPINGS}/${mapping.id}/commands`,
      {
        method: 'POST',
        token: opsToken,
        headers: { 'Idempotency-Key': 'it-tenant-provision-1' },
        body: { commandType: 'provision', reason: '开通租户', expectedSyncVersion: 0 },
      },
    );

    expectStatus(response, 202);
    expect(response.body.command.status).toBe('pending');
    expect(response.body.command.commandNo).toMatch(/^CMD-\d{6}$/);
    provisionCommand = response.body.command;
  });

  it('同一把幂等键重放同一件事，返回同一条命令', async () => {
    const response = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': 'it-tenant-provision-1' },
      body: { commandType: 'provision', reason: '开通租户', expectedSyncVersion: 0 },
    });

    expectStatus(response, 202);
    expect(response.body.command.id).toBe(provisionCommand.id);
  });

  it('同一把幂等键换一件事回 409 CONFLICT', async () => {
    const response = await call(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': 'it-tenant-provision-1' },
      body: { commandType: 'activate', reason: '顺手激活', expectedSyncVersion: 0 },
    });

    expectStatus(response, 409);
    // 挡在路由之前的是幂等中间件（同一把键 + 不同请求体），不是 SQL 层的
    // 唯一约束。SQL 层的 `idempotency_conflict` 只在中间件缓存过期、库里那条
    // 命令还在时才露头，由 pgTAP 的 C 组覆盖。这里断言的是线上真正先发生的事。
    expect(JSON.stringify(response.body)).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('期望版本过期回 409 STATE_CONFLICT', async () => {
    const response = await call(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'activate', reason: '激活', expectedSyncVersion: 9 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('SYNC_VERSION_MISMATCH');
  });

  it('还没绑 org id 就激活回 409 STATE_CONFLICT', async () => {
    const response = await call(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'activate', reason: '激活', expectedSyncVersion: 0 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('MAPPING_NOT_BOUND');
  });

  it('权限按命令类型判：sales 能读但不能停服', async () => {
    const response = await call(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: salesToken,
      body: { commandType: 'suspend', reason: '停服', expectedSyncVersion: 0 },
    });

    expectStatus(response, 403);
  });
});

describe('GET /api/v1/ops/tenant-commands', () => {
  it('按映射筛，命令带 attemptCount 与错误类别', async () => {
    const response = await call<{ items: CommandBody[]; total: number }>(COMMANDS, {
      token: opsToken,
      query: { mappingId: mapping.id },
    });

    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.items[0]?.commandNo).toMatch(/^CMD-\d{6}$/);
  });

  it('详情带空 attempts 且 retryable=false', async () => {
    const response = await call<{
      command: CommandBody;
      attempts: AttemptBody[];
      retryable: boolean;
    }>(`${COMMANDS}/${provisionCommand.id}`, { token: opsToken });

    expectStatus(response, 200);
    expect(response.body.attempts).toEqual([]);
    expect(response.body.retryable).toBe(false);
  });

  it('不存在的命令回 404，尝试列表也是 404', async () => {
    const detail = await call(`${COMMANDS}/${MISSING_ID}`, { token: opsToken });
    expectStatus(detail, 404);

    const attempts = await call(`${COMMANDS}/${MISSING_ID}/attempts`, { token: opsToken });
    expectStatus(attempts, 404);
  });
});

describe('下发结果只能由 service_role 写', () => {
  it('运营令牌调不动 record_tenant_command_attempt', async () => {
    const response = await restRequest('rpc/record_tenant_command_attempt', {
      method: 'POST',
      token: opsToken,
      profile: 'ops',
      body: { p_command_id: provisionCommand.id, p_outcome: 'succeeded' },
    });

    // 运营令牌是 authenticated 角色，这个函数没有给它的 EXECUTE。
    expect(response.status).toBe(403);
  });

  it('远端确认后 provision 成功，映射被绑定但仍是 pending', async () => {
    const response = await recordAttempt(provisionCommand.id, {
      p_outcome: 'succeeded',
      p_http_status: 201,
      p_response_summary: {
        udoneOrganizationId: ORGANIZATION_ID,
        state: 'PROVISIONED',
      },
    });

    expectStatus(response, 200);
    expect(response.body.command?.status).toBe('succeeded');
    expect(response.body.mapping?.udone_organization_id).toBe(ORGANIZATION_ID);
    // 开通 ≠ 生效。远端建好了租户，但客户还没被放行使用——`activate` 是另一条命令。
    expect(response.body.mapping?.mapping_status).toBe('pending');
    expect(response.body.mapping?.sync_version).toBe(1);
    expect(response.body.mapping?.last_known_state).toBe('PROVISIONED');
  });

  it('激活之后映射才变 active，syncVersion 继续前进', async () => {
    const created = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'activate', reason: '开通完成', expectedSyncVersion: 1 },
    });
    expectStatus(created, 202);
    activateCommand = created.body.command;

    const response = await recordAttempt(activateCommand.id, {
      p_outcome: 'succeeded',
      p_response_summary: { state: 'ACTIVE' },
    });

    expectStatus(response, 200);
    expect(response.body.mapping?.mapping_status).toBe('active');
    expect(response.body.mapping?.sync_version).toBe(2);
  });

  it('已生效的映射不能再改外部 ID', async () => {
    const response = await call(`${MAPPINGS}/${mapping.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { udoneOrganizationId: OTHER_ORGANIZATION_ID, version: 2 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('MAPPING_NOT_PENDING');
  });
});

describe('失败、重试与终态', () => {
  it('transient 失败可重试，重试成功后 syncVersion 只前进一次', async () => {
    const created = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'sync_entitlement', reason: '同步权益', expectedSyncVersion: 2 },
    });
    expectStatus(created, 202);
    retriedCommand = created.body.command;

    const failed = await recordAttempt(retriedCommand.id, {
      p_outcome: 'failed',
      p_http_status: 503,
      p_error_category: 'transient',
      p_error_code: 'UPSTREAM_UNAVAILABLE',
    });
    expectStatus(failed, 200);
    expect(failed.body.command?.status).toBe('failed');
    expect(failed.body.command?.next_retry_at).not.toBeNull();
    // 失败不动版本：远端没有变化。
    expect(failed.body.mapping?.sync_version).toBe(2);

    const detail = await call<{ retryable: boolean }>(`${COMMANDS}/${retriedCommand.id}`, {
      token: opsToken,
    });
    expectStatus(detail, 200);
    expect(detail.body.retryable).toBe(true);

    const retried = await call<{ command: CommandBody }>(`${COMMANDS}/${retriedCommand.id}/retry`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'retry', reason: '上游恢复了' },
    });
    expectStatus(retried, 202);
    expect(retried.body.command.status).toBe('retrying');

    const succeeded = await recordAttempt(retriedCommand.id, {
      p_outcome: 'succeeded',
      p_response_summary: { state: 'SYNCED' },
    });
    expectStatus(succeeded, 200);
    expect(succeeded.body.command?.status).toBe('succeeded');
    expect(succeeded.body.command?.attempt_count).toBe(2);
    expect(succeeded.body.mapping?.sync_version).toBe(3);
  });

  it('永久错误不排重试，也不许重试', async () => {
    const created = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'sync_entitlement', reason: '永久错误演练', expectedSyncVersion: 3 },
    });
    expectStatus(created, 202);
    permanentCommand = created.body.command;

    const failed = await recordAttempt(permanentCommand.id, {
      p_outcome: 'failed',
      p_http_status: 400,
      p_error_category: 'permanent',
      p_error_code: 'SCHEMA_MISMATCH',
    });
    expectStatus(failed, 200);
    expect(failed.body.command?.next_retry_at).toBeNull();

    const detail = await call<{ retryable: boolean }>(`${COMMANDS}/${permanentCommand.id}`, {
      token: opsToken,
    });
    expect(detail.body.retryable).toBe(false);

    const retried = await call(`${COMMANDS}/${permanentCommand.id}/retry`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'retry', reason: '还是要重试' },
    });
    expectStatus(retried, 409);
    expect(JSON.stringify(retried.body)).toContain('PERMANENT_ERROR');
  });

  it('超时不结束命令：状态留在 pending，排下一次检查', async () => {
    const created = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'sync_entitlement', reason: '超时演练', expectedSyncVersion: 3 },
    });
    expectStatus(created, 202);
    timeoutCommand = created.body.command;

    const timedOut = await recordAttempt(timeoutCommand.id, {
      p_outcome: 'timeout',
      p_error_category: 'transient',
    });
    expectStatus(timedOut, 200);
    expect(timedOut.body.command?.status).toBe('pending');
    expect(timedOut.body.command?.next_retry_at).not.toBeNull();

    const attempts = await call<{ items: AttemptBody[]; total: number }>(
      `${COMMANDS}/${timeoutCommand.id}/attempts`,
      { token: opsToken },
    );
    expectStatus(attempts, 200);
    expect(attempts.body.total).toBe(1);
    expect(attempts.body.items[0]?.outcome).toBe('timeout');
  });

  it('尝试记录会随重试累加，按 attemptNo 升序', async () => {
    const attempts = await call<{ items: AttemptBody[]; total: number }>(
      `${COMMANDS}/${retriedCommand.id}/attempts`,
      { token: opsToken },
    );

    expectStatus(attempts, 200);
    expect(attempts.body.total).toBe(2);
    expect(attempts.body.items.map((item) => item.attemptNo)).toEqual([1, 2]);
    expect(attempts.body.items[0]?.errorCategory).toBe('transient');
  });
});

describe('取消', () => {
  it('一次都没发出去过才能取消', async () => {
    const created = await call<{ command: CommandBody }>(`${MAPPINGS}/${mapping.id}/commands`, {
      method: 'POST',
      token: opsToken,
      body: { commandType: 'sync_entitlement', reason: '建了就撤', expectedSyncVersion: 3 },
    });
    expectStatus(created, 202);

    const cancelled = await call<{ command: CommandBody }>(
      `${COMMANDS}/${created.body.command.id}/cancel`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'cancel', reason: '建错了' },
      },
    );
    expectStatus(cancelled, 200);
    expect(cancelled.body.command.status).toBe('cancelled');
    cancelledCommand = cancelled.body.command;
  });

  it('发出去过的命令回 409 COMMAND_ATTEMPTED', async () => {
    const response = await call(`${COMMANDS}/${timeoutCommand.id}/cancel`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'cancel', reason: '想撤已经发过的' },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('COMMAND_ATTEMPTED');
  });

  it('已取消的命令不能再被写成成功', async () => {
    // 「取消」意味着一次都没发出去过。此时再补一条 attempt，等于让那个前提
    // 当场失效，而取消已经据此成立过了——所以终态是不可逆的。
    const response = await restRequest<{ status: string }>('rpc/record_tenant_command_attempt', {
      method: 'POST',
      token: serviceToken,
      profile: 'ops',
      body: { p_command_id: cancelledCommand.id, p_outcome: 'succeeded' },
    });

    expectStatus(response, 200);
    expect(response.body.status).toBe('command_terminated');
  });
});
