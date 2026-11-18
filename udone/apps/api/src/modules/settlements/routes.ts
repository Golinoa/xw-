import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  cancelSettlementRequestSchema,
  createSettlementRequestSchema,
  settlementCandidateListQuerySchema,
  settlementListQuerySchema,
  settlementParamsSchema,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import type { SettlementMutationError, SettlementRepository } from './settlement-service';
import { SettlementForbiddenError, settlementRepository } from './settlement-service';

/**
 * 批量结算（R-SETTLE-01）。
 *
 * 读与写都挂在 `finance.write` 上，不新增权限码：结算与付款申请是同一件事的两个阶段，
 * 单独拆码不会区分出任何角色（三个角色都持有 finance.write）。
 * 「作废已确认批次」额外要求 `finance.approve`，这一道做在库函数里而不是路由上——
 * 同一份规则只写一处，跨端点调用（例如将来的批量作废）才不会漏。
 */
export const settlementRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): SettlementRepository {
  return settlementRepository(context.env, context.get('authToken'));
}

/**
 * 库错误码 → HTTP。
 *
 * 409 与 400 的分界是「重试有没有用」：批次已确认、额度不够，刷新后再试可能成功；
 * 周期写错、明细不属于这家供应商则是请求本身错了，重试一万次也一样。
 */
function mutationError(errorCode: SettlementMutationError) {
  switch (errorCode) {
    case 'NOT_FOUND':
      return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Settlement batch not found');
    case 'SUPPLIER_NOT_FOUND':
      return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Supplier not found');
    case 'PAYABLE_NOT_FOUND':
      return new ApiHttpError(
        409,
        ERROR_CODES.SETTLEMENT_STATE_CONFLICT,
        'A payable line in this batch no longer exists',
      );
    case 'AMOUNT_EXCEEDS_AVAILABLE':
      return new ApiHttpError(
        409,
        ERROR_CODES.SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE,
        'The amount exceeds what is still settleable on this line',
      );
    case 'BATCH_EXISTS':
      return new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'A settlement batch already exists for this supplier and month',
      );
    case 'STATE_CONFLICT':
      return new ApiHttpError(
        409,
        ERROR_CODES.SETTLEMENT_STATE_CONFLICT,
        'The settlement batch is no longer a draft',
      );
    case 'EMPTY_BATCH':
      return new ApiHttpError(
        409,
        ERROR_CODES.SETTLEMENT_STATE_CONFLICT,
        'The settlement batch has no items',
      );
    case 'REASON_REQUIRED':
      return new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'A reason is required to cancel a confirmed batch',
      );
    case 'PERIOD_INVALID':
    case 'METHOD_INVALID':
    case 'ITEMS_REQUIRED':
    case 'ITEM_INVALID':
    case 'DUPLICATE_ITEM':
    case 'SUPPLIER_MISMATCH':
      return new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The settlement request does not match the settlement rules',
      );
  }
}

/** 库函数的 42501 不能在应用层变成 500：用户只是没有审批权。 */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof SettlementForbiddenError) {
      throw new ApiHttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'Cancelling a confirmed batch requires finance.approve',
      );
    }
    throw cause;
  }
}

settlementRoutes.get(
  ROUTES.listSettlements.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const query = parseQuery(context, settlementListQuerySchema);
    const page = await repository(context).list({
      organizationId: context.get('auth').organizationId,
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.periodMonth ? { periodMonth: query.periodMonth } : {}),
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listSettlements', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

settlementRoutes.get(
  ROUTES.listSettlementCandidates.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const query = parseQuery(context, settlementCandidateListQuerySchema);
    const items = await repository(context).candidates(
      context.get('auth').organizationId,
      query.supplierId,
    );
    return respond(context, 'listSettlementCandidates', { items });
  },
);

settlementRoutes.get(
  ROUTES.getSettlement.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const { batchId } = parseParams(context, settlementParamsSchema);
    const settlement = await repository(context).get(context.get('auth').organizationId, batchId);
    if (!settlement) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Settlement batch not found');
    }
    return respond(context, 'getSettlement', { settlement });
  },
);

settlementRoutes.post(
  ROUTES.createSettlement.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const input = await parseJson(context, createSettlementRequestSchema);
    const outcome = await run(() =>
      repository(context).create(context.get('auth').organizationId, input),
    );
    if ('error' in outcome) throw mutationError(outcome.error);

    const settlement = await repository(context).get(
      context.get('auth').organizationId,
      outcome.batchId,
    );
    if (!settlement) {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Settlement batch not found');
    }
    return respond(context, 'createSettlement', { settlement }, 201);
  },
);

settlementRoutes.post(
  ROUTES.confirmSettlement.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const { batchId } = parseParams(context, settlementParamsSchema);
    const outcome = await run(() =>
      repository(context).confirm(context.get('auth').organizationId, batchId),
    );
    if ('error' in outcome) throw mutationError(outcome.error);
    return respond(context, 'confirmSettlement', {
      settlementId: batchId,
      status: outcome.status,
      totalAmount: outcome.totalAmount,
    });
  },
);

settlementRoutes.post(
  ROUTES.cancelSettlement.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const { batchId } = parseParams(context, settlementParamsSchema);
    // 作废请求体可以只发 `{}`；已确认批次缺原因时由库函数返回 REASON_REQUIRED。
    const input = await parseJson(context, cancelSettlementRequestSchema);
    const outcome = await run(() =>
      repository(context).cancel(context.get('auth').organizationId, batchId, input.reason),
    );
    if ('error' in outcome) throw mutationError(outcome.error);
    const settlement = await repository(context).get(context.get('auth').organizationId, batchId);
    return respond(context, 'cancelSettlement', {
      settlementId: batchId,
      status: outcome.status,
      totalAmount: settlement?.totalAmount ?? 0,
    });
  },
);
