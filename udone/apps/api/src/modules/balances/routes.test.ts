import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { BalanceRepository } from './balance-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['settings.manage', 'finance.approve'],
  dataScope: 'all',
};
const operator: AuthContext = { ...admin, role: 'operator', permissions: [] };

const balance = {
  accountId: 'acc-1',
  accountName: '银行账户',
  method: 'bank' as const,
  openingBalance: 1000,
  confirmedIn: 3000,
  confirmedOut: 0,
  adjustments: -500,
  balance: 3500,
};

function repositoryStub(overrides: Partial<BalanceRepository> = {}): BalanceRepository {
  return {
    list: vi.fn().mockResolvedValue({ items: [balance] }),
    createAccount: vi.fn().mockResolvedValue({ accountId: 'acc-2' }),
    adjust: vi.fn().mockResolvedValue({ adjustmentId: 'adj-1' }),
    ...overrides,
  };
}

function setup(repository: BalanceRepository, identity: AuthContext = admin) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (ctx, permission) => ctx.permissions.includes(permission)),
    },
    BALANCE_REPOSITORY: repository,
  };
  return { testApp, env };
}

const headers = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

describe('balance routes', () => {
  it('returns balances computed by the database', async () => {
    const list = vi.fn().mockResolvedValue({ items: [balance] });
    const { testApp, env } = setup(repositoryStub({ list }));
    const response = await testApp.request('/api/account-balances', { headers }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: (typeof balance)[] };
    expect(body.items[0]).toMatchObject({ balance: 3500 });
    expect(list).toHaveBeenCalledWith(ORG);
  });

  it('creates a fund account with settings.manage', async () => {
    const createAccount = vi.fn().mockResolvedValue({ accountId: 'acc-2' });
    const { testApp, env } = setup(repositoryStub({ createAccount }));
    const response = await testApp.request(
      '/api/fund-accounts',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '现金账户', method: 'cash', openingBalance: 500 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accountId: 'acc-2' });
  });

  it('adjusts a balance with finance.approve', async () => {
    const adjust = vi.fn().mockResolvedValue({ adjustmentId: 'adj-1' });
    const { testApp, env } = setup(repositoryStub({ adjust }));
    const response = await testApp.request(
      '/api/account-balances/adjust',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ accountId: 'acc-1', amount: -100, reason: '手续费' }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(adjust).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ accountId: 'acc-1', amount: -100 }),
    );
  });

  it('refuses a zero adjustment at the contract boundary', async () => {
    const adjust = vi.fn();
    const { testApp, env } = setup(repositoryStub({ adjust }));
    const response = await testApp.request(
      '/api/account-balances/adjust',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ accountId: 'acc-1', amount: 0, reason: '手续费' }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(adjust).not.toHaveBeenCalled();
  });

  it('refuses writes without the right permission', async () => {
    const adjust = vi.fn();
    const { testApp, env } = setup(repositoryStub({ adjust }), operator);
    const response = await testApp.request(
      '/api/account-balances/adjust',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ accountId: 'acc-1', amount: -100, reason: '手续费' }),
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(adjust).not.toHaveBeenCalled();
  });
});
