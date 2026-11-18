import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  adjustBalanceRequestSchema,
  createFundAccountRequestSchema,
} from '@erp/contracts';
import { parseJson, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { balanceRepository } from './balance-service';

/**
 * 账户余额（R-BALANCE-01）。
 *
 * 金额口径全在数据库的 `account_balances()` 里，本层不碰数字。
 * 写权限与库函数保持一致：建账户 settings.manage、调整 finance.approve，
 * 前端隐藏入口只是体验，这里才是真门。
 */
export const balanceRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext) {
  return context.env.BALANCE_REPOSITORY ?? balanceRepository(context.env, context.get('authToken'));
}

balanceRoutes.get(ROUTES.listAccountBalances.path, requireAuth(), async (context) => {
  const result = await repository(context).list(context.get('auth').organizationId);
  return respond(context, 'listAccountBalances', result);
});

balanceRoutes.post(
  ROUTES.createFundAccount.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (context) => {
    const body = await parseJson(context, createFundAccountRequestSchema);
    const result = await repository(context).createAccount(
      context.get('auth').organizationId,
      body,
    );
    if (result.error === 'INVALID_ACCOUNT') {
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Invalid fund account');
    }
    return respond(context, 'createFundAccount', { accountId: result.accountId! });
  },
);

balanceRoutes.post(
  ROUTES.adjustAccountBalance.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_APPROVE),
  async (context) => {
    const body = await parseJson(context, adjustBalanceRequestSchema);
    const result = await repository(context).adjust(context.get('auth').organizationId, body);
    if (result.error === 'INVALID_ADJUSTMENT') {
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Invalid balance adjustment');
    }
    if (result.error === 'ACCOUNT_NOT_FOUND') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Fund account not found');
    }
    return respond(context, 'adjustAccountBalance', { adjustmentId: result.adjustmentId! });
  },
);
