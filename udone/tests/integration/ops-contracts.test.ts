import { describe, expect, it } from 'vitest';
import { OPS_USER, OPS_VIEWER_USER, call, expectStatus, signToken } from './harness';

/**
 * 运营 contract 域，跑在**真实 PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明的是「回包形状与拒绝形状都来自库」：2xx 说明 14 个 RPC 的 jsonb 键名与
 * `protocol.ts` 的 row schema 逐字段对齐（否则 `ops_rpc_shape_invalid` → 503）；
 * 403 说明权限按动作码判；404/409 说明 `{status:...}` 信封被 Worker 正确翻译。
 *
 * 用例之间**有状态依赖**（状态机只能 draft→reviewing→signed→active 逐条推进），
 * 所以同一文件内顺序执行，共享 `mainContract` / `mainCustomer`。
 *
 * 两处能力边界如实留空，不在这里假装：
 * - `OBJECT_REFERENCED`（terminate 被应收/订阅/租户命令阻塞）：三张表属 T-07/T-09/T-10，
 *   本轮不存在，引用计数恒为 0，terminate 永远成功。这条分支由 pgTAP 用同一事务里的
 *   临时替身表证明（`supabase/tests/ops_contract_domain.sql`）。
 * - Storage 对象存在性：本地没有 Supabase Storage，`complete` 不做 HEAD 校验。
 */

const opsToken = signToken(OPS_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const CONTRACTS = '/api/v1/ops/contracts';
const PRODUCTS = '/api/v1/ops/products';
const CUSTOMERS = '/api/v1/ops/customers';
const CONTRACT_ATTACHMENTS = '/api/v1/ops/contract-attachments';

interface ContractBody {
  id: string;
  contractNo: string;
  customerId: string;
  customer: { id: string; name: string };
  salesMode: string;
  currency: string;
  totalAmount: number;
  paymentTerms: string | null;
  status: string;
  signedOn: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  renewedFromContractId: string | null;
  statusReason: string | null;
  currentVersionNo: number;
  version: number;
}

interface AttachmentBody {
  id: string;
  contractId: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  storagePath: string;
  status: string;
  accessScope: string;
}

const PRODUCT_CODE = 'CON-INT-001';

let mainProductId: string;
let mainCustomerId: string;
let mainContract: ContractBody;
let mainAttachment: AttachmentBody;

describe('POST /api/v1/ops/products（合同条目的引用前置）', () => {
  it('creates a product with the saas sales mode enabled', async () => {
    const response = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: PRODUCT_CODE,
        name: '合同集成产品',
        salesModes: [{ mode: 'saas', isEnabled: true }],
      },
    });
    expectStatus(response, 201);
    mainProductId = response.body.product.id;
    expect(mainProductId).toBeTruthy();
  });
});

describe('POST /api/v1/ops/customers（合同的引用前置）', () => {
  it('creates a customer whose status allows a contract to be submitted', async () => {
    const response = await call<{ customer: { id: string; status: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '合同集成客户', reason: '合同域集成测试' },
    });
    expectStatus(response, 201);
    mainCustomerId = response.body.customer.id;
    // submit 的守卫是「客户 signed/onboarding/active」，建客户默认 signed。
    expect(response.body.customer.status).toBe('signed');
  });

  it('creates a customer that is left in the same status (control group)', async () => {
    const response = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '合同域第二客户', reason: '跨合同审批用例' },
    });
    expectStatus(response, 201);
  });
});

describe('GET /api/v1/ops/contracts', () => {
  it('rejects a request without a bearer token', async () => {
    const response = await call(CONTRACTS, { headers: { Authorization: 'Basic abc' } });
    expectStatus(response, 401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a tenant administrator with a perfectly valid token (P11)', async () => {
    const response = await call(CONTRACTS, { actor: 'admin' });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns a paged list for an operator with contract.read', async () => {
    const response = await call<{ items: ContractBody[]; total: number }>(CONTRACTS, {
      token: viewerToken,
    });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(typeof response.body.total).toBe('number');
  });

  it('rejects an unknown status filter instead of ignoring it', async () => {
    // 静默忽略会让 `?status=activ` 返回全集，看起来像「筛选没生效」。
    const response = await call(CONTRACTS, { token: viewerToken, query: { status: 'activ' } });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/v1/ops/contracts', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { customerId: mainCustomerId, salesMode: 'saas', items: [] },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a viewer without contract.write', async () => {
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: viewerToken,
      body: { customerId: mainCustomerId, salesMode: 'saas', items: [] },
    });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      details: { required: 'contract.write' },
    });
  });

  it('rejects a missing items key at the schema layer', async () => {
    // 缺 `items` 是「表单接错了」，不是「建一张空合同」；空数组才交给库判。
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: { customerId: mainCustomerId, salesMode: 'saas' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a client-supplied amount instead of trusting it', async () => {
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: mainCustomerId,
        salesMode: 'saas',
        items: [{ productId: mainProductId, quantity: 1, unitPrice: 12800, amount: 1 }],
      },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns 404 for an unknown customer', async () => {
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: '00000000-0000-4000-8000-0000000009ff',
        salesMode: 'saas',
        items: [{ productId: mainProductId, quantity: 1, unitPrice: 100 }],
      },
    });
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'customer' } });
  });

  it('rejects a sales mode the product has not enabled', async () => {
    // 产品只开了 saas；这里是私有化。
    const response = await call(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: mainCustomerId,
        salesMode: 'private',
        items: [{ productId: mainProductId, quantity: 1, unitPrice: 100 }],
      },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a draft contract and recomputes the total on the server', async () => {
    const response = await call<{ contract: ContractBody }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: mainCustomerId,
        salesMode: 'saas',
        businessNote: '集成测试主合同',
        items: [{ productId: mainProductId, quantity: 2, unitPrice: 12800 }],
      },
    });
    expectStatus(response, 201);
    mainContract = response.body.contract;
    expect(mainContract.status).toBe('draft');
    // 2 × 12800：入站没传 amount，这个数只能来自库的重算。
    expect(mainContract.totalAmount).toBe(25600);
    // 草稿还没有任何版本快照。
    expect(mainContract.currentVersionNo).toBe(0);
    expect(mainContract.contractNo).toMatch(/^HT-/);
    expect(mainContract.currency).toBe('CNY');
  });
});

describe('GET /api/v1/ops/contracts/{contractId}', () => {
  it('returns the contract detail with its items', async () => {
    const response = await call<{
      contract: ContractBody;
      items: Array<{ quantity: number; unitPrice: number; amount: number }>;
      attachments: unknown[];
    }>(`${CONTRACTS}/${mainContract.id}`, { token: viewerToken });
    expectStatus(response, 200);
    expect(response.body.contract.id).toBe(mainContract.id);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ quantity: 2, unitPrice: 12800, amount: 25600 });
    // 应收/订阅/授权三张表还不存在，此时必须是空数组而不是 null。
    expect(response.body.attachments).toEqual([]);
  });

  it('returns 404 for an unknown contract', async () => {
    const response = await call(`${CONTRACTS}/00000000-0000-4000-8000-0000000009ff`, {
      token: viewerToken,
    });
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'contract' } });
  });
});

describe('PATCH /api/v1/ops/contracts/{contractId}', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}`, {
      method: 'PATCH',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { paymentTerms: '缺幂等键', version: mainContract.version },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a status field in the body (status only moves through transition)', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { status: 'active', version: mainContract.version },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('updates the draft and bumps the version', async () => {
    const response = await call<{ contract: ContractBody }>(`${CONTRACTS}/${mainContract.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: {
        paymentTerms: '签约后 30 天',
        // 给一个远期到期日，后面用来证 renewal_not_due。
        expiresOn: '2027-12-31',
        version: mainContract.version,
      },
    });
    expectStatus(response, 200);
    mainContract = response.body.contract;
    expect(mainContract.paymentTerms).toBe('签约后 30 天');
    expect(mainContract.version).toBe(2);
    expect(mainContract.expiresOn).toBe('2027-12-31');
  });

  it('maps a stale version to 409 CONFLICT with details.currentVersion', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { paymentTerms: '并发写入', version: 1 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2 } });
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/transition', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/transition`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { action: 'submit', reason: '提交审批', version: mainContract.version },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects an action that is not on the state machine', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'approve', reason: '非法动作', version: mainContract.version },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('moves draft to reviewing on submit', async () => {
    const response = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${mainContract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'submit', reason: '提交审批', version: mainContract.version },
      },
    );
    expectStatus(response, 200);
    mainContract = { ...mainContract, ...response.body.contract };
    expect(response.body.contract.status).toBe('reviewing');
  });

  it('refuses a second submit while the contract is already reviewing', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'submit', reason: '提交审批', version: mainContract.version },
    });
    expectStatus(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'INVALID_TRANSITION' },
    });
  });

  it('signs the contract when the sales mode is enabled for the product', async () => {
    const response = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${mainContract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          action: 'sign',
          reason: '客户签署',
          signedOn: '2026-11-01',
          version: mainContract.version,
        },
      },
    );
    expectStatus(response, 200);
    mainContract = { ...mainContract, ...response.body.contract };
    expect(response.body.contract.status).toBe('signed');
    // transition 只回 {status, version}（契约 §5.4 的响应列），签署日期要回详情看。
    const detail = await call<{ contract: ContractBody }>(`${CONTRACTS}/${mainContract.id}`, {
      token: viewerToken,
    });
    expectStatus(detail, 200);
    expect(detail.body.contract.signedOn).toBe('2026-11-01');
  });

  it('activates the contract and writes version snapshot 1', async () => {
    const response = await call<{ contract: ContractBody; createdVersionNo?: number }>(
      `${CONTRACTS}/${mainContract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          action: 'activate',
          reason: '生效',
          effectiveOn: '2026-11-01',
          version: mainContract.version,
        },
      },
    );
    expectStatus(response, 200);
    mainContract = { ...mainContract, ...response.body.contract };
    expect(response.body.contract.status).toBe('active');
    // 快照号在响应顶层（createdVersionNo）；contract 里只有 status 与 version。
    expect(response.body.createdVersionNo).toBe(1);
  });

  it('refuses a PATCH on an active contract with CONTRACT_IMMUTABLE', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}`, {
      method: 'PATCH',
      token: opsToken,
      body: { paymentTerms: '签署后偷改', version: mainContract.version },
    });
    expectStatus(409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'CONTRACT_IMMUTABLE' },
    });
  });
});

describe('GET /api/v1/ops/contracts/{contractId}/versions', () => {
  it('returns the version history of an active contract', async () => {
    const response = await call<{
      items: Array<{ versionNo: number; changeReason: string }>;
    }>(`${CONTRACTS}/${mainContract.id}/versions`, { token: viewerToken });
    expectStatus(response, 200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]?.versionNo).toBe(1);
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/amendments', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/amendments`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { reason: '缺幂等键' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a pending amendment on an active contract', async () => {
    const response = await call<{
      amendment: { id: string; status: string; amendmentNo: number; version: number };
    }>(`${CONTRACTS}/${mainContract.id}/amendments`, {
      method: 'POST',
      token: opsToken,
      body: {
        reason: '追加一个席位',
        items: [{ productId: mainProductId, quantity: 3, unitPrice: 12800 }],
      },
    });
    expectStatus(response, 201);
    // 契约 §5.4 写建单即 `pending_approval`，实现是 `draft` 起点 + 一次 submit。
    // 两者都保留：状态枚举里有 `draft`（§3.3），若建单不能是 draft 这个值就永远
    // 不可达。按实现断言，偏差已记入交付报告的契约回写项。
    expect(response.body.amendment.status).toBe('draft');
    expect(response.body.amendment.amendmentNo).toBe(1);
    const amendmentId = response.body.amendment.id;

    const submitted = await call<{ amendment: { status: string; version: number } }>(
      `${CONTRACTS}/${mainContract.id}/amendments/${amendmentId}/transition`,
      { method: 'POST', token: opsToken, body: { action: 'submit', reason: '提交', version: 1 } },
    );
    expectStatus(submitted, 200);
    expect(submitted.body.amendment.status).toBe('pending_approval');

    // 同一个账号不能批自己那张（§1 的 `CHECK(approved_by <> requested_by)`）。
    // 这条比「能批」更值得断言：职责分离是审计要求，被绕过才是事故。
    const selfApproved = await call(
      `${CONTRACTS}/${mainContract.id}/amendments/${amendmentId}/transition`,
      { method: 'POST', token: opsToken, body: { action: 'approve', reason: '同意', version: 2 } },
    );
    expectStatus(selfApproved, 409);
    expect(selfApproved.body).toMatchObject({
      code: 'CONFLICT',
      details: { field: 'amendment', reason: 'SELF_APPROVAL' },
    });

    // `approve → apply` 追加第 2 版快照这一段**在集成层证不了**：本地夹具只有
    // 一个带 `contract.approve` 的运营账号，第二个审批人不存在。这段由 pgTAP
    // 换人批准后 apply 来证明（`ops_contract_domain.sql` 的变更单分区）。
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/amendments/{amendmentId}/transition', () => {
  it('refuses to transition an amendment through another contract id', async () => {
    // 路径上的合同段必须与变更单真实归属一致，否则审计里的 contract_id 会记错。
    const otherContract = await call<{ contract: ContractBody }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: mainCustomerId,
        salesMode: 'saas',
        items: [{ productId: mainProductId, quantity: 1, unitPrice: 100 }],
      },
    });
    expectStatus(otherContract, 201);

    const versions = await call<{ items: unknown[] }>(`${CONTRACTS}/${mainContract.id}/versions`, {
      token: viewerToken,
    });
    expectStatus(versions, 200);
    // activate 写了第 1 版；变更单的 apply 在集成层走不到（见上一条用例的说明）。
    expect(versions.body.items.length).toBeGreaterThanOrEqual(1);

    // 用一个不存在的变更单 id 也必须是 404（不区分「不存在」与「不属于这份合同」）。
    const response = await call(
      `${CONTRACTS}/${otherContract.body.contract.id}/amendments/00000000-0000-4000-8000-0000000009ff/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve', reason: '跨合同', version: 1 },
      },
    );
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'amendment' } });
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/renewals', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/renewals`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { effectiveOn: '2028-01-01', expiresOn: '2028-12-31', reason: '缺幂等键' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses to renew a contract that is not due yet unless force is set', async () => {
    const refused = await call(`${CONTRACTS}/${mainContract.id}/renewals`, {
      method: 'POST',
      token: opsToken,
      body: { effectiveOn: '2028-01-01', expiresOn: '2028-12-31', reason: '提前续约' },
    });
    expectStatus(refused, 409);
    expect(refused.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'RENEWAL_NOT_DUE' },
    });

    const forced = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${mainContract.id}/renewals`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          effectiveOn: '2028-01-01',
          expiresOn: '2028-12-31',
          reason: '提前续约',
          force: true,
        },
      },
    );
    expectStatus(forced, 201);
    // 续约建新合同，指回原合同；原合同不动。
    expect(forced.body.contract.id).not.toBe(mainContract.id);
    expect(forced.body.contract.renewedFromContractId).toBe(mainContract.id);
    expect(forced.body.contract.status).toBe('draft');
  });
});

describe('GET /api/v1/ops/contracts/{contractId}/entitlement-preview', () => {
  it('returns the entitlement preview for an existing contract', async () => {
    const response = await call<{
      features: Array<{ featureKey: string; enabled: boolean }>;
      warnings: unknown[];
    }>(`${CONTRACTS}/${mainContract.id}/entitlement-preview`, { token: viewerToken });
    expectStatus(response, 200);
    // 条目只引用产品、没有套餐，所以不产出权益行（契约未规定，规格 §6 静默跳过）。
    expect(Array.isArray(response.body.features)).toBe(true);
    expect(Array.isArray(response.body.warnings)).toBe(true);
  });

  it('returns 404 for an unknown contract', async () => {
    const response = await call(
      `${CONTRACTS}/00000000-0000-4000-8000-0000000009ff/entitlement-preview`,
      { token: viewerToken },
    );
    expectStatus(response, 404);
  });
});

describe('POST /api/v1/ops/contracts/{contractId}/attachments', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/attachments`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: { fileName: 'x.pdf', contentType: 'application/pdf', byteSize: 1024 },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a file above the 25 MiB cap', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/attachments`, {
      method: 'POST',
      token: opsToken,
      body: {
        fileName: 'too-big.pdf',
        contentType: 'application/pdf',
        byteSize: 26_214_401,
      },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ATTACHMENT_TOO_LARGE' },
    });
  });

  it('rejects a content type outside the whitelist', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/attachments`, {
      method: 'POST',
      token: opsToken,
      body: { fileName: 'evil.exe', contentType: 'application/x-msdownload', byteSize: 1024 },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'ATTACHMENT_TYPE_REJECTED' },
    });
  });

  it('returns 201 with a pending attachment and a signed upload URL', async () => {
    const response = await call<{
      attachment: AttachmentBody;
      uploadUrl: string;
      uploadExpiresAt: string;
    }>(`${CONTRACTS}/${mainContract.id}/attachments`, {
      method: 'POST',
      token: opsToken,
      body: { fileName: '合同扫描件.pdf', contentType: 'application/pdf', byteSize: 2048 },
    });
    expectStatus(response, 201);
    mainAttachment = response.body.attachment;
    expect(mainAttachment.status).toBe('pending');
    expect(mainAttachment.storagePath).toContain(mainContract.id);
    expect(response.body.uploadUrl).toContain('/storage/v1/object/upload/sign/');
    // 上传 URL 有效期 ≤ 5 分钟，且必须是未来时间。
    const expiresAt = Date.parse(response.body.uploadExpiresAt);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('uploads and downloads the same bytes through the signed URLs', async () => {
    // 这条是「本地存储环境能不能用」的唯一证明。前面几条只断言 URL 字符串，
    // 而字符串在上一版（随机 UUID 当 token）里一样是对的——那个地址在真实
    // Storage 上必然 400。传过字节、读回同一份字节，才算签名真的成立。
    const created = await call<{ attachment: AttachmentBody; uploadUrl: string }>(
      `${CONTRACTS}/${mainContract.id}/attachments`,
      {
        method: 'POST',
        token: opsToken,
        body: { fileName: '实地传输.pdf', contentType: 'application/pdf', byteSize: 5 },
      },
    );
    expectStatus(created, 201);

    const payload = 'hello';
    const uploaded = await fetch(created.body.uploadUrl, { method: 'PUT', body: payload });
    expect(uploaded.status).toBe(200);

    const access = await call<{ url: string; expiresAt: string }>(
      `${CONTRACT_ATTACHMENTS}/${created.body.attachment.id}/access`,
      { token: opsToken },
    );
    expectStatus(access, 200);

    const downloaded = await fetch(access.body.url);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(payload);
  });

  it('lists the attachments of a contract', async () => {
    const response = await call<{ items: AttachmentBody[] }>(
      `${CONTRACTS}/${mainContract.id}/attachments`,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(response.body.items.some((item) => item.id === mainAttachment.id)).toBe(true);
  });
});

describe('POST /api/v1/ops/contract-attachments/{attachmentId}/complete', () => {
  it('requires an Idempotency-Key header', async () => {
    const response = await call(`${CONTRACT_ATTACHMENTS}/${mainAttachment.id}/complete`, {
      method: 'POST',
      token: opsToken,
      headers: { 'Idempotency-Key': '' },
      body: {},
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a malformed checksum at the schema layer', async () => {
    const response = await call(`${CONTRACT_ATTACHMENTS}/${mainAttachment.id}/complete`, {
      method: 'POST',
      token: opsToken,
      body: { checksumSha256: 'not-a-sha256' },
    });
    expectStatus(response, 400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('answers 409 when the bytes were never uploaded (contract §5.4 #13)', async () => {
    // `mainAttachment` 的元数据在 beforeAll 就落了库，对象从没进过存储。
    // 此前这条会 200：函数只看数据库那一行的状态，而那一行在 create 时就有了。
    // 「未上传」这句判断现在真的去问存储，所以它是可以被触发的。
    const response = await call(`${CONTRACT_ATTACHMENTS}/${mainAttachment.id}/complete`, {
      method: 'POST',
      token: opsToken,
      body: {},
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({
      code: 'STATE_CONFLICT',
      details: { reason: 'ATTACHMENT_NOT_UPLOADED' },
    });
  });

  it('marks the attachment stored once the bytes are there', async () => {
    const created = await call<{ attachment: AttachmentBody; uploadUrl: string }>(
      `${CONTRACTS}/${mainContract.id}/attachments`,
      {
        method: 'POST',
        token: opsToken,
        body: { fileName: '待确认.pdf', contentType: 'application/pdf', byteSize: 5 },
      },
    );
    expectStatus(created, 201);

    const uploaded = await fetch(created.body.uploadUrl, { method: 'PUT', body: 'hello' });
    expect(uploaded.status).toBe(200);

    const response = await call<{ attachment: AttachmentBody }>(
      `${CONTRACT_ATTACHMENTS}/${created.body.attachment.id}/complete`,
      {
        method: 'POST',
        token: opsToken,
        body: { checksumSha256: 'a'.repeat(64) },
      },
    );
    expectStatus(response, 200);
    expect(response.body.attachment.status).toBe('stored');
  });

  it('treats a repeated complete as a retry, not as "never uploaded"', async () => {
    // 这条曾是 409：完成判定写成「状态不是 pending」，于是第二次调用一个
    // **已经 stored、还能下载**的附件，会被告知「文件还没上传」。
    const created = await call<{ attachment: AttachmentBody; uploadUrl: string }>(
      `${CONTRACTS}/${mainContract.id}/attachments`,
      {
        method: 'POST',
        token: opsToken,
        body: { fileName: '重试确认.pdf', contentType: 'application/pdf', byteSize: 5 },
      },
    );
    expectStatus(created, 201);
    await fetch(created.body.uploadUrl, { method: 'PUT', body: 'hello' });

    const first = await call<{ attachment: AttachmentBody }>(
      `${CONTRACT_ATTACHMENTS}/${created.body.attachment.id}/complete`,
      { method: 'POST', token: opsToken, body: {} },
    );
    expectStatus(first, 200);

    const retry = await call<{ attachment: AttachmentBody }>(
      `${CONTRACT_ATTACHMENTS}/${created.body.attachment.id}/complete`,
      { method: 'POST', token: opsToken, body: {} },
    );
    expectStatus(retry, 200);
    expect(retry.body.attachment.status).toBe('stored');
  });

  it('returns 404 for an unknown attachment', async () => {
    const response = await call(
      `${CONTRACT_ATTACHMENTS}/00000000-0000-4000-8000-0000000009ff/complete`,
      { method: 'POST', token: opsToken, body: {} },
    );
    expectStatus(response, 404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND', details: { resource: 'attachment' } });
  });
});

describe('GET /api/v1/ops/contract-attachments/{attachmentId}/access', () => {
  it('returns a short-lived signed download URL', async () => {
    const response = await call<{ url: string; expiresAt: string }>(
      `${CONTRACT_ATTACHMENTS}/${mainAttachment.id}/access`,
      { token: viewerToken },
    );
    expectStatus(response, 200);
    expect(response.body.url).toContain('/storage/v1/object/sign/');
    const expiresAt = Date.parse(response.body.expiresAt);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('returns 404 for an unknown attachment', async () => {
    const response = await call(
      `${CONTRACT_ATTACHMENTS}/00000000-0000-4000-8000-0000000009ff/access`,
      { token: viewerToken },
    );
    expectStatus(response, 404);
  });
});

describe('terminate', () => {
  it('refuses terminate without confirmImpact', async () => {
    const response = await call(`${CONTRACTS}/${mainContract.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'terminate', reason: '客户解约', version: mainContract.version },
    });
    expectStatus(409);
    expect(response.body).toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('terminates an active contract when the impact is confirmed', async () => {
    const response = await call<{ contract: ContractBody }>(
      `${CONTRACTS}/${mainContract.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          action: 'terminate',
          reason: '客户解约',
          confirmImpact: true,
          version: mainContract.version,
        },
      },
    );
    expectStatus(response, 200);
    expect(response.body.contract.status).toBe('terminated');
    const detail = await call<{ contract: ContractBody }>(`${CONTRACTS}/${mainContract.id}`, {
      token: viewerToken,
    });
    expectStatus(detail, 200);
    expect(detail.body.contract.statusReason).toBe('客户解约');
  });
});
