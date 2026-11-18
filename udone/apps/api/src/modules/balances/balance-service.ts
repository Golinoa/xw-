import type { AccountBalance, AccountBalanceListResponse } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

type BalanceRow = {
  account_id: string;
  account_name: string;
  method: AccountBalance['method'];
  opening_balance: number;
  confirmed_in: number;
  confirmed_out: number;
  adjustments: number;
  balance: number;
};

type AccountResult = { result_account_id: string | null; error_code: string | null };
type AdjustmentResult = { result_adjustment_id: string | null; error_code: string | null };

export interface BalanceRepository {
  list(organizationId: string): Promise<AccountBalanceListResponse>;
  createAccount(
    organizationId: string,
    input: { name: string; method: string; openingBalance: number; remark?: string },
  ): Promise<{ accountId?: string; error?: string }>;
  adjust(
    organizationId: string,
    input: { accountId: string; amount: number; reason: string },
  ): Promise<{ adjustmentId?: string; error?: string }>;
}

export function balanceRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): BalanceRepository {
  const client = createRestClient(environment, token);

  return {
    async list(organizationId) {
      // 余额是数据库函数实时算的，这里一行金额运算都不能有。
      const rows = await client.rest<BalanceRow[]>('rpc/account_balances', {
        method: 'POST',
        organizationId,
      });
      return {
        items: rows.map((row) => ({
          accountId: row.account_id,
          accountName: row.account_name,
          method: row.method,
          openingBalance: row.opening_balance,
          confirmedIn: row.confirmed_in,
          confirmedOut: row.confirmed_out,
          adjustments: row.adjustments,
          balance: row.balance,
        })),
      };
    },

    async createAccount(organizationId, input) {
      const rows = await client.rest<AccountResult[]>('rpc/create_fund_account', {
        method: 'POST',
        organizationId,
        body: {
          requested_name: input.name,
          requested_method: input.method,
          requested_opening_balance: input.openingBalance,
          requested_remark: input.remark ?? null,
        },
      });
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code };
      if (!row?.result_account_id) return { error: 'INVALID_ACCOUNT' };
      return { accountId: row.result_account_id };
    },

    async adjust(organizationId, input) {
      const rows = await client.rest<AdjustmentResult[]>('rpc/adjust_account_balance', {
        method: 'POST',
        organizationId,
        body: {
          requested_account_id: input.accountId,
          requested_amount: input.amount,
          requested_reason: input.reason,
        },
      });
      const row = rows[0];
      if (row?.error_code) return { error: row.error_code };
      if (!row?.result_adjustment_id) return { error: 'INVALID_ADJUSTMENT' };
      return { adjustmentId: row.result_adjustment_id };
    },
  };
}
