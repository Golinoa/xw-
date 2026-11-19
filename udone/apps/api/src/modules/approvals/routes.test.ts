import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalFlow, AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { ApprovalFlowRepository } from './approval-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['settings.manage'],
  dataScope: 'all',
};

const operator: AuthContext = {
  ...admin,
  userId: 'a1000000-0000-4000-8000-000000000002',
  role: 'operator',
  permissions: ['order.read'],
};

function flow(overrides: Partial<ApprovalFlow> = {}): ApprovalFlow {
  return {
    steps: [
      { step: 1, permission: 'finance.approve' },
      { step: 2, permission: 'settings.manage' },
    ],
    allowSelfApproval: false,
    allowWithdraw: true,
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<ApprovalFlowRepository> = {}): ApprovalFlowRepository {
  return {
    get: vi.fn().mockResolvedValue(flow()),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setup(repository: ApprovalFlowRepository, identity: AuthContext = admin) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    APPROVAL_FLOW_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

describe('approval flow routes', () => {
  it('returns the effective flow to any member', async () => {
    const { testApp, env } = setup(repositoryStub(), operator);
    const response = await testApp.request('/api/approvals/flow', { headers: authHeaders }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      steps: [
        { step: 1, permission: 'finance.approve' },
        { step: 2, permission: 'settings.manage' },
      ],
      allowSelfApproval: false,
    });
  });

  it('saves then re-reads, so the response is the stored flow', async () => {
    const repository = repositoryStub({
      get: vi.fn().mockResolvedValue(flow({ allowWithdraw: false })),
    });
    const { testApp, env } = setup(repository);
    const response = await testApp.request(
      '/api/approvals/flow',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(flow({ allowWithdraw: false })),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowWithdraw: false });
    expect(repository.save).toHaveBeenCalledOnce();
    expect(repository.get).toHaveBeenCalled();
  });

  it('rejects a member without settings.manage', async () => {
    const { testApp, env } = setup(repositoryStub(), operator);
    const response = await testApp.request(
      '/api/approvals/flow',
      { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(flow()) },
      env,
    );
    expect(response.status).toBe(403);
  });

  it('rejects steps that are not numbered from 1', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request(
      '/api/approvals/flow',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(
          flow({
            steps: [
              { step: 1, permission: 'finance.approve' },
              { step: 3, permission: 'settings.manage' },
            ],
          }),
        ),
      },
      env,
    );
    // 级次断号会让 decide_finance_application 在第 2 级找不到人，必须当场拒。
    expect(response.status).toBe(400);
  });

  it('rejects an unknown step permission', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request(
      '/api/approvals/flow',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(flow({ steps: [{ step: 1, permission: 'order.write' as never }] })),
      },
      env,
    );
    expect(response.status).toBe(400);
  });
});
