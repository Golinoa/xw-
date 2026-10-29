import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * identity 域写请求的幂等键契约（契约 §2.5）。
 *
 * 幂等键做成必填参数后，「忘了传」会在 typecheck 阶段失败；但「传了却没发出去」
 * 只能靠请求级断言兜住。这里直接 mock `requestClient` 记录调用参数，而不是走
 * axios adapter——后者会连带触发请求内核的拦截链（重试、错误映射、通知），
 * 断言点被淹没在无关分支里。
 */

interface CapturedCall {
  args: unknown[];
  config?: Record<string, unknown>;
  method?: string;
  url: string;
}

const requests = vi.hoisted(() => [] as CapturedCall[]);

const requestClient = vi.hoisted(() => {
  const record =
    (method: string) =>
    async (url: string, ...rest: unknown[]) => {
      requests.push({ args: rest, method, url });
      return { items: [], page: 1, pageSize: 20, total: 0 };
    };
  return {
    get: record('GET'),
    post: record('POST'),
    request: (url: string, config?: Record<string, unknown>) => {
      const method =
        typeof config?.method === 'string' ? config.method : undefined;
      requests.push({ args: [config], config, method, url });
      return Promise.resolve({ items: [], page: 1, pageSize: 20, total: 0 });
    },
  };
});

vi.mock('#/api/request', () => ({ baseRequestClient: {}, requestClient }));
vi.mock('#/api/adapter/env', () => ({
  getOpsEnv: () => ({ opsApiPrefix: '/v1/ops' }),
}));

const operators = await import('#/api/ops/identity/operators');
const roles = await import('#/api/ops/identity/roles');
const audit = await import('#/api/ops/identity/audit-events');

beforeEach(() => {
  requests.length = 0;
});

/** 取第 n 次调用的请求头（POST 走第 2 个参数，PATCH 走 config.headers）。 */
function headersOf(index: number): Record<string, string> {
  const call = requests[index];
  if (!call) {
    throw new Error(`no request at ${index}`);
  }
  const [, maybeConfig] = call.args as [unknown, Record<string, unknown>?];
  const config = (call.config ?? maybeConfig) as
    | undefined
    | { headers?: Record<string, string> };
  return config?.headers ?? {};
}

describe('写请求必须携带调用方的幂等键', () => {
  it('邀请成员：POST /operators/invitations 且带 key', async () => {
    await operators.inviteOperator(
      {
        email: 'ops.demo@example.invalid',
        reason: '新同事入职（虚构）',
        roleCodes: ['ops_operator'],
      },
      'idem-invite-001',
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST' });
    expect(String(requests[0]?.url)).toContain('/operators/invitations');
    expect(headersOf(0)).toMatchObject({
      'Idempotency-Key': 'idem-invite-001',
    });
  });

  it('同一 key 重放两次：两次请求头一致（服务端才能识别为重放）', async () => {
    const key = 'idem-replay-002';
    const payload = {
      email: 'ops.demo@example.invalid',
      reason: '重复点击（虚构）',
      roleCodes: ['ops_operator'],
    };

    await operators.inviteOperator(payload, key);
    await operators.inviteOperator(payload, key);

    const sent = requests.map((_, i) => headersOf(i)['Idempotency-Key']);
    expect(sent).toEqual([key, key]);
  });

  it('修改成员：PATCH /operators/{id} 且带 key 与 version', async () => {
    await operators.updateOperator(
      'op-1',
      { reason: '调整角色（虚构）', roleCodes: ['ops_admin'], version: 7 },
      'idem-update-003',
    );

    expect(requests[0]).toMatchObject({ method: 'PATCH' });
    expect(String(requests[0]?.url)).toContain('/operators/op-1');
    expect(headersOf(0)).toMatchObject({
      'Idempotency-Key': 'idem-update-003',
    });
    // version 必须进请求体：缺了就是无条件覆盖，并发下会冲掉别人的改动
    // PATCH 走 `request(url, { data, headers, method })`，请求体在 config.data
    const config = requests[0]?.args?.[0] as
      | undefined
      | { data?: Record<string, unknown> };
    expect(config?.data).toMatchObject({ version: 7 });
  });

  it('创建角色：POST /roles 且带 key', async () => {
    await roles.createRole(
      { code: 'ops_auditor', name: '审计员（虚构）', permissionCodes: [] },
      'idem-role-004',
    );

    expect(requests[0]).toMatchObject({ method: 'POST' });
    expect(String(requests[0]?.url)).toContain('/roles');
    expect(headersOf(0)).toMatchObject({ 'Idempotency-Key': 'idem-role-004' });
  });

  it('修改角色：PATCH /roles/{id} 且带 key', async () => {
    await roles.updateRole(
      'role-1',
      { permissionCodes: ['audit.read'], reason: '补审计权限（虚构）' },
      'idem-role-005',
    );

    expect(requests[0]).toMatchObject({ method: 'PATCH' });
    expect(String(requests[0]?.url)).toContain('/roles/role-1');
    expect(headersOf(0)).toMatchObject({ 'Idempotency-Key': 'idem-role-005' });
  });
});

describe('只读端点不得携带幂等键', () => {
  it('成员列表：GET，无 Idempotency-Key', async () => {
    await operators.fetchOperators({ page: 1, pageSize: 20 });

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(headersOf(0)).not.toHaveProperty('Idempotency-Key');
  });

  it('审计列表：GET，无 Idempotency-Key（审计是只读事实）', async () => {
    await audit.fetchAuditEvents({ action: 'operator.update' });

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(headersOf(0)).not.toHaveProperty('Idempotency-Key');
  });
});

describe('查询参数不发送空值', () => {
  it('undefined / 空串被剔除，只发有值的筛选项', async () => {
    await operators.fetchOperators({
      keyword: '张运营',
      page: 1,
      roleCode: '',
      status: undefined,
    });

    // GET 的第二个参数就是 `{ params }`
    const config = requests[0]?.args?.[0] as
      | undefined
      | { params?: Record<string, unknown> };
    const actual = config?.params ?? {};

    expect(actual).toMatchObject({ keyword: '张运营', page: 1 });
    // 发空串会被后端当成「筛该字段为空」，结果变空列表而不是不过滤
    expect(actual).not.toHaveProperty('status');
    expect(actual).not.toHaveProperty('roleCode');
  });
});
