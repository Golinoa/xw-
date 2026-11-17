import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsDeploymentRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站
 * 参数怎么变成 RPC 参数。
 *
 * 规则本身（只有 succeeded 推进 currentVersion、from_version 必须等于当前版本、
 * 退役是终态、升级记录不可改、跨客户的授权与合同被拒）由
 * `supabase/tests/ops_deployment_domain.sql` 在真库上断言。同一条规则两处各测
 * 一遍只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 属于本层的六类例外：
 *   1. **PATCH 的补丁只放「真的传了」的键。** `null`（清空）与不传（别动）在
 *      SQL 里长得一样，翻译错了不报错、只丢数据；
 *   2. **`currentVersion` 没有入站入口**：请求体带它就该被 400 挡住，而不是
 *      解析完再悄悄忽略——静默忽略会让调用方以为改成功了；
 *   3. **两种 `version_mismatch` 落在不同的 409**：PATCH 与 transition 是
 *      `CONFLICT`（换版本号重试），登记升级是 `STATE_CONFLICT` + `VERSION_MISMATCH`
 *      （该刷新看当前版本）；
 *   4. **状态码归属**：非法迁移 409 `STATE_CONFLICT` 且**带** `allowedActions`；
 *      `go_live` 缺日期、`retire` 缺原因是 400；
 *   5. **建实例与登记升级回 201**，迁移与改档回 200——前端据状态码决定要不要
 *      把新行插进列表缓存；
 *   6. **`allowedActions` 在信封上**，不在实例里：放进实例对象等于让它跟着
 *      实例被缓存，按钮会永远停在第一次读到的状态。
 */

const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000b01';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000b02';
const LICENSE_ID = '00000000-0000-4000-8000-000000000b04';
const CONTRACT_ID = '00000000-0000-4000-8000-000000000b05';
const OWNER_ID = '00000000-0000-4000-8000-000000000b06';
const RECORD_ID = '00000000-0000-4000-8000-000000000b07';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = ['deployment.read', 'deployment.write'];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'delivery@example.test',
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

function deploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT_ID,
    instance_no: 'DEP-000001',
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    name: '甲客户主实例',
    deployment_type: 'private',
    environment_ref: 'bj-prod-01',
    current_version: '1.4.0',
    status: 'active',
    go_live_on: '2026-11-01',
    maintenance_until: '2027-11-01',
    owner: { id: OWNER_ID, display_name: '交付运营', status: 'active' },
    contract_id: CONTRACT_ID,
    license_id: LICENSE_ID,
    last_reported_at: '2026-10-31T03:00:00+00:00',
    version: 3,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-31T03:00:00+00:00',
    ...overrides,
  };
}

function versionRecordRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    instance_id: DEPLOYMENT_ID,
    from_version: '1.4.0',
    to_version: '1.5.0',
    executed_on: '2026-10-30',
    executed_by: { id: OPERATOR_ID, display_name: '交付运营' },
    result: 'succeeded',
    impact_note: '停机 20 分钟',
    rollback_note: null,
    created_at: '2026-10-30T03:00:00+00:00',
    ...overrides,
  };
}

const licenseRefRow = {
  id: LICENSE_ID,
  license_no: 'LIC-000001',
  license_mode: 'perpetual',
  status: 'active',
  valid_from: '2026-01-01',
  valid_to: null,
  maintenance_until: '2027-01-01',
};

const ticketRefRow = {
  id: '00000000-0000-4000-8000-000000000b08',
  ticket_no: 'TK-000001',
  subject: '升级后登录异常',
  priority: 'high',
  status: 'new',
};

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
app.route('/', opsDeploymentRoutes);

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

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-deploy-0001' };

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
  for (const [name, value] of Object.entries({ deploymentId: DEPLOYMENT_ID, ...values })) {
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

describe('GET /deployments', () => {
  it('把筛选与分页翻译成 RPC 参数', async () => {
    const called = stubFetch({
      rpc: {
        list_deployment_instances: { status: 'ok', items: [deploymentRow()], total: 1 },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsDeployments.path), {
      query: {
        customerId: CUSTOMER_ID,
        status: ['active', 'maintenance'],
        deploymentType: 'private',
        currentVersion: '1.4.0',
        maintenanceUntilBefore: '2027-01-01',
        page: '2',
        pageSize: '10',
      },
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(['list_deployment_instances']);
    expect(rpcBodies[0]?.body).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_statuses: ['active', 'maintenance'],
      p_deployment_type: 'private',
      p_current_version: '1.4.0',
      p_maintenance_until_before: '2027-01-01',
      p_limit: 10,
      p_offset: 10,
    });
    expect(response.body).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [{ instanceNo: 'DEP-000001', lastReportedAt: '2026-10-31T03:00:00+00:00' }],
    });
  });

  it('不传 status 时给 RPC 的是 null，不是空数组', async () => {
    stubFetch({
      rpc: { list_deployment_instances: { status: 'ok', items: [], total: 0 } },
    });

    await call(path(OPS_ROUTES.listOpsDeployments.path));

    // `null` 是「不筛」，`[]` 是「一个都不要」。两者在 SQL 里落到不同的分支，
    // 翻译错了列表会整片空白而不报错。
    expect(rpcBodies[0]?.body.p_statuses).toBeNull();
  });

  it('非法的 deploymentType 回 400，不去打扰 RPC', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.listOpsDeployments.path), {
      query: { deploymentType: 'on_premise' },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('没有 deployment.read 回 403', async () => {
    stubFetch({ permissions: [] });

    const response = await call(path(OPS_ROUTES.listOpsDeployments.path));
    expect(response.status).toBe(403);
  });
});

describe('POST /deployments', () => {
  it('201 + planned，客户之外的六个可选字段一起透传', async () => {
    stubFetch({
      rpc: {
        create_deployment_instance: {
          status: 'ok',
          deployment: deploymentRow({ status: 'planned', current_version: null }),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        name: '甲客户主实例',
        deploymentType: 'private',
        environmentRef: 'bj-prod-01',
        currentVersion: '1.4.0',
        goLiveOn: '2026-11-01',
        maintenanceUntil: '2027-11-01',
        ownerOperatorId: OWNER_ID,
        licenseId: LICENSE_ID,
        contractId: CONTRACT_ID,
      },
    });

    expect(response.status).toBe(201);
    expect(rpcBodies[0]?.body).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_name: '甲客户主实例',
      p_deployment_type: 'private',
      p_environment_ref: 'bj-prod-01',
      p_current_version: '1.4.0',
      p_go_live_on: '2026-11-01',
      p_maintenance_until: '2027-11-01',
      p_owner_operator_id: OWNER_ID,
      p_license_id: LICENSE_ID,
      p_contract_id: CONTRACT_ID,
      p_request_id: expect.any(String),
    });
    // `toEqual` 把 undefined 当成「没有这个键」，所以上面那条拦不住
    // 「忘了传 requestId」。审计要靠 requestId 串起「这一次请求」。
    // `toEqual` 把 undefined 当成「没有这个键」，而 `undefined` 在 JSON 序列化时
    // 会被整条丢掉——所以「传了但没值」和「根本没传」在线上是同一种结果。
    // 路由因此给了兜底值，这里断言它一定是个非空字符串。
    expect(typeof rpcBodies[0]?.body.p_request_id).toBe('string');
    expect(response.body).toMatchObject({ deployment: { status: 'planned' } });
  });

  it('缺 Idempotency-Key 回 400', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.createOpsDeployment.path), {
      method: 'POST',
      body: { customerId: CUSTOMER_ID, name: 'x', deploymentType: 'private' },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('同客户同名是 409 CONFLICT，不是状态冲突', async () => {
    stubFetch({
      rpc: {
        create_deployment_instance: { status: 'name_taken', name: '甲客户主实例' },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { customerId: CUSTOMER_ID, name: '甲客户主实例', deploymentType: 'private' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'DEPLOYMENT_NAME_TAKEN' },
    });
  });

  it('客户不存在是 400 而不是 404——URL 上的资源是实例，不是客户', async () => {
    stubFetch({
      rpc: { create_deployment_instance: { status: 'customer_not_found' } },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { customerId: CUSTOMER_ID, name: 'x', deploymentType: 'private' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'CUSTOMER_NOT_FOUND' } });
  });

  it('授权属于别的客户时 400 且指向 licenseId', async () => {
    stubFetch({
      rpc: { create_deployment_instance: { status: 'license_customer_mismatch' } },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        name: 'x',
        deploymentType: 'private',
        licenseId: LICENSE_ID,
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'LICENSE_CUSTOMER_MISMATCH', field: 'licenseId' },
    });
  });
});

describe('GET /deployments/{id}', () => {
  it('详情带 allowedActions 与三个关联数组', async () => {
    stubFetch({
      rpc: {
        get_deployment_instance: {
          status: 'ok',
          deployment: deploymentRow(),
          allowed_actions: ['start_maintenance', 'retire'],
          versionRecords: [versionRecordRow()],
          licenses: [licenseRefRow],
          tickets: [ticketRefRow],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsDeployment.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      allowedActions: ['start_maintenance', 'retire'],
      versionRecords: [{ toVersion: '1.5.0', executedBy: { displayName: '交付运营' } }],
      licenses: [{ licenseNo: 'LIC-000001', validTo: null }],
      tickets: [{ ticketNo: 'TK-000001' }],
    });
  });

  it('allowedActions 在信封上，不在 deployment 里', async () => {
    stubFetch({
      rpc: {
        get_deployment_instance: {
          status: 'ok',
          deployment: deploymentRow(),
          allowed_actions: ['retire'],
          versionRecords: [],
          licenses: [],
          tickets: [],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsDeployment.path));

    expect(response.body.deployment).not.toHaveProperty('allowedActions');
  });

  it('不存在回 404', async () => {
    stubFetch({ rpc: { get_deployment_instance: { status: 'not_found' } } });

    const response = await call(path(OPS_ROUTES.getOpsDeployment.path));
    expect(response.status).toBe(404);
  });

  it('出站形状不合契约时回 503，而不是把半个对象发出去', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch({
      rpc: {
        get_deployment_instance: {
          status: 'ok',
          deployment: { id: DEPLOYMENT_ID },
          allowed_actions: [],
          versionRecords: [],
          licenses: [],
          tickets: [],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsDeployment.path));
    expect(response.status).toBe(503);
  });
});

describe('PATCH /deployments/{id}', () => {
  it('只放真的传了的键', async () => {
    stubFetch({
      rpc: {
        update_deployment_instance: { status: 'ok', deployment: deploymentRow({ version: 4 }) },
      },
    });

    const response = await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { name: '甲客户主实例（改）', version: 3 },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toEqual({
      p_instance_id: DEPLOYMENT_ID,
      p_patch: { name: '甲客户主实例（改）' },
      p_expected_version: 3,
      p_request_id: expect.any(String),
    });
  });

  it('传 null 是「清空」，与不传必须分得开', async () => {
    stubFetch({
      rpc: {
        update_deployment_instance: { status: 'ok', deployment: deploymentRow({ version: 4 }) },
      },
    });

    await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { environmentRef: null, version: 3 },
    });

    expect(rpcBodies[0]?.body.p_patch).toEqual({ environmentRef: null });
  });

  it('PATCH 不需要 Idempotency-Key（契约标「可选」）', async () => {
    stubFetch({
      rpc: {
        update_deployment_instance: { status: 'ok', deployment: deploymentRow({ version: 4 }) },
      },
    });

    const response = await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { name: '甲客户主实例（改）', version: 3 },
    });

    expect(response.status).toBe(200);
  });

  it('请求体带 currentVersion 被 400 挡住，而不是静默忽略', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { currentVersion: '9.9.9', version: 3 },
    });

    // 静默忽略会让调用方以为版本改成功了——而版本只能由登记升级推进。
    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('版本落后回 409 CONFLICT 并带当前版本', async () => {
    stubFetch({
      rpc: { update_deployment_instance: { status: 'version_mismatch', current_version: 7 } },
    });

    const response = await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { name: 'x', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: 7 },
    });
  });

  it('已退役的实例改档回 409 STATE_CONFLICT', async () => {
    stubFetch({
      rpc: { update_deployment_instance: { status: 'instance_retired' } },
    });

    const response = await call(path(OPS_ROUTES.updateOpsDeployment.path), {
      method: 'PATCH',
      body: { name: 'x', version: 3 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'DEPLOYMENT_RETIRED' },
    });
  });
});

describe('POST /deployments/{id}/transition', () => {
  it('200 + 新的 allowedActions', async () => {
    stubFetch({
      rpc: {
        transition_deployment_instance: {
          status: 'ok',
          deployment: deploymentRow({ status: 'active', go_live_on: '2026-11-01' }),
          allowed_actions: ['start_maintenance', 'retire'],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'go_live', goLiveOn: '2026-11-01', version: 0 },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toEqual({
      p_instance_id: DEPLOYMENT_ID,
      p_action: 'go_live',
      p_reason: null,
      p_go_live_on: '2026-11-01',
      p_expected_version: 0,
      p_request_id: expect.any(String),
    });
    expect(response.body).toMatchObject({ allowedActions: ['start_maintenance', 'retire'] });
  });

  it('非法边回 409 STATE_CONFLICT 并带 allowedActions 与当前状态', async () => {
    stubFetch({
      rpc: {
        transition_deployment_instance: {
          status: 'invalid_transition',
          current_status: 'retired',
          allowed_actions: [],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'go_live', version: 0 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION', currentStatus: 'retired' },
    });
  });

  it('retire 缺 reason 回 400', async () => {
    stubFetch({
      rpc: { transition_deployment_instance: { status: 'reason_required' } },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'retire', version: 3 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'REASON_REQUIRED' } });
  });

  it('go_live 缺 goLiveOn 回 400 且指向字段', async () => {
    stubFetch({
      rpc: { transition_deployment_instance: { status: 'go_live_on_required' } },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'go_live', version: 0 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'GO_LIVE_ON_REQUIRED', field: 'goLiveOn' },
    });
  });

  it('没有 deployment.write 回 403', async () => {
    stubFetch({ permissions: ['deployment.read'] });

    const response = await call(path(OPS_ROUTES.transitionOpsDeployment.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'retire', reason: '客户退租', version: 3 },
    });

    expect(response.status).toBe(403);
  });
});

describe('POST /deployments/{id}/version-records', () => {
  it('201 + 记录与更新后的实例', async () => {
    stubFetch({
      rpc: {
        create_deployment_version_record: {
          status: 'ok',
          version_record: versionRecordRow(),
          deployment: deploymentRow({ current_version: '1.5.0', last_reported_at: null }),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeploymentVersionRecord.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        fromVersion: '1.4.0',
        toVersion: '1.5.0',
        executedOn: '2026-10-30',
        result: 'succeeded',
        impactNote: '停机 20 分钟',
      },
    });

    expect(response.status).toBe(201);
    expect(rpcBodies[0]?.body).toEqual({
      p_instance_id: DEPLOYMENT_ID,
      p_from_version: '1.4.0',
      p_to_version: '1.5.0',
      p_executed_on: '2026-10-30',
      p_result: 'succeeded',
      p_impact_note: '停机 20 分钟',
      p_rollback_note: null,
      p_request_id: expect.any(String),
    });
    expect(response.body).toMatchObject({
      versionRecord: { result: 'succeeded' },
      deployment: { currentVersion: '1.5.0' },
    });
  });

  it('起点版本不符回 409 STATE_CONFLICT，不是 CONFLICT', async () => {
    stubFetch({
      rpc: {
        create_deployment_version_record: {
          status: 'version_mismatch',
          current_version: '1.5.0',
          from_version: '1.4.0',
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeploymentVersionRecord.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        fromVersion: '1.4.0',
        toVersion: '1.6.0',
        executedOn: '2026-10-30',
        result: 'succeeded',
      },
    });

    // 这里不是乐观锁：用户该刷新看一眼当前版本，而不是换个数字重试。
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: '1.5.0', fromVersion: '1.4.0' },
    });
  });

  it('实例不存在回 404', async () => {
    stubFetch({
      rpc: { create_deployment_version_record: { status: 'not_found' } },
    });

    const response = await call(path(OPS_ROUTES.createOpsDeploymentVersionRecord.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        executedOn: '2026-10-30',
        result: 'failed',
      },
    });

    expect(response.status).toBe(404);
  });

  it('非法 result 不去打扰 RPC', async () => {
    const called = stubFetch({});

    const response = await call(path(OPS_ROUTES.createOpsDeploymentVersionRecord.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        executedOn: '2026-10-30',
        result: 'partial',
      },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });
});

describe('GET /deployments/{id}/version-records', () => {
  it('分页翻译成 RPC 参数', async () => {
    stubFetch({
      rpc: {
        list_deployment_version_records: {
          status: 'ok',
          items: [versionRecordRow()],
          total: 1,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsDeploymentVersionRecords.path), {
      query: { page: '3', pageSize: '30' },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toEqual({
      p_instance_id: DEPLOYMENT_ID,
      p_limit: 30,
      p_offset: 60,
    });
    expect(response.body).toMatchObject({ total: 1, page: 3, pageSize: 30 });
  });

  it('实例不存在时回 404 而不是空数组', async () => {
    stubFetch({ rpc: { list_deployment_version_records: { status: 'not_found' } } });

    const response = await call(path(OPS_ROUTES.listOpsDeploymentVersionRecords.path));
    expect(response.status).toBe(404);
  });
});
