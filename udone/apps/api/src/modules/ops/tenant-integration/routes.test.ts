import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsTenantIntegrationRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站
 * 参数怎么变成 RPC 参数。
 *
 * 规则本身（幂等键重放、期望版本是乐观锁、超时不结束命令、尝试记录不可改、
 * 永久错误不许重试、只有 service_role 能推进终态）由
 * `supabase/tests/ops_tenant_integration_domain.sql` 在真库上断言。同一条规则
 * 两处各测一遍只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 属于本层的五类例外：
 *   1. **按 `commandType` 判权限**：一个建命令端点八种命令三类权限。端点级
 *      固定判一个权限的错误实现，在这层会得到与正确实现不同的结果；
 *   2. **状态码归属**：`sync_version_mismatch` 是 409 `STATE_CONFLICT`（用户
 *      该刷新），`idempotency_conflict` 是 409 `CONFLICT`（用户该换键），
 *      弄反就是错提示；
 *   3. **202 的边界**：建命令与重试回 202，取消与查询回 200。前端据状态码
 *      决定「要不要进去轮询」；
 *   4. **PATCH 的 set_* 布尔**：`udoneOrganizationId` 没传与传 null 在 SQL 里
 *      长得一样，翻译错了就永远清不掉 `externalRef`；
 *   5. **幂等键**：全局中间件对缺键放行，写端点的 400 只能在这里证明。
 */

const MAPPING_ID = '00000000-0000-4000-8000-000000000a01';
const SECOND_MAPPING_ID = '00000000-0000-4000-8000-000000000a02';
const COMMAND_ID = '00000000-0000-4000-8000-000000000a03';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000a04';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000a05';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000a06';
const CONTRACT_ID = '00000000-0000-4000-8000-000000000a07';
const CHANGE_REQUEST_ID = '00000000-0000-4000-8000-000000000a08';
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000a09';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = [
  'tenant.read',
  'tenant.provision',
  'tenant.suspend',
  'tenant.restore',
  'tenant.retry',
  'entitlement.execute',
];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'tenant@example.test',
    operator_display_name: '交付运营',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['delivery_ops'],
    role_names: ['交付运营'],
    permission_codes: permissions,
  };
}

function mappingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MAPPING_ID,
    mapping_no: 'TM-000001',
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    product: { id: PRODUCT_ID, code: 'PRD-001', name: '标准产品' },
    udone_organization_id: null,
    external_ref: 'CRM-88',
    mapping_status: 'pending',
    last_known_state: null,
    last_synced_at: null,
    sync_version: 0,
    version: 0,
    created_at: '2026-10-31T02:00:00+00:00',
    updated_at: '2026-10-31T02:00:00+00:00',
    ...overrides,
  };
}

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMAND_ID,
    command_no: 'CMD-000001',
    mapping_id: MAPPING_ID,
    command_type: 'provision',
    customer_id: CUSTOMER_ID,
    contract_id: null,
    change_request_id: null,
    expected_sync_version: 0,
    reason: '开通租户',
    status: 'pending',
    attempt_count: 0,
    last_error_code: null,
    last_error_category: null,
    request_summary: { features: [] },
    response_summary: null,
    request_id: null,
    next_retry_at: null,
    created_by: OPERATOR_ID,
    created_at: '2026-10-31T03:00:00+00:00',
    completed_at: null,
    version: 0,
    ...overrides,
  };
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    command_id: COMMAND_ID,
    attempt_no: 1,
    started_at: '2026-10-31T03:00:00+00:00',
    finished_at: '2026-10-31T03:00:02+00:00',
    outcome: 'failed',
    http_status: 503,
    error_category: 'transient',
    request_id: 'req-1',
    response_summary: { message: 'upstream down' },
    actor_id: OPERATOR_ID,
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
app.route('/', opsTenantIntegrationRoutes);

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

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-tenant-0001' };

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

/** 路径一律从注册表取：手写路径会让「清单改了、测试没改」悄悄通过。 */
function path(template: string, values: Record<string, string> = {}) {
  let result = template;
  for (const [name, value] of Object.entries({
    mappingId: MAPPING_ID,
    commandId: COMMAND_ID,
    ...values,
  })) {
    result = result.replace(`:${name}`, value);
  }
  return result;
}

beforeEach(() => {
  rpcBodies.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /tenant-mappings', () => {
  it('把筛选与分页翻译成 RPC 参数', async () => {
    const called = stubFetch({
      rpc: { list_tenant_mappings: { status: 'ok', items: [mappingRow()], total: 1 } },
    });

    const response = await call(path(OPS_ROUTES.listOpsTenantMappings.path), {
      query: {
        customerId: CUSTOMER_ID,
        mappingStatus: 'pending',
        productId: PRODUCT_ID,
        page: '2',
      },
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(['list_tenant_mappings']);
    expect(rpcBodies[0]?.body).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_mapping_status: 'pending',
      p_product_id: PRODUCT_ID,
      p_limit: 15,
      p_offset: 15,
    });
    expect(response.body).toMatchObject({
      total: 1,
      page: 2,
      items: [{ mappingNo: 'TM-000001', syncVersion: 0, udoneOrganizationId: null }],
    });
  });

  it('非法的 mappingStatus 回 400，不去打扰 RPC', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.listOpsTenantMappings.path), {
      query: { mappingStatus: 'retired' },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });
});

describe('POST /tenant-mappings', () => {
  it('201 + 映射形状，reason 与 org id 一起透传', async () => {
    const called = stubFetch({
      rpc: { create_tenant_mapping: { status: 'ok', mapping: mappingRow() } },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantMapping.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        productId: PRODUCT_ID,
        externalRef: 'CRM-88',
        reason: '开通',
      },
    });

    expect(response.status).toBe(201);
    expect(called).toEqual(['create_tenant_mapping']);
    expect(rpcBodies[0]?.body).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_product_id: PRODUCT_ID,
      p_udone_organization_id: null,
      p_external_ref: 'CRM-88',
      p_reason: '开通',
    });
  });

  it('缺 Idempotency-Key 回 400', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.createOpsTenantMapping.path), {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, productId: PRODUCT_ID },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { field: 'Idempotency-Key' } });
    expect(called).toEqual([]);
  });

  it('租户已被别人占用是 409 CONFLICT，不是状态冲突', async () => {
    stubFetch({
      rpc: {
        create_tenant_mapping: {
          status: 'tenant_mapping_conflict',
          existing_mapping_id: SECOND_MAPPING_ID,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantMapping.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        productId: PRODUCT_ID,
        udoneOrganizationId: ORGANIZATION_ID,
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'TENANT_MAPPING_CONFLICT', existingMappingId: SECOND_MAPPING_ID },
    });
  });

  it('客户不存在是 400 而不是 404——URL 上的资源是映射，不是客户', async () => {
    stubFetch({ rpc: { create_tenant_mapping: { status: 'customer_not_found' } } });

    const response = await call(path(OPS_ROUTES.createOpsTenantMapping.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { customerId: CUSTOMER_ID, productId: PRODUCT_ID },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'CUSTOMER_NOT_FOUND' } });
  });
});

describe('GET /tenant-mappings/:mappingId', () => {
  it('详情带最近命令', async () => {
    stubFetch({
      rpc: {
        get_tenant_mapping: {
          status: 'ok',
          mapping: mappingRow({ udone_organization_id: ORGANIZATION_ID, sync_version: 2 }),
          commands: [commandRow()],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsTenantMapping.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      mapping: { udoneOrganizationId: ORGANIZATION_ID, syncVersion: 2 },
      commands: [{ commandNo: 'CMD-000001', status: 'pending' }],
    });
  });

  it('不存在回 404', async () => {
    stubFetch({ rpc: { get_tenant_mapping: { status: 'mapping_not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsTenantMapping.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /tenant-mappings/:mappingId', () => {
  it('只传 externalRef 时 set_organization 必须是 false', async () => {
    const called = stubFetch({
      rpc: { update_tenant_mapping: { status: 'ok', mapping: mappingRow({ external_ref: null }) } },
    });

    const response = await call(path(OPS_ROUTES.updateOpsTenantMapping.path), {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { externalRef: '', version: 1 },
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(['update_tenant_mapping']);
    // 传空字符串 = 清空；不传 udoneOrganizationId = 别动它。
    expect(rpcBodies[0]?.body).toMatchObject({
      p_set_organization: false,
      p_udone_organization_id: null,
      p_set_external_ref: true,
      p_external_ref: '',
      p_version: 1,
    });
  });

  it('映射已生效时改外部 ID 回 409 STATE_CONFLICT', async () => {
    stubFetch({
      rpc: {
        update_tenant_mapping: { status: 'mapping_not_pending', mapping_status: 'active' },
      },
    });

    const response = await call(path(OPS_ROUTES.updateOpsTenantMapping.path), {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { udoneOrganizationId: ORGANIZATION_ID, version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'MAPPING_NOT_PENDING', mappingStatus: 'active' },
    });
  });

  it('版本落后回 409 CONFLICT', async () => {
    stubFetch({
      rpc: { update_tenant_mapping: { status: 'version_mismatch', current_version: 4 } },
    });

    const response = await call(path(OPS_ROUTES.updateOpsTenantMapping.path), {
      method: 'PATCH',
      headers: IDEMPOTENCY_KEY,
      body: { externalRef: 'CRM-99', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: 4 },
    });
  });
});

describe('POST /tenant-mappings/:mappingId/commands', () => {
  it('202 + status=pending，命令号与 mapping 一起回', async () => {
    const called = stubFetch({
      rpc: {
        create_tenant_command: {
          status: 'ok',
          command: commandRow(),
          mapping: mappingRow(),
          replayed: false,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        commandType: 'provision',
        reason: '开通租户',
        expectedSyncVersion: 0,
        payload: { features: [{ featureKey: 'ent_feature_a' }] },
      },
    });

    expect(response.status).toBe(202);
    expect(called).toEqual(['create_tenant_command']);
    expect(rpcBodies[0]?.body).toEqual({
      p_mapping_id: MAPPING_ID,
      p_command_type: 'provision',
      p_reason: '开通租户',
      p_idempotency_key: 'idem-key-tenant-0001',
      p_contract_id: null,
      p_change_request_id: null,
      p_expected_sync_version: 0,
      p_payload: { features: [{ featureKey: 'ent_feature_a' }] },
    });
    expect(response.body).toMatchObject({ command: { status: 'pending' } });
  });

  it('sync_entitlement 的合同与变更单 ID 都进 RPC 参数', async () => {
    // 这两个外键是「这次同步凭什么发生」的唯一凭据。丢了它们，命令照样建成、
    // 照样 202，但事后没人能回答「谁批的」——所以必须在这一层就断言透传。
    stubFetch({
      rpc: {
        create_tenant_command: {
          status: 'ok',
          command: commandRow({ command_type: 'sync_entitlement', contract_id: CONTRACT_ID }),
          mapping: mappingRow(),
          replayed: false,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        commandType: 'sync_entitlement',
        reason: '合同生效，同步权益',
        expectedSyncVersion: 2,
        contractId: CONTRACT_ID,
        changeRequestId: CHANGE_REQUEST_ID,
        payload: { features: [] },
      },
    });

    expect(response.status).toBe(202);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contract_id: CONTRACT_ID,
      p_change_request_id: CHANGE_REQUEST_ID,
    });
    expect(response.body).toMatchObject({ command: { contractId: CONTRACT_ID } });
  });

  it('suspend 需要 tenant.suspend —— provision 权限不能代替它', async () => {
    const called = stubFetch({
      permissions: ['tenant.read', 'tenant.provision'],
      rpc: {},
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { commandType: 'suspend', reason: '停服', expectedSyncVersion: 2 },
    });

    expect(response.status).toBe(403);
    expect(called).toEqual([]);
  });

  it('sync_entitlement 需要 entitlement.execute', async () => {
    stubFetch({ permissions: ['tenant.read', 'tenant.suspend'], rpc: {} });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { commandType: 'sync_entitlement', reason: '同步权益', expectedSyncVersion: 2 },
    });

    expect(response.status).toBe(403);
  });

  it('同一把幂等键换一件事是 409 CONFLICT', async () => {
    stubFetch({
      rpc: {
        create_tenant_command: {
          status: 'idempotency_conflict',
          existing_command_id: COMMAND_ID,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { commandType: 'activate', reason: '激活', expectedSyncVersion: 0 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'IDEMPOTENCY_KEY_CONFLICT', existingCommandId: COMMAND_ID },
    });
  });

  it('期望版本过期是 409 STATE_CONFLICT —— 用户该刷新，而不是换个值', async () => {
    stubFetch({
      rpc: {
        create_tenant_command: { status: 'sync_version_mismatch', current_sync_version: 3 },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { commandType: 'activate', reason: '激活', expectedSyncVersion: 2 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'SYNC_VERSION_MISMATCH', currentSyncVersion: 3 },
    });
  });

  it('变更单没批回 409 且 reason 是 APPROVAL_REQUIRED', async () => {
    stubFetch({
      rpc: {
        create_tenant_command: {
          status: 'change_request_not_approved',
          change_request_status: 'pending_approval',
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        commandType: 'activate',
        reason: '激活',
        expectedSyncVersion: 2,
        changeRequestId: CHANGE_REQUEST_ID,
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'APPROVAL_REQUIRED', changeRequestStatus: 'pending_approval' },
    });
  });

  it('空 reason 在 handler 就被挡住', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.createOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { commandType: 'provision', reason: '   ', expectedSyncVersion: 0 },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });
});

describe('GET /tenant-commands', () => {
  it('status[] 与时间区间翻译成 RPC 参数', async () => {
    stubFetch({
      rpc: { list_tenant_commands: { status: 'ok', items: [commandRow()], total: 1 } },
    });

    const response = await call(path(OPS_ROUTES.listOpsTenantCommands.path), {
      query: {
        mappingId: MAPPING_ID,
        status: ['failed', 'pending'],
        commandType: 'sync_entitlement',
        createdFrom: '2026-10-01T00:00:00.000Z',
        createdTo: '2026-11-01T00:00:00.000Z',
      },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toEqual({
      p_mapping_id: MAPPING_ID,
      p_statuses: ['failed', 'pending'],
      p_command_type: 'sync_entitlement',
      p_created_from: '2026-10-01T00:00:00.000Z',
      p_created_to: '2026-11-01T00:00:00.000Z',
      p_limit: 15,
      p_offset: 0,
    });
  });
});

describe('GET /tenant-commands/:commandId', () => {
  it('详情带 attempts 与 retryable', async () => {
    stubFetch({
      rpc: {
        get_tenant_command: {
          status: 'ok',
          command: commandRow({
            status: 'failed',
            attempt_count: 1,
            last_error_category: 'transient',
          }),
          attempts: [attemptRow()],
          retryable: true,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsTenantCommand.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      command: { status: 'failed', attemptCount: 1 },
      retryable: true,
      attempts: [{ attemptNo: 1, outcome: 'failed', httpStatus: 503 }],
    });
  });

  it('不存在回 404', async () => {
    stubFetch({ rpc: { get_tenant_command: { status: 'command_not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsTenantCommand.path));

    expect(response.status).toBe(404);
  });
});

describe('GET /tenant-commands/:commandId/attempts', () => {
  it('列出全部尝试，按 attemptNo 升序', async () => {
    stubFetch({
      rpc: {
        list_tenant_command_attempts: {
          status: 'ok',
          items: [attemptRow(), attemptRow({ id: ATTEMPT_ID, attempt_no: 2, outcome: 'timeout' })],
          total: 2,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsTenantCommandAttempts.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 2,
      items: [
        { attemptNo: 1, outcome: 'failed' },
        { attemptNo: 2, outcome: 'timeout' },
      ],
    });
  });

  it('命令不存在时回 404 而不是空数组', async () => {
    stubFetch({ rpc: { list_tenant_command_attempts: { status: 'command_not_found' } } });

    const response = await call(path(OPS_ROUTES.listOpsTenantCommandAttempts.path));

    expect(response.status).toBe(404);
  });
});

describe('POST /tenant-commands/:commandId/retry', () => {
  it('202 + status=retrying', async () => {
    stubFetch({
      rpc: {
        transition_tenant_command: {
          status: 'ok',
          command: commandRow({ status: 'retrying', version: 2 }),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.retryOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'retry', reason: '上游恢复了' },
    });

    expect(response.status).toBe(202);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_command_id: COMMAND_ID,
      p_action: 'retry',
      p_reason: '上游恢复了',
    });
    expect(response.body).toMatchObject({ command: { status: 'retrying' } });
  });

  it('缺 tenant.retry 回 403', async () => {
    const called = stubFetch({ permissions: ['tenant.read', 'tenant.provision'], rpc: {} });

    const response = await call(path(OPS_ROUTES.retryOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'retry' },
    });

    expect(response.status).toBe(403);
    expect(called).toEqual([]);
  });

  it('永久错误回 409 STATE_CONFLICT，不是 403', async () => {
    stubFetch({ rpc: { transition_tenant_command: { status: 'permanent_error' } } });

    const response = await call(path(OPS_ROUTES.retryOpsTenantCommand.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'retry' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'PERMANENT_ERROR' },
    });
  });
});

describe('POST /tenant-commands/:commandId/cancel', () => {
  it('200 + status=cancelled', async () => {
    stubFetch({
      rpc: {
        transition_tenant_command: { status: 'ok', command: commandRow({ status: 'cancelled' }) },
      },
    });

    const response = await call(path(OPS_ROUTES.cancelOpsTenantCommand.path), {
      method: 'POST',
      body: { action: 'cancel', reason: '建错了' },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toMatchObject({ p_action: 'cancel' });
    expect(response.body).toMatchObject({ command: { status: 'cancelled' } });
  });

  it('已经发出去过的命令不能取消，回 409 并带 attemptCount', async () => {
    stubFetch({
      rpc: { transition_tenant_command: { status: 'command_attempted', attempt_count: 2 } },
    });

    const response = await call(path(OPS_ROUTES.cancelOpsTenantCommand.path), {
      method: 'POST',
      body: { action: 'cancel' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'COMMAND_ATTEMPTED', attemptCount: 2 },
    });
  });
});
