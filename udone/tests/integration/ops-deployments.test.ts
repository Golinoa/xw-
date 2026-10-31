import { beforeAll, describe, expect, it } from 'vitest';
import {
  OPS_SALES_USER,
  OPS_USER,
  OPS_VIEWER_USER,
  call,
  expectStatus,
  signToken,
} from './harness';

/**
 * deployment 集成测试：真实 PostgREST + 真实 RLS/RPC。
 *
 * 这一份里唯一「不像别的域」的地方：**当前版本不是一次写出来的，是两次写出来的**。
 * `currentVersion` 只能由「登记一条 succeeded 的升级记录」推进，所以整条链路是
 * 建实例（没有版本）→ 登记升级（版本出现）→ 再登记一条失败的（版本不动）。
 * 少了中间那一步，这个域最该被证明的东西（历史可信、版本有依据）一条都没跑到。
 *
 * 第二条：**退役之后一切都停**。状态走到 `retired`，改档与所有迁移都被拒——
 * 那不是「这个按钮不该点」，是「这台机器不再属于在管资产」。
 */

const DEPLOYMENTS = '/api/v1/ops/deployments';
const CUSTOMERS = '/api/v1/ops/customers';
const TICKETS = '/api/v1/ops/tickets';

const opsToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);
const viewerToken = signToken(OPS_VIEWER_USER);

interface DeploymentBody {
  id: string;
  instanceNo: string;
  name: string;
  status: string;
  deploymentType: string;
  environmentRef: string | null;
  currentVersion: string | null;
  goLiveOn: string | null;
  maintenanceUntil: string | null;
  lastReportedAt: string | null;
  version: number;
}

interface VersionRecordBody {
  id: string;
  fromVersion: string;
  toVersion: string;
  result: string;
  executedBy: { id: string; displayName: string };
}

let customerId: string;
let otherCustomerId: string;
let deployment: DeploymentBody;

async function createCustomer(name: string): Promise<string> {
  const response = await call<{ customer: { id: string } }>(CUSTOMERS, {
    method: 'POST',
    token: opsToken,
    body: { name, reason: '部署域集成测试' },
  });
  expectStatus(response, 201);
  return response.body.customer.id;
}

function deploymentPath(...segments: string[]): string {
  return [DEPLOYMENTS, ...segments].join('/');
}

describe('部署实例的登记与筛选', () => {
  beforeAll(async () => {
    customerId = await createCustomer('部署集成客户甲');
    otherCustomerId = await createCustomer('部署集成客户乙');

    const created = await call<{ deployment: DeploymentBody }>(DEPLOYMENTS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        name: '甲客户生产实例',
        deploymentType: 'private',
        environmentRef: 'bj-prod-01',
        maintenanceUntil: '2027-01-31',
      },
    });
    expectStatus(created, 201);
    deployment = created.body.deployment;
  });

  it('新登记的实例是 planned，且还没有版本与上报时间', () => {
    expect(deployment.status).toBe('planned');
    expect(deployment.instanceNo).toMatch(/^DEP-\d{6}$/);
    // 没有升级记录 → 派生值必须是 null，而不是 createdAt：否则列表里每条新
    // 实例都会显示「今天上报过」。
    expect(deployment.currentVersion).toBeNull();
    expect(deployment.lastReportedAt).toBeNull();
  });

  it('缺 Idempotency-Key 回 400', async () => {
    const response = await call(DEPLOYMENTS, {
      method: 'POST',
      token: opsToken,
      omitIdempotencyKey: true,
      body: { customerId, name: '没带键', deploymentType: 'private' },
    });
    expectStatus(response, 400);
  });

  it('同一客户同名回 409 CONFLICT', async () => {
    const response = await call(DEPLOYMENTS, {
      method: 'POST',
      token: opsToken,
      body: { customerId, name: '甲客户生产实例', deploymentType: 'private' },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('DEPLOYMENT_NAME_TAKEN');
  });

  it('按客户与状态筛，两个运营身份都能读，只有交付侧能写', async () => {
    const byCustomer = await call<{ items: DeploymentBody[]; total: number }>(DEPLOYMENTS, {
      token: viewerToken,
      query: { customerId },
    });
    expectStatus(byCustomer, 200);
    expect(byCustomer.body.total).toBe(1);
    expect(byCustomer.body.items[0]?.id).toBe(deployment.id);

    const byType = await call<{ total: number }>(DEPLOYMENTS, {
      token: salesToken,
      query: { customerId, deploymentType: 'dedicated' },
    });
    expectStatus(byType, 200);
    expect(byType.body.total).toBe(0);

    // 商务运营有 deployment.read 没有 write：能登台账、不能新建。
    const denied = await call(DEPLOYMENTS, {
      method: 'POST',
      token: salesToken,
      body: { customerId, name: '销售建的', deploymentType: 'private' },
    });
    expectStatus(denied, 403);
  });

  it('维护到期日早于这一天的才算「快到期」', async () => {
    const wide = await call<{ total: number }>(DEPLOYMENTS, {
      token: opsToken,
      query: { customerId, maintenanceUntilBefore: '2027-12-31' },
    });
    expectStatus(wide, 200);
    expect(wide.body.total).toBe(1);

    const narrow = await call<{ total: number }>(DEPLOYMENTS, {
      token: opsToken,
      query: { customerId, maintenanceUntilBefore: '2026-12-31' },
    });
    expectStatus(narrow, 200);
    expect(narrow.body.total).toBe(0);
  });
});

describe('改档与状态机', () => {
  it('PATCH 传 null 是清空环境标识', async () => {
    const response = await call<{ deployment: DeploymentBody }>(deploymentPath(deployment.id), {
      method: 'PATCH',
      token: opsToken,
      body: { environmentRef: null, version: deployment.version },
    });

    expectStatus(response, 200);
    expect(response.body.deployment.environmentRef).toBeNull();
    deployment = response.body.deployment;
  });

  it('currentVersion 不是可编辑字段，请求体带它回 400', async () => {
    const response = await call(deploymentPath(deployment.id), {
      method: 'PATCH',
      token: opsToken,
      body: { currentVersion: '9.9.9', version: deployment.version },
    });

    // 静默忽略会让调用方以为版本改成功了——而版本只能由登记升级推进。
    expectStatus(response, 400);
  });

  it('go_live 缺日期回 400', async () => {
    const response = await call(deploymentPath(deployment.id, 'transition'), {
      method: 'POST',
      token: opsToken,
      body: { action: 'go_live', version: deployment.version },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('GO_LIVE_ON_REQUIRED');
  });

  it('go_live 成功，allowedActions 立刻跟着换', async () => {
    const response = await call<{ deployment: DeploymentBody; allowedActions: string[] }>(
      deploymentPath(deployment.id, 'transition'),
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'go_live', goLiveOn: '2026-11-01', version: deployment.version },
      },
    );

    expectStatus(response, 200);
    expect(response.body.deployment.status).toBe('active');
    expect(response.body.deployment.goLiveOn).toBe('2026-11-01');
    expect(response.body.allowedActions).toEqual(['start_maintenance', 'retire']);
    deployment = response.body.deployment;
  });

  it('版本落后回 409 CONFLICT 并带当前版本', async () => {
    const response = await call(deploymentPath(deployment.id, 'transition'), {
      method: 'POST',
      token: opsToken,
      body: { action: 'retire', reason: '客户退租', version: 0 },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('VERSION_MISMATCH');
  });

  it('退役缺原因回 400', async () => {
    const response = await call(deploymentPath(deployment.id, 'transition'), {
      method: 'POST',
      token: opsToken,
      body: { action: 'retire', version: deployment.version },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('REASON_REQUIRED');
  });
});

describe('升级台账', () => {
  it('没有基线时第一条记录就是基线', async () => {
    const created = await call<{
      versionRecord: VersionRecordBody;
      deployment: DeploymentBody;
    }>(deploymentPath(deployment.id, 'version-records'), {
      method: 'POST',
      token: opsToken,
      body: {
        fromVersion: '1.4.0',
        toVersion: '1.4.0',
        executedOn: '2026-10-01',
        result: 'succeeded',
        impactNote: '初始安装',
      },
    });

    expectStatus(created, 201);
    expect(created.body.deployment.currentVersion).toBe('1.4.0');
    // 记录里的执行人取自会话，不是入参。
    expect(created.body.versionRecord.executedBy.id).toBeTruthy();
    expect(created.body.deployment.lastReportedAt).not.toBeNull();
    deployment = created.body.deployment;
  });

  it('失败的记录不推进当前版本', async () => {
    const failed = await call<{ deployment: DeploymentBody }>(
      deploymentPath(deployment.id, 'version-records'),
      {
        method: 'POST',
        token: opsToken,
        body: {
          fromVersion: '1.4.0',
          toVersion: '1.5.0',
          executedOn: '2026-10-10',
          result: 'failed',
          rollbackNote: '回滚脚本未执行',
        },
      },
    );

    expectStatus(failed, 201);
    expect(failed.body.deployment.currentVersion).toBe('1.4.0');
    deployment = failed.body.deployment;
  });

  it('起点版本不符回 409 STATE_CONFLICT，不是 CONFLICT', async () => {
    const response = await call(deploymentPath(deployment.id, 'version-records'), {
      method: 'POST',
      token: opsToken,
      body: {
        fromVersion: '1.3.0',
        toVersion: '1.5.0',
        executedOn: '2026-10-11',
        result: 'succeeded',
      },
    });

    // 这里不是乐观锁：用户该刷新看当前版本，而不是换个数字重试。
    expectStatus(response, 409);
    expect((response.body as { code?: string }).code).toBe('STATE_CONFLICT');
    expect(JSON.stringify(response.body)).toContain('VERSION_MISMATCH');
  });

  it('登记成功才推进版本', async () => {
    const succeeded = await call<{ deployment: DeploymentBody }>(
      deploymentPath(deployment.id, 'version-records'),
      {
        method: 'POST',
        token: opsToken,
        body: {
          fromVersion: '1.4.0',
          toVersion: '1.5.0',
          executedOn: '2026-10-12',
          result: 'succeeded',
        },
      },
    );

    expectStatus(succeeded, 201);
    expect(succeeded.body.deployment.currentVersion).toBe('1.5.0');
    deployment = succeeded.body.deployment;
  });

  it('历史按执行日期倒序，三条都在', async () => {
    const response = await call<{ items: VersionRecordBody[]; total: number }>(
      deploymentPath(deployment.id, 'version-records'),
      { token: viewerToken },
    );

    expectStatus(response, 200);
    expect(response.body.total).toBe(3);
    expect(response.body.items.map((item) => item.toVersion)).toEqual(['1.5.0', '1.5.0', '1.4.0']);
    expect(response.body.items.map((item) => item.result)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
    ]);
  });

  it('详情把历史、授权与工单三样一起带回来', async () => {
    const response = await call<{
      deployment: DeploymentBody;
      allowedActions: string[];
      versionRecords: VersionRecordBody[];
      licenses: unknown[];
      tickets: Array<{ ticketNo: string }>;
    }>(deploymentPath(deployment.id), { token: opsToken });

    expectStatus(response, 200);
    expect(response.body.deployment.currentVersion).toBe('1.5.0');
    expect(response.body.allowedActions).toEqual(['start_maintenance', 'retire']);
    expect(response.body.versionRecords).toHaveLength(3);
    // 没有挂授权，但 `licenses` 必须是数组而不是缺字段——前端会直接遍历它。
    expect(response.body.licenses).toEqual([]);
    expect(response.body.tickets).toEqual([]);
  });
});

describe('工单引用部署实例', () => {
  it('挂别的客户的实例回 400 REFERENCE_CUSTOMER_MISMATCH', async () => {
    const response = await call(TICKETS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId: otherCustomerId,
        subject: '挂错客户的实例',
        description: '这条应该被挡',
        issueType: 'bug',
        priority: 'normal',
        deploymentInstanceId: deployment.id,
      },
    });

    expectStatus(response, 400);
    expect(JSON.stringify(response.body)).toContain('REFERENCE_CUSTOMER_MISMATCH');
  });

  it('挂本客户的实例可以通过，并在详情里出现', async () => {
    const ticket = await call(TICKETS, {
      method: 'POST',
      token: opsToken,
      body: {
        customerId,
        subject: '升级后登录异常',
        description: '升级到 1.5.0 之后三个账号登不上',
        issueType: 'bug',
        priority: 'high',
        deploymentInstanceId: deployment.id,
      },
    });
    expectStatus(ticket, 201);

    const detail = await call<{ tickets: Array<{ subject: string }> }>(
      deploymentPath(deployment.id),
      { token: opsToken },
    );
    expectStatus(detail, 200);
    expect(detail.body.tickets.map((item) => item.subject)).toContain('升级后登录异常');
  });
});

describe('退役之后一切都停', () => {
  it('退役成功', async () => {
    const response = await call<{ deployment: DeploymentBody; allowedActions: string[] }>(
      deploymentPath(deployment.id, 'transition'),
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'retire', reason: '客户退租', version: deployment.version },
      },
    );

    expectStatus(response, 200);
    expect(response.body.deployment.status).toBe('retired');
    expect(response.body.allowedActions).toEqual([]);
    deployment = response.body.deployment;
  });

  it('退役之后改档回 409 STATE_CONFLICT', async () => {
    const response = await call(deploymentPath(deployment.id), {
      method: 'PATCH',
      token: opsToken,
      body: { name: '退役之后改个名', version: deployment.version },
    });

    expectStatus(response, 409);
    expect(JSON.stringify(response.body)).toContain('DEPLOYMENT_RETIRED');
  });

  it('退役之后任何迁移都是 409 且 allowedActions 为空', async () => {
    const response = await call<{ details: { allowedActions?: string[] } }>(
      deploymentPath(deployment.id, 'transition'),
      {
        method: 'POST',
        token: opsToken,
        body: { action: 'go_live', goLiveOn: '2026-12-01', version: deployment.version },
      },
    );

    expectStatus(response, 409);
    // 空数组与「没有这个字段」不同：前者是「明确地什么都不允许」。
    expect(response.body.details.allowedActions ?? []).toEqual([]);
  });

  it('退役之后仍然能读，也能登记升级', async () => {
    const detail = await call(deploymentPath(deployment.id), { token: viewerToken });
    expectStatus(detail, 200);

    // 退役是资产状态的终点，不是台账的终点：最后一台机器的收尾升级也要留痕。
    const record = await call(deploymentPath(deployment.id, 'version-records'), {
      method: 'POST',
      token: opsToken,
      body: {
        fromVersion: '1.5.0',
        toVersion: '1.5.1',
        executedOn: '2026-10-20',
        result: 'succeeded',
        impactNote: '退租前的最后一个安全补丁',
      },
    });
    expectStatus(record, 201);
  });

  it('不存在的实例回 404（详情、升级记录、迁移三处一致）', async () => {
    const missing = '00000000-0000-4000-8000-00000000ffff';

    const detail = await call(deploymentPath(missing), { token: opsToken });
    expectStatus(detail, 404);

    const records = await call(deploymentPath(missing, 'version-records'), { token: opsToken });
    expectStatus(records, 404);

    const transition = await call(deploymentPath(missing, 'transition'), {
      method: 'POST',
      token: opsToken,
      body: { action: 'go_live', goLiveOn: '2026-12-01', version: 0 },
    });
    expectStatus(transition, 404);
  });
});
