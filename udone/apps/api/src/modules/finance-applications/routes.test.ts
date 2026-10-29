import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, FinanceApplicationItem } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { FinanceApplicationRepository } from './finance-application-service';
import { FinanceApplicationForbiddenError } from './finance-application-service';

/**
 * 这里的断言围着三件事转：
 * 1. 权限是路由级决定的，不是 handler 里的 if——缺 finance.approve 的账号连请求体都不该被解析。
 * 2. 库里的业务错误码必须映射成**不同**的 HTTP 状态与错误码，前端才能给出不一样的提示。
 *    「额度不足」和「别人已经审过」都是 409，但错误码不同；混成一个码，界面只能笼统地说「冲突」。
 * 3. 库函数抛出的 42501 不能变成 500。用户只是没有这个权限，不是服务器坏了。
 */

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read', 'finance.write', 'finance.approve'],
  dataScope: 'all',
};

const financeIdentity: AuthContext = {
  ...adminIdentity,
  userId: 'user-finance',
  role: 'finance',
};

/** 经纪人：能发起申请，不能审批。 */
const operatorIdentity: AuthContext = {
  ...adminIdentity,
  userId: 'user-operator',
  role: 'operator',
  permissions: ['order.read', 'finance.write'],
  dataScope: 'own',
};

const outsiderIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  permissions: [],
  dataScope: 'own',
};

function application(overrides: Partial<FinanceApplicationItem> = {}): FinanceApplicationItem {
  return {
    id: 'app-1',
    kind: 'receipt',
    status: 'pending',
    currentStep: 1,
    orderId: 'order-accept',
    orderNumber: 'SO-20261029-000009',
    customerName: '张三',
    lineId: 'rec-1',
    lineName: '团费',
    amount: 3000,
    method: 'bank',
    occurredOn: '2026-10-29',
    referenceNo: null,
    voucherUrl: null,
    remark: null,
    createdBy: 'user-operator',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

function repositoryStub(
  overrides: Partial<FinanceApplicationRepository> = {},
): FinanceApplicationRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    findDetail: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    decide: vi.fn(),
    withdraw: vi.fn(),
    undo: vi.fn(),
    ...overrides,
  };
}

function setup(options: { applications?: FinanceApplicationRepository; identity?: AuthContext }) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(options.identity ?? adminIdentity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    FINANCE_APPLICATION_REPOSITORY: options.applications ?? repositoryStub(),
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };

const createBody = {
  kind: 'receipt',
  orderId: 'order-accept',
  lineId: 'rec-1',
  amount: 3000,
  method: 'bank',
  occurredOn: '2026-10-29',
};

describe('list finance applications', () => {
  it('returns a paged list and forwards the filters', async () => {
    const list = vi.fn().mockResolvedValue({ items: [application()], total: 7 });
    const { testApp, env } = setup({ applications: repositoryStub({ list }) });

    const response = await testApp.request(
      '/api/finance-applications?status=pending&kind=receipt&page=2&pageSize=20&keyword=SO-2026',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      page: number;
      pageSize: number;
      items: Array<{ lineName: string; amount: number }>;
    };
    expect(body).toMatchObject({ total: 7, page: 2, pageSize: 20 });
    expect(body.items[0]).toMatchObject({ lineName: '团费', amount: 3000 });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-alpha',
        status: 'pending',
        kind: 'receipt',
        keyword: 'SO-2026',
        page: 2,
        pageSize: 20,
      }),
    );
  });

  it('rejects a caller without order.read', async () => {
    const { testApp, env } = setup({ identity: outsiderIdentity });

    const response = await testApp.request(
      '/api/finance-applications',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(403);
  });

  it('rejects a sort field outside the whitelist', async () => {
    const { testApp, env } = setup({});

    const response = await testApp.request(
      '/api/finance-applications?sort=status',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(400);
  });
});

describe('create finance application', () => {
  it('creates a receipt and returns the stored application', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, application: application() });
    const { testApp, env } = setup({ applications: repositoryStub({ create }) });

    const response = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      'org-alpha',
      expect.objectContaining({
        kind: 'receipt',
        orderId: 'order-accept',
        lineId: 'rec-1',
        amount: 3000,
        method: 'bank',
      }),
    );
  });

  it('returns 409 with a dedicated code when the amount exceeds the line balance', async () => {
    const create = vi.fn().mockResolvedValue({ ok: false, errorCode: 'AMOUNT_EXCEEDS_AVAILABLE' });
    const { testApp, env } = setup({ applications: repositoryStub({ create }) });

    const response = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('FINANCE_AMOUNT_EXCEEDS_AVAILABLE');
  });

  it('treats a line from another order as a validation error, not a server fault', async () => {
    const create = vi.fn().mockResolvedValue({ ok: false, errorCode: 'LINE_NOT_FOUND' });
    const { testApp, env } = setup({ applications: repositoryStub({ create }) });

    const response = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a zero amount before calling the repository', async () => {
    const create = vi.fn();
    const { testApp, env } = setup({ applications: repositoryStub({ create }) });

    const response = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createBody, amount: 0 }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a caller without finance.write', async () => {
    const create = vi.fn();
    const { testApp, env } = setup({
      applications: repositoryStub({ create }),
      identity: { ...adminIdentity, permissions: ['order.read'] },
    });

    const response = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('lets an operator start an application without letting them approve it', async () => {
    const create = vi.fn().mockResolvedValue({ ok: true, application: application() });
    const { testApp, env } = setup({
      applications: repositoryStub({ create }),
      identity: operatorIdentity,
    });

    const created = await testApp.request(
      '/api/finance-applications',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      },
      env,
    );
    const decided = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: 1 }),
      },
      env,
    );

    expect(created.status).toBe(201);
    expect(decided.status).toBe(403);
  });
});

describe('read a single application', () => {
  it('returns the application with its decision trail', async () => {
    const findDetail = vi.fn().mockResolvedValue({
      application: application({ status: 'pending', currentStep: 2 }),
      actions: [
        {
          id: 'action-1',
          step: 1,
          action: 'approve',
          opinion: '金额与合同一致',
          fromStatus: 'pending',
          toStatus: 'pending',
          actorId: 'user-finance',
          createdAt: '2026-10-29T01:00:00Z',
        },
      ],
    });
    const { testApp, env } = setup({ applications: repositoryStub({ findDetail }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { actions: Array<{ step: number; action: string }> };
    expect(body.actions[0]).toMatchObject({ step: 1, action: 'approve' });
  });

  it('returns 404 for an application outside the caller scope', async () => {
    const { testApp, env } = setup({});

    const response = await testApp.request(
      '/api/finance-applications/missing',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });
});

describe('decide an application', () => {
  it('approves and returns the new state', async () => {
    const decide = vi.fn().mockResolvedValue({
      ok: true,
      application: application({ status: 'approved', currentStep: 2, version: 2 }),
    });
    const { testApp, env } = setup({ applications: repositoryStub({ decide }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { application: { status: string; version: number } };
    expect(body.application).toMatchObject({ status: 'approved', version: 2 });
    expect(decide).toHaveBeenCalledWith('org-alpha', 'app-1', 'approve', undefined, 1);
  });

  it('rejects a rejection that carries no opinion', async () => {
    // 契约层就挡住，连库都不用碰：驳回不写理由，创建人不知道要改哪里。
    const decide = vi.fn();
    const { testApp, env } = setup({ applications: repositoryStub({ decide }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('distinguishes a stale version from a stale status', async () => {
    const staleVersion = vi.fn().mockResolvedValue({ ok: false, errorCode: 'VERSION_CONFLICT' });
    const staleStatus = vi
      .fn()
      .mockResolvedValue({ ok: false, errorCode: 'APPLICATION_STATE_CONFLICT' });

    const first = await setup({ applications: repositoryStub({ decide: staleVersion }) });
    const second = await setup({ applications: repositoryStub({ decide: staleStatus }) });

    const responses = await Promise.all([
      first.testApp.request(
        '/api/finance-applications/app-1',
        {
          method: 'PATCH',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', version: 1 }),
        },
        first.env,
      ),
      second.testApp.request(
        '/api/finance-applications/app-1',
        {
          method: 'PATCH',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', version: 2 }),
        },
        second.env,
      ),
    ]);

    expect(responses[0].status).toBe(409);
    expect(responses[1].status).toBe(409);
    const codes = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { code: string }).code),
    );
    // 都是 409，但错误码必须不同：一个是「刷新后重试」，一个是「已经有人审过了」。
    expect(codes).toEqual(['CONFLICT', 'FINANCE_APPLICATION_STATE_CONFLICT']);
  });

  it('forbids approving your own application', async () => {
    const decide = vi.fn().mockResolvedValue({ ok: false, errorCode: 'SELF_APPROVAL_FORBIDDEN' });
    const { testApp, env } = setup({ applications: repositoryStub({ decide }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('FINANCE_SELF_APPROVAL_FORBIDDEN');
  });

  it('maps a database permission rejection to 403 instead of 500', async () => {
    // 财务角色点终审时，库函数用 42501 拒绝。不接住就是 500「服务不可用」——那是在说谎。
    const decide = vi.fn().mockRejectedValue(new FinanceApplicationForbiddenError());
    const { testApp, env } = setup({
      applications: repositoryStub({ decide }),
      identity: financeIdentity,
    });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('rejects a caller without finance.approve', async () => {
    const decide = vi.fn();
    const { testApp, env } = setup({
      applications: repositoryStub({ decide }),
      identity: operatorIdentity,
    });

    const response = await testApp.request(
      '/api/finance-applications/app-1',
      {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('withdraw and undo', () => {
  it('withdraws with a reason and returns a withdrawn application', async () => {
    const withdraw = vi.fn().mockResolvedValue({
      ok: true,
      application: application({ status: 'withdrawn', version: 2 }),
    });
    const { testApp, env } = setup({
      applications: repositoryStub({ withdraw }),
      identity: operatorIdentity,
    });

    const response = await testApp.request(
      '/api/finance-applications/app-1/withdraw',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '客户改走转账', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { application: { status: string } };
    expect(body.application.status).toBe('withdrawn');
  });

  it('refuses a withdrawal without a reason', async () => {
    const withdraw = vi.fn();
    const { testApp, env } = setup({ applications: repositoryStub({ withdraw }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1/withdraw',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '   ', version: 1 }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('undoes a final approval and puts the application back to pending', async () => {
    const undo = vi.fn().mockResolvedValue({
      ok: true,
      application: application({ status: 'pending', currentStep: 2, version: 3 }),
    });
    const { testApp, env } = setup({ applications: repositoryStub({ undo }) });

    const response = await testApp.request(
      '/api/finance-applications/app-1/undo',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '银行退回，需要重新核对', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      application: { status: string; currentStep: number };
    };
    expect(body.application).toMatchObject({ status: 'pending', currentStep: 2 });
  });

  it('only lets holders of finance.approve attempt an undo', async () => {
    const undo = vi.fn();
    const { testApp, env } = setup({
      applications: repositoryStub({ undo }),
      identity: operatorIdentity,
    });

    const response = await testApp.request(
      '/api/finance-applications/app-1/undo',
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '退回', version: 2 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    expect(undo).not.toHaveBeenCalled();
  });
});
