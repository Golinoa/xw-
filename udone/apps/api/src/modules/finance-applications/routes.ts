import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  createFinanceApplicationRequestSchema,
  decideFinanceApplicationRequestSchema,
  financeApplicationListQuerySchema,
  financeApplicationParamsSchema,
  financeApplicationReasonRequestSchema,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import type {
  FinanceApplicationMutationError,
  FinanceApplicationRepository,
} from './finance-application-service';
import {
  FinanceApplicationForbiddenError,
  financeApplicationRepository,
} from './finance-application-service';

export const financeApplicationRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext): FinanceApplicationRepository {
  return financeApplicationRepository(context.env, context.get('authToken'));
}

/**
 * 业务错误码 → HTTP。
 *
 * 409 与 400 的分界不是「严重程度」，而是「重试有没有用」：
 * 额度不够、状态已变、版本过期都是刷新后再试可能成功的冲突；
 * 行 id 对不上、金额非法、意见缺失则是这次请求本身写错了，重试一万次也一样。
 */
function mutationError(errorCode: FinanceApplicationMutationError) {
  switch (errorCode) {
    case 'NOT_FOUND':
    case 'ORDER_NOT_FOUND':
      return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Finance application not found');
    case 'VERSION_CONFLICT':
      return new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The application was decided by another user',
      );
    case 'APPLICATION_STATE_CONFLICT':
      return new ApiHttpError(
        409,
        ERROR_CODES.FINANCE_APPLICATION_STATE_CONFLICT,
        'The application is no longer waiting for a decision',
      );
    case 'AMOUNT_EXCEEDS_AVAILABLE':
      return new ApiHttpError(
        409,
        ERROR_CODES.FINANCE_AMOUNT_EXCEEDS_AVAILABLE,
        'The amount exceeds the remaining balance on this line',
      );
    case 'SELF_APPROVAL_FORBIDDEN':
      return new ApiHttpError(
        403,
        ERROR_CODES.FINANCE_SELF_APPROVAL_FORBIDDEN,
        'The creator cannot approve their own application',
      );
    case 'ORDER_STATE_CONFLICT':
      return new ApiHttpError(
        409,
        ERROR_CODES.ORDER_STATE_CONFLICT,
        'The order status does not allow this action',
      );
    case 'FORBIDDEN':
      return new ApiHttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'This step requires a higher role than yours',
      );
    case 'REASON_REQUIRED':
      return new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'A reason is required for this action',
      );
    case 'LINE_NOT_FOUND':
      return new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The amount line does not belong to this order',
      );
    case 'AMOUNT_INVALID':
    case 'KIND_INVALID':
    case 'ACTION_INVALID':
      return new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The request does not match the application rules',
      );
  }
}

/** 库函数抛出的权限拒绝（42501）不能在应用层变成 500。 */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof FinanceApplicationForbiddenError) {
      throw new ApiHttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'This step requires a higher role than yours',
      );
    }
    throw cause;
  }
}

financeApplicationRoutes.get(
  ROUTES.listFinanceApplications.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const query = parseQuery(context, financeApplicationListQuerySchema);
    const page = await repository(context).list({
      organizationId: context.get('auth').organizationId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.orderId ? { orderId: query.orderId } : {}),
      ...(query.keyword ? { keyword: query.keyword } : {}),
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      order: query.order,
    });
    return respond(context, 'listFinanceApplications', {
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

financeApplicationRoutes.post(
  ROUTES.createFinanceApplication.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const body = await parseJson(context, createFinanceApplicationRequestSchema);
    const result = await run(() =>
      repository(context).create(context.get('auth').organizationId, {
        kind: body.kind,
        orderId: body.orderId,
        lineId: body.lineId,
        amount: body.amount,
        method: body.method,
        occurredOn: body.occurredOn,
        ...(body.referenceNo ? { referenceNo: body.referenceNo } : {}),
        ...(body.voucherUrl ? { voucherUrl: body.voucherUrl } : {}),
        ...(body.remark ? { remark: body.remark } : {}),
      }),
    );
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'createFinanceApplication', { application: result.application }, 201);
  },
);

financeApplicationRoutes.get(
  ROUTES.getFinanceApplication.path,
  requireAuth(),
  requirePermission(PERMISSIONS.ORDER_READ),
  async (context) => {
    const { applicationId } = parseParams(context, financeApplicationParamsSchema);
    const detail = await repository(context).findDetail(
      context.get('auth').organizationId,
      applicationId,
    );
    if (!detail)
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'Finance application not found');
    return respond(context, 'getFinanceApplication', detail);
  },
);

financeApplicationRoutes.patch(
  ROUTES.decideFinanceApplication.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_APPROVE),
  async (context) => {
    const { applicationId } = parseParams(context, financeApplicationParamsSchema);
    const body = await parseJson(context, decideFinanceApplicationRequestSchema);
    const result = await run(() =>
      repository(context).decide(
        context.get('auth').organizationId,
        applicationId,
        body.action,
        body.opinion,
        body.version,
      ),
    );
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'decideFinanceApplication', { application: result.application });
  },
);

financeApplicationRoutes.post(
  ROUTES.withdrawFinanceApplication.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (context) => {
    const { applicationId } = parseParams(context, financeApplicationParamsSchema);
    const body = await parseJson(context, financeApplicationReasonRequestSchema);
    const result = await run(() =>
      repository(context).withdraw(
        context.get('auth').organizationId,
        applicationId,
        body.reason,
        body.version,
      ),
    );
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'withdrawFinanceApplication', { application: result.application });
  },
);

financeApplicationRoutes.post(
  ROUTES.undoFinanceApplication.path,
  requireAuth(),
  requirePermission(PERMISSIONS.FINANCE_APPROVE),
  async (context) => {
    const { applicationId } = parseParams(context, financeApplicationParamsSchema);
    const body = await parseJson(context, financeApplicationReasonRequestSchema);
    const result = await run(() =>
      repository(context).undo(
        context.get('auth').organizationId,
        applicationId,
        body.reason,
        body.version,
      ),
    );
    if (!result.ok) throw mutationError(result.errorCode);
    return respond(context, 'undoFinanceApplication', { application: result.application });
  },
);
