import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface Balance {
  accountId: string;
  accountName: string;
  method: string;
  openingBalance: number;
  confirmedIn: number;
  confirmedOut: number;
  adjustments: number;
  balance: number;
}

interface ErrorBody {
  code?: string;
}

describe('账户余额走真实 PostgREST', () => {
  it('初始余额列表可为空且能正常返回', async () => {
    const response = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('管理员建账户后余额等于期初', async () => {
    const created = await call<{ accountId: string }>('/api/fund-accounts', {
      method: 'POST',
      actor: 'admin',
      body: { name: `余额测试账户-${Date.now()}`, method: 'cash', openingBalance: 888 },
    });
    expectStatus(created, 200);

    const list = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(list, 200);
    const account = list.body.items.find((item) => item.accountId === created.body.accountId);
    expect(account).toMatchObject({ openingBalance: 888, balance: 888, confirmedIn: 0 });
  });

  it('调整需要原因，缺原因被拒', async () => {
    const list = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(list, 200);
    const account = list.body.items[0]!;

    const response = await call<ErrorBody>('/api/account-balances/adjust', {
      method: 'POST',
      actor: 'admin',
      body: { accountId: account.accountId, amount: -1, reason: '' },
    });
    expectStatus(response, 400);
  });

  it('带原因的调整会改变余额', async () => {
    const list = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(list, 200);
    const account = list.body.items[0]!;

    const adjusted = await call<{ adjustmentId: string }>('/api/account-balances/adjust', {
      method: 'POST',
      actor: 'admin',
      body: { accountId: account.accountId, amount: 100, reason: '集成测试调账' },
    });
    expectStatus(adjusted, 200);

    const after = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(after, 200);
    const updated = after.body.items.find((item) => item.accountId === account.accountId);
    expect(updated!.balance).toBe(account.balance + 100);
  });

  it('无 finance.approve 的角色不能调账', async () => {
    const list = await call<{ items: Balance[] }>('/api/account-balances', { actor: 'admin' });
    expectStatus(list, 200);
    const account = list.body.items[0]!;

    const response = await call('/api/account-balances/adjust', {
      method: 'POST',
      actor: 'operator',
      body: { accountId: account.accountId, amount: 100, reason: '越权测试' },
    });
    expectStatus(response, 403);
  });
});
