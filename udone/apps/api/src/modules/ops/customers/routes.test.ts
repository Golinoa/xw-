import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPS_ROUTES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { errorHandler } from '../../../middleware/error-handler';
import { opsCustomerRoutes } from './routes';

/**
 * 这一层测的是**翻译**：RPC 的信封 → 契约的状态码/错误码/字段名。
 *
 * 它不测「规则是否成立」——客户状态机守卫（`contacts_required`、`referenced`）、
 * 主要联系人唯一性、乐观锁都由 pgTAP 在真实库上断言。同一条规则在两处各测一遍，
 * 只会得到一个错觉：以为改了库还安全，因为这里是绿的。
 *
 * 有一条例外确实属于本层：**敏感字段的形状**（P6）。它不是库里的规则，而是
 * 「响应里能不能出现某个键」这件事，发生在 Worker 的映射与 `respond()` 之间，
 * 只有这一层能证明「无权限时键不存在、半边形状被拒」。
 */

const CUSTOMER_ID = '00000000-0000-4000-8000-000000000101';
const CONTACT_ID = '00000000-0000-4000-8000-000000000201';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

const ALL_PERMISSIONS = ['customer.read', 'customer.write', 'customer.sensitive.read'];

function opsContextRow(permissions: string[]) {
  return {
    operator_id: OPERATOR_ID,
    operator_email: 'admin@example.test',
    operator_display_name: '管理员',
    operator_status: 'active',
    mfa_required: false,
    permission_version: 3,
    last_login_at: null,
    role_codes: ['platform_admin'],
    role_names: ['平台管理员'],
    permission_codes: permissions,
  };
}

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    customer_no: 'CUS-2026-000101',
    name: '海蓝旅行社',
    unified_social_credit_code: null,
    region_code: '310000',
    status: 'signed',
    owner: { id: OPERATOR_ID, display_name: '张三', email: 'owner@example.test' },
    source_note: null,
    internal_note: '内部备注',
    version: 1,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function customerListRow(overrides: Record<string, unknown> = {}) {
  return {
    ...customerRow(),
    primary_contact: { masked_phone: '138****8000', masked_email: 'l****@example.test' },
    active_contract_count: 2,
    ...overrides,
  };
}

/** 无原值键：`phone`/`email` 连键都没有，这是无 `customer.sensitive.read` 时的唯一合法形状。 */
function contactPlainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    name: '李四',
    job_title: '采购经理',
    phone_masked: '138****8000',
    email_masked: 'l****@example.test',
    is_primary: true,
    usage_scene: '合同签署',
    version: 1,
    created_at: '2026-10-01T02:00:00+00:00',
    updated_at: '2026-10-02T02:00:00+00:00',
    ...overrides,
  };
}

function contactSensitiveRow(overrides: Record<string, unknown> = {}) {
  return {
    ...contactPlainRow(),
    phone: '13800008000',
    email: 'li@example.test',
    ...overrides,
  };
}

const counts = {
  contracts: 2,
  receivables: 3,
  subscriptions: 1,
  licenses: 1,
  deployments: 1,
  tickets: 0,
};

interface StubOptions {
  permissions?: string[];
  /** `rpc/<name>` → 响应体。没给的名字一律当作「不该被调用」。 */
  rpc?: Record<string, unknown>;
  rpcStatus?: Record<string, number>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 每次 RPC 调用的请求体。
 *
 * 契约字段是否真的透传下去（`p_statuses` 是不是数组、省略的字段是不是 `null`）
 * 只能从请求体看出来——响应正确但参数被吞掉，是最容易漏的一类回归。
 * 模块级而不是单次 stub 的返回值：同一个用例里会换几套响应，请求体要累积下来。
 */
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
    const status = options.rpcStatus?.[rpcName] ?? 200;
    return json(options.rpc?.[rpcName], status);
  });

  vi.stubGlobal('fetch', fetchMock);
  return called;
}

const app = new Hono<ApiEnvironment>();
app.onError(errorHandler);
app.route('/', opsCustomerRoutes);

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

/** 幂等键是这三个写端点的必填项；除了专门测缺失的用例，其余都带上。 */
const IDEMPOTENCY_KEY = { 'Idempotency-Key': 'idem-key-0001' };

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** 路径一律从注册表取：测试里手写路径会让「清单改了、测试没改」悄悄通过。 */
function customerPath(template: string): string {
  return template.replace(':customerId', CUSTOMER_ID);
}

function contactPath(template: string, contactId = CONTACT_ID): string {
  return template.replace(':customerId', CUSTOMER_ID).replace(':contactId', contactId);
}

afterEach(() => {
  vi.unstubAllGlobals();
  rpcBodies.length = 0;
});

describe('route registry', () => {
  it('keeps the eleven customer keys on the documented method and path', () => {
    const keys = [
      'listOpsCustomers',
      'createOpsCustomer',
      'checkOpsCustomerDuplicates',
      'getOpsCustomer',
      'updateOpsCustomer',
      'transitionOpsCustomer',
      'getOpsCustomerOverview',
      'listOpsCustomerContacts',
      'createOpsCustomerContact',
      'updateOpsCustomerContact',
      'deleteOpsCustomerContact',
    ] as const satisfies readonly (keyof typeof OPS_ROUTES)[];

    expect(
      Object.fromEntries(
        keys.map((key) => [key, `${OPS_ROUTES[key].method} ${OPS_ROUTES[key].path}`]),
      ),
    ).toEqual({
      listOpsCustomers: 'GET /api/v1/ops/customers',
      createOpsCustomer: 'POST /api/v1/ops/customers',
      checkOpsCustomerDuplicates: 'POST /api/v1/ops/customers/duplicate-check',
      getOpsCustomer: 'GET /api/v1/ops/customers/:customerId',
      updateOpsCustomer: 'PATCH /api/v1/ops/customers/:customerId',
      transitionOpsCustomer: 'POST /api/v1/ops/customers/:customerId/transition',
      getOpsCustomerOverview: 'GET /api/v1/ops/customers/:customerId/overview',
      listOpsCustomerContacts: 'GET /api/v1/ops/customers/:customerId/contacts',
      createOpsCustomerContact: 'POST /api/v1/ops/customers/:customerId/contacts',
      updateOpsCustomerContact: 'PATCH /api/v1/ops/customers/:customerId/contacts/:contactId',
      deleteOpsCustomerContact: 'DELETE /api/v1/ops/customers/:customerId/contacts/:contactId',
    });
  });
});

describe('GET /api/v1/ops/customers', () => {
  it('maps the list row and echoes the page window', async () => {
    stubFetch({ rpc: { list_customers: { items: [customerListRow()], total: 41 } } });

    const response = await call(OPS_ROUTES.listOpsCustomers.path, {
      query: { page: '2', pageSize: '20' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: CUSTOMER_ID,
          customerNo: 'CUS-2026-000101',
          name: '海蓝旅行社',
          unifiedSocialCreditCode: null,
          regionCode: '310000',
          status: 'signed',
          owner: { id: OPERATOR_ID, displayName: '张三', email: 'owner@example.test' },
          sourceNote: null,
          internalNote: '内部备注',
          version: 1,
          createdAt: '2026-10-01T02:00:00+00:00',
          updatedAt: '2026-10-02T02:00:00+00:00',
          primaryContact: { maskedPhone: '138****8000', maskedEmail: 'l****@example.test' },
          activeContractCount: 2,
        },
      ],
      total: 41,
      page: 2,
      pageSize: 20,
    });
  });

  it('translates the contract sort key to the column the SQL ladder matches', async () => {
    const called = stubFetch({ rpc: { list_customers: { items: [], total: 0 } } });

    await call(OPS_ROUTES.listOpsCustomers.path, { query: { sort: 'updatedAt', order: 'asc' } });

    expect(called).toEqual(['list_customers']);
    // 传 `updatedAt` 下去会让 SQL 的 CASE 阶梯全部落空，静默退化成兜底排序。
    expect(rpcBodies[0]?.body).toMatchObject({ p_sort: 'updated_at', p_order: 'asc' });
  });

  it('keeps every repeated status parameter instead of the first one', async () => {
    stubFetch({ rpc: { list_customers: { items: [], total: 0 } } });

    await call(OPS_ROUTES.listOpsCustomers.path, {
      query: { status: ['signed', 'active'] },
    });

    // `req.query()` 只保留第一个值；这里证明用的是 `req.queries()`。
    expect(rpcBodies[0]?.body).toMatchObject({ p_statuses: ['signed', 'active'] });
  });

  it('refuses a reader without customer.read before touching the directory', async () => {
    const called = stubFetch({ permissions: ['customer.write'], rpc: {} });

    const response = await call(OPS_ROUTES.listOpsCustomers.path);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'customer.read' },
    });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/customers', () => {
  it('returns 201 with the duplicate hints that do not block creation', async () => {
    stubFetch({
      rpc: {
        create_customer: {
          status: 'ok',
          customer: customerRow(),
          duplicate_hints: [
            {
              id: '00000000-0000-4000-8000-000000000102',
              customer_no: 'CUS-2026-000102',
              name: '海蓝旅行社',
              reason: 'same_name',
            },
          ],
        },
      },
    });

    const response = await call(OPS_ROUTES.createOpsCustomer.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: {
        name: '海蓝旅行社',
        reason: '新签客户',
        contacts: [{ name: '李四', isPrimary: true }],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      customer: { id: CUSTOMER_ID, customerNo: 'CUS-2026-000101' },
      duplicateHints: [{ customerNo: 'CUS-2026-000102', reason: 'same_name' }],
    });
    // 内嵌联系人按列名口径下传：库里读的是 job_title/is_primary，不是契约字段名。
    expect(rpcBodies[0]?.body).toMatchObject({
      p_name: '海蓝旅行社',
      p_unified_social_credit_code: null,
      p_contacts: [
        {
          name: '李四',
          job_title: null,
          phone: null,
          email: null,
          is_primary: true,
          usage_scene: null,
        },
      ],
      p_reason: '新签客户',
    });
  });

  it('rejects a create without Idempotency-Key before any write can happen', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.createOpsCustomer.path, {
      method: 'POST',
      body: { name: '海蓝旅行社', reason: '新签客户' },
    });

    // 全局幂等中间件对没有 key 的请求直接放行，所以这条拒绝只能在 handler 里。
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('maps a customer_no collision to 409 CONFLICT', async () => {
    stubFetch({ rpc: { create_customer: { status: 'customer_no_conflict' } } });

    const response = await call(OPS_ROUTES.createOpsCustomer.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { name: '海蓝旅行社', reason: '新签客户' },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { field: 'customerNo' } });
  });

  it('maps an unknown owner operator to 400 VALIDATION_ERROR', async () => {
    stubFetch({
      rpc: {
        create_customer: { status: 'unknown_owner', owner_operator_id: OPERATOR_ID },
      },
    });

    const response = await call(OPS_ROUTES.createOpsCustomer.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { name: '海蓝旅行社', ownerOperatorId: OPERATOR_ID, reason: '新签客户' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'ownerOperatorId', ownerOperatorId: OPERATOR_ID },
    });
  });

  it('refuses a writer without customer.write', async () => {
    const called = stubFetch({ permissions: ['customer.read'], rpc: {} });

    const response = await call(OPS_ROUTES.createOpsCustomer.path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { name: '海蓝旅行社', reason: '新签客户' },
    });

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'customer.write' },
    });
    expect(called).toEqual([]);
  });
});

describe('POST /api/v1/ops/customers/duplicate-check', () => {
  it('maps the match reason of each hit', async () => {
    stubFetch({
      rpc: {
        check_customer_duplicates: {
          items: [
            {
              id: CUSTOMER_ID,
              customer_no: 'CUS-2026-000101',
              name: '海蓝旅行社',
              match_reason: 'same_uscc',
            },
          ],
        },
      },
    });

    const response = await call(OPS_ROUTES.checkOpsCustomerDuplicates.path, {
      method: 'POST',
      body: { name: '海蓝旅行社' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        {
          id: CUSTOMER_ID,
          customerNo: 'CUS-2026-000101',
          name: '海蓝旅行社',
          matchReason: 'same_uscc',
        },
      ],
    });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_name: '海蓝旅行社',
      p_unified_social_credit_code: null,
    });
  });

  it('rejects a check without a name at the contract layer', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(OPS_ROUTES.checkOpsCustomerDuplicates.path, {
      method: 'POST',
      body: { name: '   ' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });
});

describe('GET /api/v1/ops/customers/{customerId}', () => {
  it('returns the customer, the counts and contacts with the masked keys only', async () => {
    stubFetch({
      rpc: {
        get_customer: {
          status: 'ok',
          customer: customerRow(),
          contacts: [contactPlainRow()],
          counts,
        },
      },
    });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomer.path));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ customer: { id: CUSTOMER_ID }, counts });
    // `toEqual` 会在出现多余键时失败：这里同时证明了「没有 phone/email 键」。
    expect(response.body.contacts[0]).toEqual({
      id: CONTACT_ID,
      name: '李四',
      jobTitle: '采购经理',
      phoneMasked: '138****8000',
      emailMasked: 'l****@example.test',
      isPrimary: true,
      usageScene: '合同签署',
      version: 1,
      createdAt: '2026-10-01T02:00:00+00:00',
      updatedAt: '2026-10-02T02:00:00+00:00',
    });
  });

  it('passes the original values through when the database returns them', async () => {
    stubFetch({
      rpc: {
        get_customer: {
          status: 'ok',
          customer: customerRow(),
          contacts: [contactSensitiveRow()],
          counts,
        },
      },
    });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomer.path));

    expect(response.status).toBe(200);
    expect(response.body.contacts[0]).toMatchObject({
      phone: '13800008000',
      email: 'li@example.test',
      phoneMasked: '138****8000',
    });
  });

  /**
   * P6 的第二半：`{phone: null}` 这种「有键没值」既不是「无权限」也不是「没填」。
   * 它在解析层就必须失败——否则「这个人有没有权限看电话」永远无法判定。
   */
  it('fails closed when the directory returns a half-masked contact', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({
      rpc: {
        get_customer: {
          status: 'ok',
          customer: customerRow(),
          contacts: [{ ...contactPlainRow(), phone: null }],
          counts,
        },
      },
    });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomer.path));

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(
      error.mock.calls
        .map(([line]) => String(line))
        .some((line) => line.includes('ops_rpc_shape_invalid')),
    ).toBe(true);
    error.mockRestore();
  });

  it('reports a missing customer as 404', async () => {
    stubFetch({ rpc: { get_customer: { status: 'not_found' } } });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomer.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /api/v1/ops/customers/{customerId}', () => {
  const path = customerPath(OPS_ROUTES.updateOpsCustomer.path);

  it('sends omitted fields as the null sentinel and returns the updated customer', async () => {
    stubFetch({
      rpc: {
        update_customer: { status: 'ok', customer: customerRow({ version: 2, name: '海蓝国旅' }) },
      },
    });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '海蓝国旅', reason: '改名', version: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ customer: { name: '海蓝国旅', version: 2 } });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_customer_id: CUSTOMER_ID,
      p_expected_version: 1,
      p_name: '海蓝国旅',
      p_unified_social_credit_code: null,
      p_region_code: null,
      p_source_note: null,
      p_internal_note: null,
      p_reason: '改名',
    });
  });

  it('reports a stale version as 409 CONFLICT with the current value', async () => {
    stubFetch({ rpc: { update_customer: { status: 'version_mismatch', current_version: 5 } } });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '海蓝国旅', reason: '改名', version: 1 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 5 } });
  });

  it('reports a missing customer as 404', async () => {
    stubFetch({ rpc: { update_customer: { status: 'not_found' } } });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '海蓝国旅', reason: '改名', version: 1 },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps status and ownerOperatorId out of the update contract', async () => {
    stubFetch({
      rpc: { update_customer: { status: 'ok', customer: customerRow({ version: 2 }) } },
    });

    const response = await call(path, {
      method: 'PATCH',
      body: { status: 'active', ownerOperatorId: OPERATOR_ID, reason: '顺手改', version: 1 },
    });

    // 两个字段被 schema 剥掉、也不在白名单里，所以根本不会下传：
    // 状态只能走 transition，责任人本轮没有写入口。这条请求于是只是「没有可改的字段」。
    expect(response.status).toBe(200);
    const sent = rpcBodies[0]?.body ?? {};
    expect(sent).not.toHaveProperty('p_status');
    expect(sent).not.toHaveProperty('p_owner_operator_id');
    expect(sent).toMatchObject({ p_name: null, p_expected_version: 1 });
  });
});

describe('POST /api/v1/ops/customers/{customerId}/transition', () => {
  const path = customerPath(OPS_ROUTES.transitionOpsCustomer.path);
  const impact = { contracts: 2, entitlements: 1, tickets: 0, deployments: 1 };

  it('returns the new status, version and the impact counters', async () => {
    stubFetch({
      rpc: {
        transition_customer: {
          status: 'ok',
          customer: { status: 'active', version: 3 },
          impact,
        },
      },
    });

    const response = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'activate', reason: '开通完成', version: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ customer: { status: 'active', version: 3 }, impact });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_action: 'activate',
      p_expected_version: 2,
      p_reason: '开通完成',
    });
  });

  it('separates the three state refusals by reason', async () => {
    stubFetch({ rpc: { transition_customer: { status: 'invalid_transition' } } });
    const invalid = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'activate', reason: '直接开通', version: 1 },
    });

    stubFetch({ rpc: { transition_customer: { status: 'contacts_required' } } });
    const contacts = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'start_onboarding', reason: '开始开通', version: 1 },
    });

    stubFetch({ rpc: { transition_customer: { status: 'referenced', impact } } });
    const referenced = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'terminate', reason: '客户解约', version: 1 },
    });

    expect(invalid.status).toBe(409);
    expect(invalid.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
    expect(contacts.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTACTS_REQUIRED' },
    });
    expect(referenced.body).toMatchObject({
      code: 'OBJECT_REFERENCED',
      details: { impact },
    });
  });

  it('rejects a transition without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(path, {
      method: 'POST',
      body: { action: 'activate', reason: '开通完成', version: 1 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('rejects an action outside the closed state machine', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { action: 'delete', reason: '删掉', version: 1 },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });
});

describe('GET /api/v1/ops/customers/{customerId}/overview', () => {
  it('maps the snake_case summary arrays to their contract names', async () => {
    stubFetch({
      rpc: {
        customer_overview: {
          status: 'ok',
          contracts: [{ contract_no: 'HT-2026-0001' }],
          receivables: [],
          subscriptions: [],
          licenses: [],
          tenant_mappings: [{ external_ref: 'udone-alpha' }],
          deployments: [],
          tickets: [],
        },
      },
    });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomerOverview.path));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      contracts: [{ contract_no: 'HT-2026-0001' }],
      receivables: [],
      subscriptions: [],
      licenses: [],
      tenantMappings: [{ external_ref: 'udone-alpha' }],
      deployments: [],
      tickets: [],
    });
  });

  it('reports a missing customer as 404', async () => {
    stubFetch({ rpc: { customer_overview: { status: 'not_found' } } });

    const response = await call(customerPath(OPS_ROUTES.getOpsCustomerOverview.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/v1/ops/customers/{customerId}/contacts', () => {
  it('returns contacts without the original-value keys when the database omits them', async () => {
    stubFetch({
      rpc: { list_customer_contacts: { status: 'ok', items: [contactPlainRow()] } },
    });

    const response = await call(customerPath(OPS_ROUTES.listOpsCustomerContacts.path));

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toEqual({
      id: CONTACT_ID,
      name: '李四',
      jobTitle: '采购经理',
      phoneMasked: '138****8000',
      emailMasked: 'l****@example.test',
      isPrimary: true,
      usageScene: '合同签署',
      version: 1,
      createdAt: '2026-10-01T02:00:00+00:00',
      updatedAt: '2026-10-02T02:00:00+00:00',
    });
    // 显式再断一次「键不存在」：这是 P6 的验收断言，不能只靠 toEqual 的隐含语义。
    expect(response.body.items[0]).not.toHaveProperty('phone');
    expect(response.body.items[0]).not.toHaveProperty('email');
  });

  it('keeps the original-value keys when the database returns them', async () => {
    stubFetch({
      rpc: { list_customer_contacts: { status: 'ok', items: [contactSensitiveRow()] } },
    });

    const response = await call(customerPath(OPS_ROUTES.listOpsCustomerContacts.path));

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      phone: '13800008000',
      email: 'li@example.test',
    });
  });

  it('reports a missing customer as 404', async () => {
    stubFetch({ rpc: { list_customer_contacts: { status: 'not_found' } } });

    const response = await call(customerPath(OPS_ROUTES.listOpsCustomerContacts.path));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('POST /api/v1/ops/customers/{customerId}/contacts', () => {
  const path = customerPath(OPS_ROUTES.createOpsCustomerContact.path);

  it('returns 201 with the created contact and its masked keys', async () => {
    stubFetch({ rpc: { create_customer_contact: { status: 'ok', contact: contactPlainRow() } } });

    const response = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { name: '李四', jobTitle: '采购经理', phone: '13800008000', reason: '补录联系人' },
    });

    expect(response.status).toBe(201);
    expect(response.body.contact).toMatchObject({ id: CONTACT_ID, name: '李四' });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_customer_id: CUSTOMER_ID,
      p_name: '李四',
      p_job_title: '采购经理',
      p_phone: '13800008000',
      p_email: null,
      // 不传就是 null（用库默认 false），不是明确的 false。
      p_is_primary: null,
      p_usage_scene: null,
      p_reason: '补录联系人',
    });
  });

  it('rejects a create without Idempotency-Key', async () => {
    const called = stubFetch({ rpc: {} });

    const response = await call(path, {
      method: 'POST',
      body: { name: '李四', reason: '补录联系人' },
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toEqual([]);
  });

  it('reports a missing customer as 404', async () => {
    stubFetch({ rpc: { create_customer_contact: { status: 'not_found' } } });

    const response = await call(path, {
      method: 'POST',
      headers: IDEMPOTENCY_KEY,
      body: { name: '李四', reason: '补录联系人' },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('PATCH /api/v1/ops/customers/{customerId}/contacts/{contactId}', () => {
  const path = contactPath(OPS_ROUTES.updateOpsCustomerContact.path);

  it('returns the updated contact', async () => {
    stubFetch({
      rpc: {
        update_customer_contact: {
          status: 'ok',
          contact: contactSensitiveRow({ version: 2, name: '李四（采购）' }),
        },
      },
    });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '李四（采购）', reason: '更正姓名', version: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.body.contact).toMatchObject({ name: '李四（采购）', version: 2 });
    expect(rpcBodies[0]?.body).toMatchObject({
      p_contact_id: CONTACT_ID,
      p_expected_version: 1,
      p_name: '李四（采购）',
      p_job_title: null,
    });
  });

  it('reports a stale version as 409 CONFLICT with the current value', async () => {
    stubFetch({
      rpc: { update_customer_contact: { status: 'version_mismatch', current_version: 4 } },
    });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '李四', reason: '更正姓名', version: 1 },
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 4 } });
  });

  it('reports a missing contact as 404', async () => {
    stubFetch({ rpc: { update_customer_contact: { status: 'not_found' } } });

    const response = await call(path, {
      method: 'PATCH',
      body: { name: '李四', reason: '更正姓名', version: 1 },
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DELETE /api/v1/ops/customers/{customerId}/contacts/{contactId}', () => {
  const path = contactPath(OPS_ROUTES.deleteOpsCustomerContact.path);

  it('returns the deleted contact id', async () => {
    stubFetch({
      rpc: { delete_customer_contact: { status: 'ok', deleted_contact_id: CONTACT_ID } },
    });

    const response = await call(path, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deletedContactId: CONTACT_ID });
    // 契约的 DELETE 没有 reason 字段，这里如实下传 null 而不是编一句审计文案。
    expect(rpcBodies[0]?.body).toMatchObject({
      p_customer_id: CUSTOMER_ID,
      p_contact_id: CONTACT_ID,
      p_reason: null,
    });
  });

  it('refuses to remove the only contact of a live customer', async () => {
    stubFetch({ rpc: { delete_customer_contact: { status: 'last_primary' } } });

    const response = await call(path, { method: 'DELETE' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_PRIMARY_CONTACT' },
    });
  });

  it('reports a missing contact as 404', async () => {
    stubFetch({ rpc: { delete_customer_contact: { status: 'not_found' } } });

    const response = await call(path, { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
