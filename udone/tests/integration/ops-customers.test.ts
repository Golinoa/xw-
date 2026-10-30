import { describe, expect, it } from 'vitest';
import { OPS_USER, OPS_VIEWER_USER, call, expectStatus, signToken } from './harness';

/**
 * 运营客户与联系人，跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明的是「回包形状与拒绝形状都来自库」：2xx 说明 11 个 RPC 的 jsonb 键名与
 * `protocol.ts` 的 row schema 逐字段对齐（否则 `ops_rpc_shape_invalid` → 503）；
 * 403 说明权限按动作码判；404/409 说明 `{status:...}` 信封被 Worker 正确翻译。
 *
 * 唯一不能在这里证明的是 `OBJECT_REFERENCED`：合同/授权/工单/部署四张表还没有，
 * 引用计数恒为 0，terminate 永远成功。那条分支由 pgTAP 用同一事务里的临时替身表
 * 证明（`supabase/tests/ops_customer_domain.sql`），这里如实留空。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const CUSTOMERS = '/api/v1/ops/customers';

interface CustomerBody {
  id: string;
  customerNo: string;
  name: string;
  status: string;
  version: number;
  owner: { id: string; displayName: string | null; email: string } | null;
  primaryContact?: unknown;
  activeContractCount?: number;
}

interface ContactBody {
  id: string;
  name: string;
  jobTitle: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  isPrimary: boolean;
  version: number;
  phone?: string | null;
  email?: string | null;
}

/** 后面几个用例共用的客户与联系人；由各自的 describe 依次写入。 */
let mainCustomer: CustomerBody;
let mainContact: ContactBody;

describe('GET /api/v1/ops/customers', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(CUSTOMERS, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a tenant administrator with a perfectly valid token (P11)', async () => {
    const response = await call(CUSTOMERS, { actor: 'admin' });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns a paged list for an operator with customer.read', async () => {
    const response = await call<{ items: CustomerBody[]; total: number }>(CUSTOMERS, {
      token: viewerToken,
    });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(typeof response.body.total).toBe('number');
  });
});

describe('POST /api/v1/ops/customers', () => {
  it('creates a customer with an embedded primary contact', async () => {
    const response = await call<{
      customer: CustomerBody;
      duplicateHints: Array<{ reason: string }>;
    }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: {
        name: '集成客户甲',
        unifiedSocialCreditCode: '91310000INTEGRATION001',
        regionCode: '310000',
        sourceNote: '集成测试来源',
        contacts: [
          {
            name: '张三',
            jobTitle: '采购负责人',
            phone: '13800138888',
            email: 'zhang@integration.test',
            isPrimary: true,
            usageScene: '合同签署',
          },
        ],
        reason: '集成测试新建客户',
      },
    });

    expectStatus(response, 201);
    expect(response.body.customer.customerNo).toMatch(/^CUS-\d{6}$/);
    expect(response.body.customer).toMatchObject({
      name: '集成客户甲',
      status: 'signed',
      version: 1,
    });
    expect(response.body.duplicateHints).toEqual([]);
    mainCustomer = response.body.customer;
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(CUSTOMERS, {
      method: 'POST',
      token: viewerToken,
      body: { name: '越权客户', reason: '没有写权限' },
    });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'customer.write' },
    });
  });

  it('requires an Idempotency-Key header', async () => {
    const response = await call(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { name: '缺幂等键', reason: '缺幂等键' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/v1/ops/customers/duplicate-check', () => {
  it('reports the match reason for an existing name', async () => {
    const response = await call<{
      items: Array<{ customerNo: string; name: string; matchReason: string }>;
    }>(`${CUSTOMERS}/duplicate-check`, {
      method: 'POST',
      token: opsToken,
      body: { name: '集成客户甲' },
    });

    expectStatus(response, 200);
    expect(response.body.items[0]).toMatchObject({
      name: '集成客户甲',
      matchReason: 'NAME_MATCH',
    });
    expect(response.body.items[0]?.customerNo).toMatch(/^CUS-\d{6}$/);
  });

  it('refuses a caller who is not an operator member', async () => {
    const response = await call(`${CUSTOMERS}/duplicate-check`, {
      method: 'POST',
      actor: 'admin',
      body: { name: '集成客户甲' },
    });
    expectStatus(response, 403);
  });
});

describe('GET /api/v1/ops/customers/{customerId}', () => {
  it('returns the customer, its contacts and the six counts', async () => {
    const response = await call<{
      customer: CustomerBody;
      contacts: ContactBody[];
      counts: Record<string, number>;
    }>(`${CUSTOMERS}/${mainCustomer.id}`, { token: opsToken });

    expectStatus(response, 200);
    expect(response.body.customer.id).toBe(mainCustomer.id);
    expect(response.body.counts).toEqual({
      contracts: 0,
      receivables: 0,
      subscriptions: 0,
      licenses: 0,
      deployments: 0,
      tickets: 0,
    });
    expect(response.body.contacts).toHaveLength(1);
    mainContact = response.body.contacts[0] as ContactBody;
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}`, { token: opsToken });
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a tenant administrator', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}`, { actor: 'admin' });
    expectStatus(response, 403);
  });
});

describe('PATCH /api/v1/ops/customers/{customerId}', () => {
  it('applies an edit and bumps the version', async () => {
    const response = await call<{ customer: CustomerBody }>(`${CUSTOMERS}/${mainCustomer.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { name: '集成客户甲（改名）', regionCode: '330000', reason: '改名', version: 1 },
    });

    expectStatus(response, 200);
    expect(response.body.customer).toMatchObject({
      name: '集成客户甲（改名）',
      regionCode: '330000',
      version: 2,
      // `status` 不在 PATCH 白名单里：改状态只能走 transition。
      status: 'signed',
    });
    mainCustomer = { ...mainCustomer, ...response.body.customer };
  });

  it('refuses a stale version with the current one in details', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { name: '又改名', reason: '版本过期', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2 } });
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}`, {
      method: 'PATCH',
      token: opsToken,
      body: { name: '不存在', reason: '不存在', version: 1 },
    });
    expectStatus(response, 404);
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}`, {
      method: 'PATCH',
      token: viewerToken,
      body: { name: '越权改名', reason: '没有写权限', version: 2 },
    });
    expectStatus(response, 403);
  });
});

describe('POST /api/v1/ops/customers/{customerId}/transition', () => {
  let lifecycleCustomerId = '';

  it('refuses start_onboarding while the customer has no contact', async () => {
    const created = await call<{ customer: CustomerBody }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '集成客户乙', reason: '状态机用例' },
    });
    expectStatus(created, 201);
    lifecycleCustomerId = created.body.customer.id;

    const response = await call(`${CUSTOMERS}/${lifecycleCustomerId}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'start_onboarding', reason: '开始交付', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTACTS_REQUIRED' },
    });
  });

  it('moves signed → onboarding → active once a contact exists', async () => {
    const contact = await call<{ contact: ContactBody }>(
      `${CUSTOMERS}/${lifecycleCustomerId}/contacts`,
      {
        method: 'POST',
        token: opsToken,
        body: { name: '王五', phone: '13900139000', isPrimary: true, reason: '补录联系人' },
      },
    );
    expectStatus(contact, 201);

    const onboarding = await call<{
      customer: { status: string; version: number };
      impact: Record<string, number>;
    }>(`${CUSTOMERS}/${lifecycleCustomerId}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'start_onboarding', reason: '开始交付', version: 1 },
    });

    expectStatus(onboarding, 200);
    expect(onboarding.body.customer).toEqual({ status: 'onboarding', version: 2 });
    expect(onboarding.body.impact).toEqual({
      contracts: 0,
      entitlements: 0,
      tickets: 0,
      deployments: 0,
    });

    const active = await call<{ customer: { status: string; version: number } }>(
      `${CUSTOMERS}/${lifecycleCustomerId}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'activate', reason: '开通完成', version: 2 },
      },
    );
    expectStatus(active, 200);
    expect(active.body.customer).toEqual({ status: 'active', version: 3 });
  });

  it('refuses an edge that does not exist in the state machine', async () => {
    const response = await call(`${CUSTOMERS}/${lifecycleCustomerId}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'activate', reason: '重复开通', version: 3 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'activate', reason: '不存在', version: 1 },
    });
    expectStatus(response, 404);
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(`${CUSTOMERS}/${lifecycleCustomerId}/transition`, {
      method: 'POST',
      token: viewerToken,
      body: { action: 'suspend', reason: '越权', version: 3 },
    });
    expectStatus(response, 403);
  });
});

describe('GET /api/v1/ops/customers/{customerId}/overview', () => {
  it('returns the seven summary arrays', async () => {
    const response = await call<Record<string, unknown>>(
      `${CUSTOMERS}/${mainCustomer.id}/overview`,
      { token: opsToken },
    );

    expectStatus(response, 200);
    for (const key of [
      'contracts',
      'receivables',
      'subscriptions',
      'licenses',
      'tenantMappings',
      'deployments',
      'tickets',
    ]) {
      expect(response.body[key]).toEqual([]);
    }
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}/overview`, {
      token: opsToken,
    });
    expectStatus(response, 404);
  });
});

describe('GET /api/v1/ops/customers/{customerId}/contacts', () => {
  it('returns raw phone values to an operator with customer.sensitive.read', async () => {
    const response = await call<{ items: ContactBody[] }>(
      `${CUSTOMERS}/${mainCustomer.id}/contacts`,
      { token: opsToken },
    );

    expectStatus(response, 200);
    expect(response.body.items[0]).toMatchObject({
      name: '张三',
      phoneMasked: '138****8888',
      phone: '13800138888',
      email: 'zhang@integration.test',
    });
  });

  it('P6: omits the raw keys for a viewer without customer.sensitive.read', async () => {
    const response = await call<{ items: ContactBody[] }>(
      `${CUSTOMERS}/${mainCustomer.id}/contacts`,
      { token: viewerToken },
    );

    expectStatus(response, 200);
    const contact = response.body.items[0] as ContactBody;
    // 用「键不存在」而不是「值为 null」：null 会让「没权限」与「有权限但没填」
    // 在响应里再也分不开，而 P6 的验收就是这个区别。
    expect(contact).not.toHaveProperty('phone');
    expect(contact).not.toHaveProperty('email');
    expect(contact).toMatchObject({
      phoneMasked: '138****8888',
      emailMasked: 'z***@integration.test',
    });
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}/contacts`, {
      token: opsToken,
    });
    expectStatus(response, 404);
  });

  it('refuses a tenant administrator', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts`, { actor: 'admin' });
    expectStatus(response, 403);
  });
});

describe('POST /api/v1/ops/customers/{customerId}/contacts', () => {
  it('creates a second primary contact and demotes the previous one', async () => {
    const created = await call<{ contact: ContactBody }>(
      `${CUSTOMERS}/${mainCustomer.id}/contacts`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          name: '李四',
          jobTitle: '技术负责人',
          phone: '13700137000',
          email: 'li@integration.test',
          isPrimary: true,
          reason: '换主要联系人',
        },
      },
    );

    expectStatus(created, 201);
    expect(created.body.contact).toMatchObject({ name: '李四', isPrimary: true, version: 1 });

    const list = await call<{ items: ContactBody[] }>(`${CUSTOMERS}/${mainCustomer.id}/contacts`, {
      token: opsToken,
    });
    expectStatus(list, 200);

    const primaries = list.body.items.filter((item) => item.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.name).toBe('李四');
    expect(list.body.items.find((item) => item.name === '张三')?.isPrimary).toBe(false);

    mainContact = created.body.contact;
  });

  it('answers 404 for an unknown customer', async () => {
    const response = await call(`${CUSTOMERS}/${crypto.randomUUID()}/contacts`, {
      method: 'POST',
      token: opsToken,
      body: { name: '不存在', reason: '不存在' },
    });
    expectStatus(response, 404);
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts`, {
      method: 'POST',
      token: viewerToken,
      body: { name: '越权联系人', reason: '没有写权限' },
    });
    expectStatus(response, 403);
  });
});

describe('PATCH /api/v1/ops/customers/{customerId}/contacts/{contactId}', () => {
  it('updates a contact and bumps its version', async () => {
    const response = await call<{ contact: ContactBody }>(
      `${CUSTOMERS}/${mainCustomer.id}/contacts/${mainContact.id}`,
      {
        method: 'PATCH',
        token: opsToken,
        body: { jobTitle: '技术总监', reason: '职位变更', version: 1 },
      },
    );

    expectStatus(response, 200);
    expect(response.body.contact).toMatchObject({
      id: mainContact.id,
      jobTitle: '技术总监',
      version: 2,
    });
    mainContact = response.body.contact;
  });

  it('refuses a stale version', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${mainContact.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { jobTitle: '过期改名', reason: '版本过期', version: 1 },
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2 } });
  });

  it('answers 404 for an unknown contact', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${crypto.randomUUID()}`, {
      method: 'PATCH',
      token: opsToken,
      body: { jobTitle: '不存在', reason: '不存在', version: 1 },
    });
    expectStatus(response, 404);
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${mainContact.id}`, {
      method: 'PATCH',
      token: viewerToken,
      body: { jobTitle: '越权', reason: '没有写权限', version: 2 },
    });
    expectStatus(response, 403);
  });
});

describe('DELETE /api/v1/ops/customers/{customerId}/contacts/{contactId}', () => {
  it('deletes a non-primary contact', async () => {
    const list = await call<{ items: ContactBody[] }>(`${CUSTOMERS}/${mainCustomer.id}/contacts`, {
      token: opsToken,
    });
    expectStatus(list, 200);
    const removable = list.body.items.find((item) => item.name === '张三');
    expect(removable).toBeDefined();

    const response = await call<{ deletedContactId: string }>(
      `${CUSTOMERS}/${mainCustomer.id}/contacts/${String(removable?.id)}`,
      { method: 'DELETE', token: opsToken },
    );

    expectStatus(response, 200);
    expect(response.body.deletedContactId).toBe(removable?.id);
  });

  it('refuses to delete the last contact of a non-terminated customer', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${mainContact.id}`, {
      method: 'DELETE',
      token: opsToken,
    });

    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'LAST_PRIMARY_CONTACT' },
    });
  });

  it('answers 404 for an unknown contact', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${crypto.randomUUID()}`, {
      method: 'DELETE',
      token: opsToken,
    });
    expectStatus(response, 404);
  });

  it('refuses a viewer without customer.write', async () => {
    const response = await call(`${CUSTOMERS}/${mainCustomer.id}/contacts/${mainContact.id}`, {
      method: 'DELETE',
      token: viewerToken,
    });
    expectStatus(response, 403);
  });
});
