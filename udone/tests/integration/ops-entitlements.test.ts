import { beforeAll, describe, expect, it } from 'vitest';
import {
  OPS_FINANCE_USER,
  OPS_SALES_USER,
  OPS_USER,
  OPS_VIEWER_USER,
  call,
  expectStatus,
  signToken,
} from './harness';

/**
 * 运营 entitlement 域（订阅 / 私有授权 / 变更申请 / 快照），跑在**真实
 * PostgREST + 真实 RLS/RPC** 上。
 *
 * 这一段证明四件事：
 *
 * 1. **回包形状来自库。** 201/200 说明 `subject_json` / `snapshot_summary_json` /
 *    `change_request_json` 的 jsonb 键名与 `protocol.ts` 的 row schema 逐字段
 *    对齐；对不上就是 `ops_rpc_shape_invalid` → 503，而不是悄悄少一个字段。
 * 2. **快照是「发放那一刻」的副本。** 改字典的显示名之后，既有快照的
 *    `displayNameSnapshot` 与 `contentHash` 都不动——这条只有真库能证明。
 * 3. **拒绝形状来自库。** 未审批 409 `APPROVAL_REQUIRED`、自批 403
 *    `rule=SEGREGATION_OF_DUTY`、永久授权带有效期 400，三条各有各的状态码。
 * 4. **202 的边界**：`suspend`/`resume`/`revoke` 回 202 且 `command` 为 null
 *    （命令表属 o-t10），`submit`/`approve` 回 200。
 *
 * 顺序依赖（同一文件内顺序执行）：产品与功能键 → 客户 → 合同推到 active →
 * 才有条目可开订阅。
 *
 * 职责分离的两条分支各需要一个**不同的**身份来证：
 *
 * - 「申请人自批被拦」用平台管理员（他既有 request 也有 approve，所以撞的是
 *   `SEGREGATION_OF_DUTY` 而不是 `403 缺权限`——后者会把这条断言偷换成权限测试）。
 * - 「换个人审批放行」用 `sales_ops`（有 request、无 approve）+ 管理员。夹具里
 *   此前只有管理员一个能提单的账号，于是这条正路一步都走不到，只留下「被拦住」
 *   的一半——而「守卫拦得对不对」和「守卫会不会把正常流程也拦死」是两件事。
 */

const opsToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

const SUBSCRIPTIONS = '/api/v1/ops/subscriptions';
const LICENSES = '/api/v1/ops/licenses';
const CHANGE_REQUESTS = '/api/v1/ops/entitlement-change-requests';
const SNAPSHOTS = '/api/v1/ops/entitlement-snapshots';
const CONTRACTS = '/api/v1/ops/contracts';
const PRODUCTS = '/api/v1/ops/products';
const FEATURES = '/api/v1/ops/features';
const CUSTOMERS = '/api/v1/ops/customers';

interface SnapshotLineBody {
  featureKey: string;
  enabled: boolean;
  quotaValue: number | null;
  termMonths: number | null;
  displayNameSnapshot: string;
}

interface SnapshotSummaryBody {
  id: string;
  sourceType: string;
  targetScope: string;
  contentHash: string;
  lineCount: number;
}

interface SubscriptionBody {
  id: string;
  subscriptionNo: string;
  status: string;
  version: number;
  billingCycle: string;
  startsOn: string;
  endsOn: string | null;
  currentSnapshotId: string | null;
  snapshot: SnapshotSummaryBody | null;
}

interface LicenseBody {
  id: string;
  licenseNo: string;
  status: string;
  version: number;
  licenseMode: string;
  validFrom: string;
  validTo: string | null;
  maintenanceUntil: string | null;
  currentSnapshotId: string | null;
}

interface ChangeRequestBody {
  id: string;
  status: string;
  changeType: string;
  version: number;
  beforeSummary: { lines: SnapshotLineBody[] };
  afterSummary: { lines: SnapshotLineBody[] };
  requestedBy: { id: string } | null;
  approvedBy: { id: string } | null;
}

interface DiffBody {
  before: { lines: SnapshotLineBody[] };
  after: { lines: SnapshotLineBody[] };
  added: SnapshotLineBody[];
  removed: SnapshotLineBody[];
  changed: Array<{ featureKey: string }>;
}

let customerId: string;
let saasItemId: string;
let privateItemId: string;
let draftContractItemId: string;
/**
 * 第二条 **已生效** saas 合同上的条目。
 *
 * 用途单一：需要一个能开出「草案订阅」的位置。主 saas 条目上的订阅一旦推进
 * 到 active，`subscriptions_open_item_key` 就不允许再在它上面开第二个；
 * 而草案合同（`draftContractItemId`）连开通都过不了 `CONTRACT_NOT_ACTIVE`。
 */
let spareSaasItemId: string;

let subscription: SubscriptionBody;
let changeRequest: ChangeRequestBody;

/** 合同推到 active（submit → sign → activate），返回最新版本。 */
async function activateContract(id: string, version: number, reason: string): Promise<number> {
  let current = version;
  for (const action of ['submit', 'sign', 'activate'] as const) {
    const moved = await call<{ contract: { version: number; status: string } }>(
      `${CONTRACTS}/${id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          action,
          reason: `${reason}：${action}`,
          version: current,
          ...(action === 'sign' ? { signedOn: '2026-01-01' } : {}),
        },
      },
    );
    expectStatus(moved, 200);
    current = moved.body.contract.version;
  }
  return current;
}

describe('权益链路的引用前置（功能键 / 产品 / 客户 / 合同）', () => {
  beforeAll(async () => {
    for (const [featureKey, displayName, valueType] of [
      ['ent_feature_a', '基础功能', 'boolean'],
      ['ent_feature_b', '席位数', 'quota'],
    ] as const) {
      const feature = await call(FEATURES, {
        method: 'POST',
        token: opsToken,
        body: { featureKey, displayName, valueType },
      });
      expectStatus(feature, 201);
    }

    const product = await call<{ product: { id: string } }>(PRODUCTS, {
      method: 'POST',
      token: opsToken,
      body: {
        code: 'ENT-INT-001',
        name: '权益集成产品',
        salesModes: [
          { mode: 'saas', isEnabled: true },
          { mode: 'private', isEnabled: true },
        ],
      },
    });
    expectStatus(product, 201);

    const customer = await call<{ customer: { id: string } }>(CUSTOMERS, {
      method: 'POST',
      token: opsToken,
      body: { name: '权益集成客户', reason: '权益域集成测试' },
    });
    expectStatus(customer, 201);
    customerId = customer.body.customer.id;

    // saas 合同：一条条目，用于订阅。
    const saas = await call<{ contract: { id: string; version: number } }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        salesMode: 'saas',
        businessNote: '权益集成 saas 合同',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 5000 }],
      },
    });
    expectStatus(saas, 201);
    const saasVersion = await activateContract(
      saas.body.contract.id,
      saas.body.contract.version,
      'saas',
    );
    const saasDetail = await call<{ items: Array<{ id: string }> }>(
      `${CONTRACTS}/${saas.body.contract.id}`,
      { token: opsToken },
    );
    expectStatus(saasDetail, 200);
    // 详情信封是**扁平**的：`{ contract, items, receivableSummary, … }`。
    // 写成 `contract.items` 会静默拿到 undefined，然后以「400 invalid_type」的
    // 形式在十几条订阅用例里炸开——症状离原因很远。
    saasItemId = saasDetail.body.items[0]!.id;
    expect(saasVersion).toBeGreaterThan(0);

    // private 合同：一条条目，用于私有化授权。
    const priv = await call<{ contract: { id: string; version: number } }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        salesMode: 'private',
        businessNote: '权益集成私有化合同',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 200000 }],
      },
    });
    expectStatus(priv, 201);
    await activateContract(priv.body.contract.id, priv.body.contract.version, 'private');
    const privDetail = await call<{ items: Array<{ id: string }> }>(
      `${CONTRACTS}/${priv.body.contract.id}`,
      { token: opsToken },
    );
    expectStatus(privDetail, 200);
    privateItemId = privDetail.body.items[0]!.id;

    // 停在 draft 的合同：用来证明「合同未生效不能开通」。
    const draft = await call<{ contract: { id: string } }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        salesMode: 'saas',
        businessNote: '权益集成草稿合同',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 1000 }],
      },
    });
    expectStatus(draft, 201);
    // 创建响应只回 `{ contract }`，条目要另拉一次详情。
    const draftDetail = await call<{ items: Array<{ id: string }> }>(
      `${CONTRACTS}/${draft.body.contract.id}`,
      { token: opsToken },
    );
    expectStatus(draftDetail, 200);
    draftContractItemId = draftDetail.body.items[0]!.id;

    // 第二条生效 saas 合同：只为了留一个「能开草案订阅」的条目（见变量注释）。
    const spare = await call<{ contract: { id: string; version: number } }>(CONTRACTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        salesMode: 'saas',
        businessNote: '权益集成备用 saas 合同',
        items: [{ productId: product.body.product.id, quantity: 1, unitPrice: 3000 }],
      },
    });
    expectStatus(spare, 201);
    await activateContract(spare.body.contract.id, spare.body.contract.version, 'spare');
    const spareDetail = await call<{ items: Array<{ id: string }> }>(
      `${CONTRACTS}/${spare.body.contract.id}`,
      { token: opsToken },
    );
    expectStatus(spareDetail, 200);
    spareSaasItemId = spareDetail.body.items[0]!.id;
  });

  it('夹具就绪', () => {
    expect(saasItemId).toBeTruthy();
    expect(privateItemId).toBeTruthy();
    expect(draftContractItemId).toBeTruthy();
    expect(spareSaasItemId).toBeTruthy();
  });
});

describe('POST /api/v1/ops/subscriptions', () => {
  it('缺 Idempotency-Key 时 400', async () => {
    const response = await call(SUBSCRIPTIONS, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: {
        customerId,
        contractItemId: saasItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('Idempotency-Key');
  });

  it('合同未生效时 409 CONTRACT_NOT_ACTIVE', async () => {
    const response = await call(SUBSCRIPTIONS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: draftContractItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('CONTRACT_NOT_ACTIVE');
  });

  it('不认识的 featureKey 回 400 并指出是哪一个', async () => {
    const response = await call(SUBSCRIPTIONS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: saasItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        features: [{ featureKey: 'ent_feature_zzz' }],
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('ent_feature_zzz');
  });

  it('建草案并发放首张快照', async () => {
    const response = await call<{ subscription: SubscriptionBody; snapshot: SnapshotSummaryBody }>(
      SUBSCRIPTIONS,
      {
        method: 'POST',
        token: opsToken,
        body: {
          customerId,
          contractItemId: saasItemId,
          billingCycle: 'yearly',
          startsOn: '2026-01-01',
          endsOn: '2027-12-31',
          autoRenewIntent: true,
          features: [
            { featureKey: 'ent_feature_a', enabled: true },
            { featureKey: 'ent_feature_b', quotaValue: 10 },
          ],
          reason: '首期开通',
        },
      },
    );

    expectStatus(response, 201);
    expect(response.body.subscription.status).toBe('draft');
    expect(response.body.subscription.subscriptionNo).toMatch(/^SUB-\d{6}$/);
    expect(response.body.subscription.currentSnapshotId).toBe(response.body.snapshot.id);
    expect(response.body.snapshot.targetScope).toBe('saas_tenant');
    expect(response.body.snapshot.lineCount).toBe(2);
    expect(response.body.snapshot.contentHash).toHaveLength(64);
    subscription = response.body.subscription;
  });

  it('同一合同条目不能开第二个订阅（409 CONFLICT）', async () => {
    const response = await call(SUBSCRIPTIONS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: saasItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('CONFLICT');
  });

  it('只读账号不能建订阅（403）', async () => {
    const response = await call(SUBSCRIPTIONS, {
      method: 'POST',
      token: viewerToken,
      body: {
        customerId,
        contractItemId: saasItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
      },
    });

    expectStatus(response, 403);
  });
});

describe('POST /api/v1/ops/subscriptions/{id}/transition', () => {
  it('草案直接下发回 409 APPROVAL_REQUIRED', async () => {
    const response = await call(`${SUBSCRIPTIONS}/${subscription.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'suspend', reason: '想直接停掉' },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('APPROVAL_REQUIRED');
  });

  it('提交审批', async () => {
    const response = await call<{ subscription: SubscriptionBody; command: null }>(
      `${SUBSCRIPTIONS}/${subscription.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'submit', version: subscription.version },
      },
    );

    expectStatus(response, 200);
    expect(response.body.subscription.status).toBe('pending_approval');
    expect(response.body.command).toBeNull();
    subscription = response.body.subscription;
  });

  it('版本落后回 409 CONFLICT', async () => {
    const response = await call(`${SUBSCRIPTIONS}/${subscription.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'approve', version: subscription.version - 1 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('VERSION_MISMATCH');
  });

  it('审批激活', async () => {
    const response = await call<{ subscription: SubscriptionBody }>(
      `${SUBSCRIPTIONS}/${subscription.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve', version: subscription.version },
      },
    );

    expectStatus(response, 200);
    expect(response.body.subscription.status).toBe('active');
    subscription = response.body.subscription;
  });

  it('suspend 回 202 且 command 为 null', async () => {
    const response = await call<{ subscription: SubscriptionBody; command: null }>(
      `${SUBSCRIPTIONS}/${subscription.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'suspend', reason: '客户欠费', version: subscription.version },
      },
    );

    expectStatus(response, 202);
    expect(response.body.subscription.status).toBe('suspended');
    expect(response.body.command).toBeNull();
    subscription = response.body.subscription;
  });

  it('resume 回 202 并回到 active', async () => {
    const response = await call<{ subscription: SubscriptionBody }>(
      `${SUBSCRIPTIONS}/${subscription.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'resume', reason: '欠费结清', version: subscription.version },
      },
    );

    expectStatus(response, 202);
    expect(response.body.subscription.status).toBe('active');
    subscription = response.body.subscription;
  });
});

describe('GET /api/v1/ops/subscriptions/{id}', () => {
  it('详情带明细行、变更历史与 null 的租户映射', async () => {
    const response = await call<{
      subscription: SubscriptionBody;
      snapshot: { lines: SnapshotLineBody[]; lineCount: number };
      changeRequests: ChangeRequestBody[];
      tenantMapping: null;
    }>(`${SUBSCRIPTIONS}/${subscription.id}`, { token: opsToken });

    expectStatus(response, 200);
    expect(response.body.snapshot.lines).toHaveLength(2);
    expect(response.body.snapshot.lines.map((line) => line.featureKey).sort()).toEqual([
      'ent_feature_a',
      'ent_feature_b',
    ]);
    expect(response.body.snapshot.lines[0]?.displayNameSnapshot).toBeTruthy();
    expect(response.body.changeRequests).toEqual([]);
    expect(response.body.tenantMapping).toBeNull();
  });

  it('不存在时 404', async () => {
    const response = await call(`${SUBSCRIPTIONS}/00000000-0000-4000-8000-00000000ffff`, {
      token: opsToken,
    });
    expectStatus(response, 404);
  });

  it('只读账号能看（entitlement.read）', async () => {
    const response = await call(`${SUBSCRIPTIONS}/${subscription.id}`, { token: viewerToken });
    expectStatus(response, 200);
  });
});

describe('POST /api/v1/ops/subscriptions/{id}/change-requests', () => {
  it('提变更单，diff 只有新增那一项', async () => {
    const response = await call<{ changeRequest: ChangeRequestBody; diff: DiffBody }>(
      `${SUBSCRIPTIONS}/${subscription.id}/change-requests`,
      {
        method: 'POST',
        token: opsToken,
        body: {
          changeType: 'quota_change',
          reason: '客户扩席',
          proposedFeatures: [{ featureKey: 'ent_feature_b', quotaValue: 20 }],
        },
      },
    );

    expectStatus(response, 201);
    expect(response.body.changeRequest.status).toBe('pending_approval');
    expect(response.body.diff.added).toEqual([]);
    expect(response.body.diff.changed.map((entry) => entry.featureKey)).toEqual(['ent_feature_b']);
    // 基线是当前快照而不是套餐：变更后仍然是两条权益，没有把另一条丢掉。
    expect(response.body.changeRequest.afterSummary.lines).toHaveLength(2);
    expect(
      response.body.changeRequest.afterSummary.lines.find(
        (line) => line.featureKey === 'ent_feature_b',
      )?.quotaValue,
    ).toBe(20);
    changeRequest = response.body.changeRequest;
  });

  it('申请人自批回 403 并带 rule', async () => {
    const response = await call<{ code: string; details: { rule?: string } }>(
      `${CHANGE_REQUESTS}/${changeRequest.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve' },
      },
    );

    expectStatus(response, 403);
    expect(response.body.code).toBe('FORBIDDEN');
    expect(response.body.details.rule).toBe('SEGREGATION_OF_DUTY');
  });

  it('未审批就执行回 409 APPROVAL_REQUIRED', async () => {
    const response = await call(`${CHANGE_REQUESTS}/${changeRequest.id}/transition`, {
      method: 'POST',
      token: opsToken,
      body: { action: 'execute' },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('APPROVAL_REQUIRED');
  });

  it('换个人审批通过（销售提单、管理员批）', async () => {
    // 提单人必须是「有 entitlement.request、无 entitlement.approve」的人，
    // 否则这一段证明的还是「管理员自己走了一遍」。
    const created = await call<{ changeRequest: ChangeRequestBody }>(
      `${SUBSCRIPTIONS}/${subscription.id}/change-requests`,
      {
        method: 'POST',
        token: salesToken,
        body: { changeType: 'quota_change', reason: '销售提单', proposedFeatures: [] },
      },
    );
    expectStatus(created, 201);

    const approved = await call<{ changeRequest: ChangeRequestBody }>(
      `${CHANGE_REQUESTS}/${created.body.changeRequest.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'approve', reason: '同意' },
      },
    );

    expectStatus(approved, 200);
    expect(approved.body.changeRequest.status).toBe('approved');
    expect(approved.body.changeRequest.approvedBy?.id).toBeTruthy();

    const executed = await call<{ changeRequest: ChangeRequestBody; command: null }>(
      `${CHANGE_REQUESTS}/${created.body.changeRequest.id}/transition`,
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'execute' },
      },
    );

    expectStatus(executed, 202);
    expect(executed.body.changeRequest.status).toBe('executed');
    expect(executed.body.command).toBeNull();
  });

  it('草案订阅不能提变更单（409 SUBJECT_NOT_ACTIVE）', async () => {
    // 变更单只能在「已经在生效的」主体上提：草案还没发放给客户，此时改额度
    // 改的是一份没人看过的意向，执行后也不会有人收到任何变化。
    const draftSubscription = await call<{ subscription: SubscriptionBody }>(SUBSCRIPTIONS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: spareSaasItemId,
        billingCycle: 'yearly',
        startsOn: '2026-01-01',
        features: [{ featureKey: 'ent_feature_a' }],
      },
    });
    expectStatus(draftSubscription, 201);
    expect(draftSubscription.body.subscription.status).toBe('draft');

    const rejected = await call(
      `${SUBSCRIPTIONS}/${draftSubscription.body.subscription.id}/change-requests`,
      {
        method: 'POST',
        token: opsToken,
        body: { changeType: 'quota_change', reason: '草案上改额度' },
      },
    );

    expectStatus(rejected, 409);
    expect(JSON.stringify(rejected.body)).toContain('SUBJECT_NOT_ACTIVE');
  });

  it('草案授权同样不能提变更单（同一条守卫）', async () => {
    const license = await call<{ license: LicenseBody }>(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: privateItemId,
        licenseMode: 'perpetual',
        validFrom: '2026-02-01',
      },
    });
    expectStatus(license, 201);
    expect(license.body.license.status).toBe('draft');

    const rejected = await call(`${LICENSES}/${license.body.license.id}/change-requests`, {
      method: 'POST',
      token: opsToken,
      body: { changeType: 'upgrade', reason: '草案上升级' },
    });

    expectStatus(rejected, 409);
    expect(JSON.stringify(rejected.body)).toContain('SUBJECT_NOT_ACTIVE');
  });
});

describe('POST /api/v1/ops/licenses', () => {
  it('永久授权不带有效期', async () => {
    const response = await call<{ license: LicenseBody }>(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: privateItemId,
        deploymentInstanceId: '00000000-0000-4000-8000-0000000a0001',
        licenseMode: 'perpetual',
        validFrom: '2026-02-01',
        maintenanceUntil: '2027-02-01',
        features: [{ featureKey: 'ent_feature_a' }],
        reason: '永久授权',
      },
    });

    expectStatus(response, 201);
    expect(response.body.license.licenseMode).toBe('perpetual');
    expect(response.body.license.validTo).toBeNull();
    expect(response.body.license.maintenanceUntil).toBe('2027-02-01');
    expect(response.body.license.licenseNo).toMatch(/^LIC-\d{6}$/);
  });

  it('永久授权带 validTo 回 400（T-09 验收断言）', async () => {
    const response = await call(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: privateItemId,
        licenseMode: 'perpetual',
        validFrom: '2026-02-01',
        validTo: '2029-02-01',
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('PERPETUAL_WITH_VALID_TO');
  });

  it('期限授权缺 validTo 回 400（反方向）', async () => {
    const response = await call(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: privateItemId,
        licenseMode: 'term',
        validFrom: '2026-02-01',
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('TERM_REQUIRES_VALID_TO');
  });

  it('同一部署实例不能有两份有效授权（409 CONFLICT）', async () => {
    const response = await call(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: privateItemId,
        deploymentInstanceId: '00000000-0000-4000-8000-0000000a0001',
        licenseMode: 'term',
        validFrom: '2026-02-01',
        validTo: '2027-02-01',
      },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('DUPLICATE_LICENSE');
  });

  it('saas 条目不能开私有化授权（400 SALES_MODE_MISMATCH）', async () => {
    const response = await call(LICENSES, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        contractItemId: saasItemId,
        licenseMode: 'term',
        validFrom: '2026-02-01',
        validTo: '2027-02-01',
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('SALES_MODE_MISMATCH');
  });
});

describe('快照不可变', () => {
  it('改字典显示名之后，既有快照的展示名与哈希都不动', async () => {
    const before = await call<{ lines: SnapshotLineBody[]; snapshot: SnapshotSummaryBody }>(
      `${SNAPSHOTS}/${subscription.currentSnapshotId}`,
      { token: opsToken },
    );
    expectStatus(before, 200);

    const patched = await call(`${FEATURES}/ent_feature_a`, {
      method: 'PATCH',
      token: opsToken,
      body: { displayName: '基础功能（改名）' },
    });
    expectStatus(patched, 200);

    const after = await call<{ lines: SnapshotLineBody[]; snapshot: SnapshotSummaryBody }>(
      `${SNAPSHOTS}/${subscription.currentSnapshotId}`,
      { token: opsToken },
    );
    expectStatus(after, 200);

    expect(after.body.snapshot.contentHash).toBe(before.body.snapshot.contentHash);
    expect(
      after.body.lines.find((line) => line.featureKey === 'ent_feature_a')?.displayNameSnapshot,
    ).toBe('基础功能');
  });

  it('按主体筛快照历史，能拿到首张与每次变更', async () => {
    const response = await call<{ items: SnapshotSummaryBody[]; total: number }>(SNAPSHOTS, {
      token: opsToken,
      query: { subjectType: 'subscription', subjectId: subscription.id },
    });

    expectStatus(response, 200);
    // 首张 + 两次变更单各一张（其中一次是自己提单、被别人批的那张）。
    expect(response.body.total).toBeGreaterThanOrEqual(3);
    expect(response.body.items.every((item) => item.contentHash.length === 64)).toBe(true);
  });
});

describe('GET /api/v1/ops/entitlement-change-requests', () => {
  it('按 subjectType 与 status 筛', async () => {
    const response = await call<{ items: ChangeRequestBody[]; total: number }>(CHANGE_REQUESTS, {
      token: opsToken,
      query: { subjectType: 'subscription' },
    });

    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThanOrEqual(2);
    expect(response.body.items.every((item) => item.status !== 'draft')).toBe(true);
  });

  it('详情带 diff 与 command:null', async () => {
    const response = await call<{
      changeRequest: ChangeRequestBody;
      diff: DiffBody;
      command: null;
    }>(`${CHANGE_REQUESTS}/${changeRequest.id}`, { token: opsToken });

    expectStatus(response, 200);
    expect(response.body.diff.after.lines).toHaveLength(2);
    expect(response.body.command).toBeNull();
  });
});

describe('GET /api/v1/ops/subscriptions', () => {
  it('按客户与状态筛', async () => {
    const response = await call<{ items: SubscriptionBody[]; total: number }>(SUBSCRIPTIONS, {
      token: opsToken,
      query: { customerId },
    });

    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThanOrEqual(1);
    expect(response.body.items[0]?.customer.id).toBeDefined();

    const active = await call<{ items: SubscriptionBody[] }>(SUBSCRIPTIONS, {
      token: opsToken,
      query: { customerId, status: 'active' },
    });
    expectStatus(active, 200);
    expect(active.body.items.every((item) => item.status === 'active')).toBe(true);
  });

  it('财务账号有 entitlement.read：权限放行、行不存在回 404', async () => {
    // 断言写成 `[403, 404].toContain(...)` 等于什么都没证明：一旦权限判定退化
    // 成「谁都没 read」，403 也会被接受，而那条退化恰恰是最该被发现的问题。
    const response = await call(`${LICENSES}/00000000-0000-4000-8000-00000000ffff`, {
      token: signToken(OPS_FINANCE_USER),
    });

    expectStatus(response, 404);
  });
});
