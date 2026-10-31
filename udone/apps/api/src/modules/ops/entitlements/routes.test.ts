import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsEntitlementRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 信封 → 契约的状态码 / 错误码 / 字段名，以及入站
 * 参数怎么变成 RPC 参数。
 *
 * 规则本身（快照不可变、变更基线是当前快照、未审批不下发、申请人不能自批、
 * 永久授权不带有效期）由 `supabase/tests/ops_entitlement_domain.sql` 在真库上
 * 断言。同一条规则两处各测一遍，只会得到一个错觉：以为改了库还安全，因为
 * 这里是绿的。
 *
 * 属于本层的四类例外：
 *   1. **按动作判权限**：一个 `transition` 端点三种权限，端点级固定判一个权限
 *      的错误实现，在这层会得到与正确实现不同的结果——这是唯一能证明它的地方；
 *   2. **状态码归属**：`approval_required` 是 409、`segregation_of_duty` 是 403、
 *      金额无关的重复是 409 `CONFLICT`。前端按不同分支渲染，弄反就是错提示；
 *   3. **202 的边界**：`suspend`/`resume`/`revoke` 回 202 且 `command` 为 null，
 *      其余动作回 200。前端据状态码决定「要不要进去轮询命令」；
 *   4. **幂等键**：全局中间件对缺键放行，七个写端点的 400 只能在这里证明。
 */

const SUBSCRIPTION_ID = '00000000-0000-4000-8000-000000000901';
const LICENSE_ID = '00000000-0000-4000-8000-000000000902';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000000903';
const CHANGE_REQUEST_ID = '00000000-0000-4000-8000-000000000904';
const CONTRACT_ID = '00000000-0000-4000-8000-000000000905';
const CONTRACT_ITEM_ID = '00000000-0000-4000-8000-000000000906';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000907';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000908';
const PACKAGE_ID = '00000000-0000-4000-8000-000000000909';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';
const INSTANCE_ID = '00000000-0000-4000-8000-00000000090a';

const ALL_PERMISSIONS = [
  'entitlement.read',
  'entitlement.request',
  'entitlement.approve',
  'entitlement.execute',
  'tenant.retry',
];

const CONTENT_HASH = 'a'.repeat(64);

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'entitlement@example.test',
    operator_display_name: '权益运营',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 1,
    last_login_at: null,
    role_codes: ['sales_ops'],
    role_names: ['销售运营'],
    permission_codes: permissions,
  };
}

function operatorRef() {
  return { id: OPERATOR_ID, display_name: '权益运营' };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAPSHOT_ID,
    customer_id: CUSTOMER_ID,
    source_type: 'contract_item',
    source_id: CONTRACT_ITEM_ID,
    target_scope: 'saas_tenant',
    target_ref: null,
    valid_from: '2026-01-01',
    valid_to: '2027-12-31',
    content_hash: CONTENT_HASH,
    line_count: 2,
    created_at: '2026-01-01T02:00:00+00:00',
    ...overrides,
  };
}

function snapshotLineRow(overrides: Record<string, unknown> = {}) {
  return {
    feature_key: 'feature_a',
    enabled: true,
    quota_value: null,
    term_months: null,
    display_name_snapshot: '基础功能',
    ...overrides,
  };
}

function subscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIPTION_ID,
    subscription_no: 'SUB-000001',
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    contract_id: CONTRACT_ID,
    contract_no: 'HT-000001',
    contract_item_id: CONTRACT_ITEM_ID,
    product: { id: PRODUCT_ID, code: 'PRD-001', name: '标准产品' },
    package: { id: PACKAGE_ID, internal_name: '标准版', customer_name: '标准版' },
    billing_cycle: 'yearly',
    starts_on: '2026-01-01',
    ends_on: '2027-12-31',
    auto_renew_intent: true,
    status: 'draft',
    current_snapshot_id: SNAPSHOT_ID,
    snapshot: snapshotRow(),
    version: 1,
    created_at: '2026-01-01T02:00:00+00:00',
    updated_at: '2026-01-01T02:00:00+00:00',
    ...overrides,
  };
}

function licenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LICENSE_ID,
    license_no: 'LIC-000001',
    customer: { id: CUSTOMER_ID, customer_no: 'CUS-000001', name: '示例旅行社' },
    contract_id: CONTRACT_ID,
    contract_no: 'HT-000001',
    contract_item_id: CONTRACT_ITEM_ID,
    deployment_instance_id: INSTANCE_ID,
    license_mode: 'perpetual',
    valid_from: '2026-02-01',
    valid_to: null,
    maintenance_until: '2027-02-01',
    status: 'draft',
    current_snapshot_id: SNAPSHOT_ID,
    snapshot: snapshotRow({ target_scope: 'private_instance', target_ref: INSTANCE_ID }),
    version: 1,
    created_at: '2026-02-01T02:00:00+00:00',
    updated_at: '2026-02-01T02:00:00+00:00',
    ...overrides,
  };
}

function changeRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANGE_REQUEST_ID,
    subject_type: 'subscription',
    subject_id: SUBSCRIPTION_ID,
    subject_no: 'SUB-000001',
    change_type: 'quota_change',
    status: 'pending_approval',
    source_contract_id: CONTRACT_ID,
    proposed_snapshot_id: SNAPSHOT_ID,
    proposed_snapshot: snapshotRow(),
    reason: '客户扩席',
    before_summary: { lines: [snapshotLineRow()] },
    after_summary: {
      lines: [snapshotLineRow(), snapshotLineRow({ feature_key: 'feature_b', quota_value: 20 })],
    },
    requested_by: operatorRef(),
    approved_by: null,
    approved_at: null,
    executed_at: null,
    command_id: null,
    version: 1,
    created_at: '2026-03-01T02:00:00+00:00',
    updated_at: '2026-03-01T02:00:00+00:00',
    ...overrides,
  };
}

function diffRow() {
  return {
    before: { lines: [snapshotLineRow()] },
    after: {
      lines: [snapshotLineRow(), snapshotLineRow({ feature_key: 'feature_b', quota_value: 20 })],
    },
    added: [snapshotLineRow({ feature_key: 'feature_b', quota_value: 20 })],
    removed: [],
    changed: [],
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
app.route('/', opsEntitlementRoutes);

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

const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-entitlement-0001' };

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
  for (const [name, value] of Object.entries({
    subscriptionId: SUBSCRIPTION_ID,
    licenseId: LICENSE_ID,
    changeRequestId: CHANGE_REQUEST_ID,
    snapshotId: SNAPSHOT_ID,
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

describe('GET /subscriptions', () => {
  it('把筛选与分页翻译成 RPC 参数', async () => {
    const called = stubFetch({
      rpc: {
        list_subscriptions: { status: 'ok', items: [subscriptionRow()], total: 1 },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsSubscriptions.path), {
      query: {
        customerId: CUSTOMER_ID,
        status: ['active', 'suspended'],
        productId: PRODUCT_ID,
        expiringInDays: '30',
        page: '2',
        pageSize: '30',
      },
    });

    expect(response.status).toBe(200);
    expect(called).toEqual(['list_subscriptions']);
    expect(rpcBodies[0]?.body).toEqual({
      p_customer_id: CUSTOMER_ID,
      p_statuses: ['active', 'suspended'],
      p_product_id: PRODUCT_ID,
      p_expiring_in_days: 30,
      p_limit: 30,
      p_offset: 30,
    });
    expect(response.body).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 30,
      items: [{ id: SUBSCRIPTION_ID, status: 'draft', billingCycle: 'yearly' }],
    });
  });

  it('没有 entitlement.read 时 403', async () => {
    stubFetch({ permissions: [] });
    const response = await call(path(OPS_ROUTES.listOpsSubscriptions.path));
    expect(response.status).toBe(403);
  });
});

describe('POST /subscriptions', () => {
  it('建草案回 201，快照形状跟着转', async () => {
    stubFetch({
      rpc: {
        create_subscription: {
          status: 'ok',
          subscription: subscriptionRow(),
          snapshot: snapshotRow(),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        endsOn: '2027-12-31',
        features: [{ featureKey: 'feature_c', termMonths: 12 }],
      },
    });

    expect(response.status).toBe(201);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_customer_id: CUSTOMER_ID,
      p_contract_item_id: CONTRACT_ITEM_ID,
      p_billing_cycle: 'yearly',
      p_starts_on: '2026-01-01',
      p_features: [{ featureKey: 'feature_c', termMonths: 12 }],
    });
    expect(response.body).toMatchObject({
      subscription: { subscriptionNo: 'SUB-000001' },
      snapshot: { contentHash: CONTENT_HASH, lineCount: 2 },
    });
  });

  it('缺 Idempotency-Key 时 400', async () => {
    stubFetch();
    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { field: 'Idempotency-Key' } });
  });

  it('拒绝多余字段（strictObject），且不落到 RPC', async () => {
    const called = stubFetch();
    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        // 客户端的常见误解：以为能指定快照名称。快照名一律取字典当时的写法。
        displayNameSnapshot: '伪造的名称',
      },
    });

    expect(response.status).toBe(400);
    expect(called).toEqual([]);
  });

  it('合同未生效回 409 STATE_CONFLICT 而不是 400', async () => {
    stubFetch({
      rpc: {
        create_subscription: { status: 'contract_not_active', contract_status: 'draft' },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTRACT_NOT_ACTIVE', contractStatus: 'draft' },
    });
  });

  it('客户与合同不一致回 400 CUSTOMER_MISMATCH，并带上合同的客户', async () => {
    stubFetch({
      rpc: {
        create_subscription: {
          status: 'customer_mismatch',
          contract_customer_id: CUSTOMER_ID,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'CUSTOMER_MISMATCH', contractCustomerId: CUSTOMER_ID },
    });
  });

  it('重复开通回 409 CONFLICT（与状态无关）', async () => {
    stubFetch({ rpc: { create_subscription: { status: 'duplicate_subscription' } } });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('不认识的 featureKey 回 400 并指出是哪一个', async () => {
    stubFetch({
      rpc: {
        create_subscription: { status: 'feature_unknown', feature_key: 'feature_zzz' },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        features: [{ featureKey: 'feature_zzz' }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'FEATURE_UNKNOWN', featureKey: 'feature_zzz' },
    });
  });

  it('同一 featureKey 出现两次回 400 FEATURE_DUPLICATE', async () => {
    stubFetch({ rpc: { create_subscription: { status: 'feature_duplicate' } } });

    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        features: [{ featureKey: 'feature_a' }, { featureKey: 'feature_a' }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'FEATURE_DUPLICATE' } });
  });

  it('只有 entitlement.read 时 403，且不落到 RPC', async () => {
    const called = stubFetch({ permissions: ['entitlement.read'] });
    const response = await call(path(OPS_ROUTES.createOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expect(response.status).toBe(403);
    expect(called).toEqual([]);
  });
});

describe('GET /subscriptions/:subscriptionId', () => {
  it('详情带 changeRequests 与恒为 null 的 tenantMapping', async () => {
    stubFetch({
      rpc: {
        get_subscription: {
          status: 'ok',
          subscription: subscriptionRow(),
          snapshot: { ...snapshotRow(), lines: [snapshotLineRow()] },
          change_requests: [changeRequestRow()],
          tenant_mapping: null,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsSubscription.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      subscription: { id: SUBSCRIPTION_ID },
      snapshot: { lineCount: 2, lines: [{ featureKey: 'feature_a', enabled: true }] },
      changeRequests: [{ changeType: 'quota_change', status: 'pending_approval' }],
      tenantMapping: null,
    });
  });

  it('不存在时 404', async () => {
    stubFetch({ rpc: { get_subscription: { status: 'subscription_not_found' } } });
    const response = await call(path(OPS_ROUTES.getOpsSubscription.path));
    expect(response.status).toBe(404);
  });
});

describe('POST /subscriptions/:subscriptionId/transition', () => {
  it('submit 回 200，command 为 null', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_subject: {
          status: 'ok',
          subscription: subscriptionRow({ status: 'pending_approval', version: 2 }),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'submit', version: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      subscription: { status: 'pending_approval', version: 2 },
      command: null,
    });
  });

  it('suspend 回 202（命令表未落地，command 仍为 null）', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_subject: {
          status: 'ok',
          subscription: subscriptionRow({ status: 'suspended', version: 3 }),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'suspend', reason: '客户欠费' },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ subscription: { status: 'suspended' }, command: null });
  });

  it('未审批即下发回 409 APPROVAL_REQUIRED', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_subject: {
          status: 'approval_required',
          current_status: 'draft',
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'suspend', reason: '想直接停掉' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'APPROVAL_REQUIRED' },
    });
  });

  it('非法迁移回 409 并带 allowedActions', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_subject: {
          status: 'invalid_transition',
          current_status: 'active',
          allowed_actions: ['suspend', 'revoke', 'mark_expired'],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'submit' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      details: {
        reason: 'INVALID_TRANSITION',
        allowedActions: ['suspend', 'revoke', 'mark_expired'],
      },
    });
  });

  it('缺 reason 时 400 REASON_REQUIRED', async () => {
    stubFetch({
      rpc: { transition_entitlement_subject: { status: 'reason_required' } },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'suspend' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { reason: 'REASON_REQUIRED' } });
  });

  it('版本落后回 409 CONFLICT', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_subject: { status: 'version_mismatch', current_version: 2 },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve', version: 1 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'VERSION_MISMATCH', currentVersion: 2 },
    });
  });

  it('approve 需要 entitlement.approve，只有 request 时 403', async () => {
    const called = stubFetch({ permissions: ['entitlement.read', 'entitlement.request'] });
    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve' },
    });

    expect(response.status).toBe(403);
    expect(called).toEqual([]);
  });

  it('submit 只要 entitlement.request，不需要 approve', async () => {
    stubFetch({
      permissions: ['entitlement.read', 'entitlement.request'],
      rpc: {
        transition_entitlement_subject: { status: 'ok', subscription: subscriptionRow() },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsSubscription.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'submit' },
    });

    expect(response.status).toBe(200);
  });
});

describe('POST /licenses', () => {
  it('建永久授权回 201，validTo 为空', async () => {
    stubFetch({
      rpc: {
        create_license: { status: 'ok', license: licenseRow(), snapshot: snapshotRow() },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsLicense.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        deploymentInstanceId: INSTANCE_ID,
        licenseMode: 'perpetual',
        validFrom: '2026-02-01',
        maintenanceUntil: '2027-02-01',
      },
    });

    expect(response.status).toBe(201);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_license_mode: 'perpetual',
      p_valid_to: null,
      p_maintenance_until: '2027-02-01',
    });
    expect(response.body).toMatchObject({ license: { licenseMode: 'perpetual', validTo: null } });
  });

  it('永久授权带 validTo 回 400（T-09 验收断言）', async () => {
    stubFetch({ rpc: { create_license: { status: 'perpetual_with_valid_to' } } });

    const response = await call(path(OPS_ROUTES.createOpsLicense.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        licenseMode: 'perpetual',
        validFrom: '2026-02-01',
        validTo: '2029-02-01',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'PERPETUAL_WITH_VALID_TO', field: 'validTo' },
    });
  });

  it('期限授权缺 validTo 也回 400（反方向）', async () => {
    stubFetch({ rpc: { create_license: { status: 'term_requires_valid_to' } } });

    const response = await call(path(OPS_ROUTES.createOpsLicense.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        licenseMode: 'term',
        validFrom: '2026-02-01',
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'TERM_REQUIRES_VALID_TO' },
    });
  });

  it('同一实例已有有效授权回 409 CONFLICT', async () => {
    stubFetch({ rpc: { create_license: { status: 'duplicate_license' } } });

    const response = await call(path(OPS_ROUTES.createOpsLicense.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        customerId: CUSTOMER_ID,
        contractItemId: CONTRACT_ITEM_ID,
        deploymentInstanceId: INSTANCE_ID,
        licenseMode: 'term',
        validFrom: '2026-02-01',
        validTo: '2027-02-01',
      },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });
});

describe('GET /licenses', () => {
  it('把 expiringInDays 与 deploymentInstanceId 传给 RPC', async () => {
    stubFetch({ rpc: { list_licenses: { status: 'ok', items: [licenseRow()], total: 1 } } });

    const response = await call(path(OPS_ROUTES.listOpsLicenses.path), {
      query: { expiringInDays: '15', deploymentInstanceId: INSTANCE_ID },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_expiring_in_days: 15,
      p_deployment_instance_id: INSTANCE_ID,
    });
  });
});

describe('GET /licenses/:licenseId', () => {
  it('详情带恒为 null 的 deployment', async () => {
    stubFetch({
      rpc: {
        get_license: {
          status: 'ok',
          license: licenseRow(),
          snapshot: { ...snapshotRow(), lines: [snapshotLineRow()] },
          change_requests: [],
          deployment: null,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsLicense.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      license: { licenseNo: 'LIC-000001' },
      deployment: null,
      changeRequests: [],
    });
  });
});

describe('POST /subscriptions/:subscriptionId/change-requests', () => {
  it('建变更单回 201，diff 转成 camelCase', async () => {
    stubFetch({
      rpc: {
        create_entitlement_change_request: {
          status: 'ok',
          change_request: changeRequestRow(),
          diff: diffRow(),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscriptionChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        changeType: 'quota_change',
        reason: '客户扩席',
        proposedFeatures: [{ featureKey: 'feature_b', quota: 20 }],
      },
    });

    expect(response.status).toBe(201);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_subject_type: 'subscription',
      p_subject_id: SUBSCRIPTION_ID,
      p_change_type: 'quota_change',
    });
    expect(response.body).toMatchObject({
      changeRequest: { status: 'pending_approval' },
      diff: { added: [{ featureKey: 'feature_b', quota: 20 }], removed: [] },
    });
  });

  it('订阅非 active/suspended 回 409 SUBJECT_NOT_ACTIVE', async () => {
    stubFetch({
      rpc: {
        create_entitlement_change_request: {
          status: 'subject_not_active',
          current_status: 'draft',
        },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscriptionChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { changeType: 'upgrade', reason: '草案上直接升级' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      details: { reason: 'SUBJECT_NOT_ACTIVE', currentStatus: 'draft' },
    });
  });

  it('额度为负回 400 FEATURE_INVALID', async () => {
    stubFetch({
      rpc: {
        create_entitlement_change_request: { status: 'feature_invalid', feature_key: 'feature_b' },
      },
    });

    const response = await call(path(OPS_ROUTES.createOpsSubscriptionChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        changeType: 'quota_change',
        reason: '负数试试',
        proposedFeatures: [{ featureKey: 'feature_b', quota: 5 }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      details: { reason: 'FEATURE_INVALID', featureKey: 'feature_b' },
    });
  });
});

describe('POST /entitlement-change-requests/:changeRequestId/transition', () => {
  it('申请人自批回 403 并带 rule', async () => {
    stubFetch({
      rpc: { transition_entitlement_change_request: { status: 'segregation_of_duty' } },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'approve' },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'SEGREGATION_OF_DUTY', rule: 'SEGREGATION_OF_DUTY' },
    });
  });

  it('execute 回 202', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_change_request: {
          status: 'ok',
          change_request: changeRequestRow({ status: 'executed' }),
          diff: diffRow(),
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'execute' },
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ changeRequest: { status: 'executed' }, command: null });
  });

  it('未审批就执行回 409 APPROVAL_REQUIRED', async () => {
    stubFetch({
      rpc: {
        transition_entitlement_change_request: {
          status: 'approval_required',
          current_status: 'pending_approval',
        },
      },
    });

    const response = await call(path(OPS_ROUTES.transitionOpsChangeRequest.path), {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'execute' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      details: { reason: 'APPROVAL_REQUIRED' },
    });
  });
});

describe('GET /entitlement-change-requests', () => {
  it('把 subjectType 与 status[] 传给 RPC', async () => {
    stubFetch({
      rpc: {
        list_entitlement_change_requests: {
          status: 'ok',
          items: [changeRequestRow()],
          total: 1,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsChangeRequests.path), {
      query: { subjectType: 'license', status: ['pending_approval', 'approved'] },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_subject_type: 'license',
      p_statuses: ['pending_approval', 'approved'],
    });
  });
});

describe('GET /entitlement-change-requests/:changeRequestId', () => {
  it('详情带 diff 与 command:null', async () => {
    stubFetch({
      rpc: {
        get_entitlement_change_request: {
          status: 'ok',
          change_request: changeRequestRow(),
          diff: diffRow(),
          command: null,
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsChangeRequest.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      changeRequest: { subjectNo: 'SUB-000001' },
      diff: { changed: [] },
      command: null,
    });
  });
});

describe('GET /entitlement-snapshots', () => {
  it('把 subject 与时间窗传给 RPC', async () => {
    stubFetch({
      rpc: {
        list_entitlement_snapshots: { status: 'ok', items: [snapshotRow()], total: 1 },
      },
    });

    const response = await call(path(OPS_ROUTES.listOpsEntitlementSnapshots.path), {
      query: {
        subjectType: 'subscription',
        subjectId: SUBSCRIPTION_ID,
        validFromFrom: '2026-01-01',
        validFromTo: '2026-12-31',
        sourceType: 'change_request',
      },
    });

    expect(response.status).toBe(200);
    expect(rpcBodies[0]?.body).toMatchObject({
      p_subject_type: 'subscription',
      p_subject_id: SUBSCRIPTION_ID,
      p_valid_from_from: '2026-01-01',
      p_source_type: 'change_request',
    });
  });
});

describe('GET /entitlement-snapshots/:snapshotId', () => {
  it('详情把 lines 逐行转成 camelCase', async () => {
    stubFetch({
      rpc: {
        get_entitlement_snapshot: {
          status: 'ok',
          snapshot: snapshotRow(),
          lines: [
            snapshotLineRow(),
            snapshotLineRow({ feature_key: 'feature_b', quota_value: 10 }),
          ],
        },
      },
    });

    const response = await call(path(OPS_ROUTES.getOpsEntitlementSnapshot.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      lines: [
        { featureKey: 'feature_a', displayNameSnapshot: '基础功能' },
        { featureKey: 'feature_b', quota: 10 },
      ],
    });
  });

  it('不存在时 404', async () => {
    stubFetch({ rpc: { get_entitlement_snapshot: { status: 'snapshot_not_found' } } });
    const response = await call(path(OPS_ROUTES.getOpsEntitlementSnapshot.path));
    expect(response.status).toBe(404);
  });

  it('出站形状违约时 503 而不是 400', async () => {
    stubFetch({
      rpc: {
        get_entitlement_snapshot: {
          status: 'ok',
          // content_hash 只有 3 位：形状校验必须拦住，而不是让一个短哈希流到前端。
          snapshot: snapshotRow({ content_hash: 'abc' }),
          lines: [],
        },
      },
    });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(path(OPS_ROUTES.getOpsEntitlementSnapshot.path));
    expect(response.status).toBe(503);
  });
});
