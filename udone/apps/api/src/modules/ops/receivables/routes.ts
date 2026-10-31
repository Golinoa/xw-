import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsReceivableExtensionCreateRequestSchema,
  opsReceivableListQuerySchema,
  opsReceivablePlanCreateRequestSchema,
  type OpsReceivableListQuery,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  receivableDetailEnvelopeSchema,
  receivableExtensionCreateEnvelopeSchema,
  receivableListEnvelopeSchema,
  receivablePlanCreateEnvelopeSchema,
  toBillingAllocation,
  toBillingReversal,
  toReceivable,
  toReceivableExtension,
} from './protocol';

export const opsReceivableRoutes = new Hono<ApiEnvironment>();

/**
 * 应收域（契约 §5.5 的前四个端点）。
 *
 * 三件照抄合同域会错的地方：
 *
 * 1. **`POST /receivables` 与展期都要幂等键**。§5.5 的幂等列里，本域四个端点
 *    只有两个 GET 是「—」。全局幂等中间件对「没带 key」的请求直接放行（它的
 *    职责是「带了就回放」），所以缺键必须由 handler 自己拒——否则客户端漏带时，
 *    生成计划会被悄悄执行两次，第二次撞 `plan_exists`，用户看到的是「计划已存在」，
 *    而实际原因是重复提交。
 *
 * 2. **排序参数是 `sort` + `order`，不是 `direction`**。契约 §5.5 只写了白名单
 *    `dueDate/amount`，没规定参数名；项目分页约定（`pagination.ts`）是
 *    `page`/`pageSize`/`sort`/`order`，同一份契约里不该有两套分页拼写。
 *
 * 3. **状态筛选是数组**（`status=overdue&status=partial`），`context.req.query()`
 *    只取最后一个值。照抄单值解析会把「多选」静默变成「只筛最后一个」——症状是
 *    筛选看起来生效、条数却总比预期少。
 */
async function callOpsRpc<S extends z.ZodType>(
  context: Context<ApiEnvironment>,
  name: string,
  body: Record<string, unknown>,
  schema: S,
): Promise<z.output<S>> {
  const client = createRestClient(context.env, context.get('opsToken'));

  let payload: unknown;
  try {
    payload = await client.rest<unknown>(`rpc/${name}`, { method: 'POST', body, profile: 'ops' });
  } catch (cause) {
    const requestId = context.get('requestId');
    if (cause instanceof RestConflictError) {
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The billing directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The billing directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The billing directory rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The billing directory is unavailable',
      );
    }
    throw cause;
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'ops_rpc_shape_invalid',
        rpc: name,
        requestId: context.get('requestId'),
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }),
    );
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The billing directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** 契约 §5.5 标注「必填」的两个写端点都要判；缺键的拒绝只能由 handler 做。 */
function requireIdempotencyKey(context: Context<ApiEnvironment>): void {
  if (!context.req.header('Idempotency-Key')) {
    throw new ApiHttpError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'The Idempotency-Key header is required for this endpoint',
      { field: 'Idempotency-Key' },
    );
  }
}

function missing(): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The receivable does not exist', {
    resource: 'receivable',
  });
}

/** 400 + `{reason}`：契约 §6.4 的 `details.reason` 词表在这里落地。 */
function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    'The receivable request was rejected',
    {
      reason,
      ...details,
    },
  );
}

/**
 * 409 `STATE_CONFLICT` + `{reason}`。
 *
 * `CONTRACT_NOT_ACTIVE` 与 `PLAN_EXISTS`、`RECEIVABLE_SETTLED` 都用它，但 reason
 * 不同：前端据此决定是「先去把合同生效」还是「这份计划已经存在」还是「这期已经
 * 收满了」。三个都回同一句「状态冲突」等于把判断推给用户。
 */
function stateConflict(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(
    409,
    ERROR_CODES.STATE_CONFLICT,
    'The receivable state does not allow it',
    {
      reason,
      ...details,
    },
  );
}

/**
 * 列表查询解析。
 *
 * `status` 走 `queries()`：`req.query()` 对重复键只返回最后一个值，而契约 §5.5
 * 的 `status[]` 是多选。`overdueOnly` 是布尔串（`'true'`/`'false'`），交给
 * `z.coerce.boolean()` 会得到「任何非空字符串都是 true」——包括 `'false'`。
 * 所以这里显式判两个值，其余交给 400。
 */
function parseReceivableListQuery(context: Context<ApiEnvironment>): OpsReceivableListQuery {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;

  const overdueOnly = raw.overdueOnly;
  if (overdueOnly === 'true' || overdueOnly === '1') raw.overdueOnly = true;
  else if (overdueOnly === 'false' || overdueOnly === '0') raw.overdueOnly = false;
  else if (overdueOnly === undefined || overdueOnly === '') delete raw.overdueOnly;

  const parsed = opsReceivableListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The query parameters are invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

/** `GET /api/v1/ops/receivables` */
opsReceivableRoutes.get(OPS_ROUTES.listOpsReceivables.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const query = parseReceivableListQuery(context);

  const result = await callOpsRpc(
    context,
    'list_receivables',
    {
      p_customer_id: query.customerId ?? null,
      p_contract_id: query.contractId ?? null,
      p_statuses: query.status ?? null,
      p_due_from: query.dueFrom ?? null,
      p_due_to: query.dueTo ?? null,
      p_overdue_only: query.overdueOnly ?? false,
      // RPC 认 snake_case 白名单值；契约面是 camelCase（`dueDate`）。
      p_sort: query.sort === 'dueDate' ? 'due_date' : 'amount',
      p_sort_desc: query.order === 'desc',
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    receivableListEnvelopeSchema,
  );

  return respond(context, 'listOpsReceivables', {
    items: result.items.map(toReceivable),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      totalAmount: result.summary.total_amount,
      settledAmount: result.summary.settled_amount,
      outstandingAmount: result.summary.outstanding_amount,
      overdueAmount: result.summary.overdue_amount,
    },
  });
});

/** `POST /api/v1/ops/receivables` */
opsReceivableRoutes.post(
  OPS_ROUTES.createOpsReceivablePlan.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'receivable.write');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsReceivablePlanCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_receivable_plan',
      {
        p_contract_id: body.contractId,
        p_periods: body.periods.map((period) => ({
          dueDate: period.dueDate,
          amount: period.amount,
          ...(period.note ? { note: period.note } : {}),
        })),
      },
      receivablePlanCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsReceivablePlan',
        { items: result.items.map(toReceivable) },
        201,
      );
    }

    switch (result.status) {
      case 'contract_not_found':
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The contract does not exist', {
          resource: 'contract',
        });
      case 'contract_not_active':
        throw stateConflict('CONTRACT_NOT_ACTIVE', { contractStatus: result.contract_status });
      case 'periods_required':
        throw rejected('PERIODS_REQUIRED', { field: 'periods' });
      case 'plan_exists':
        throw stateConflict('PLAN_EXISTS');
      case 'due_date_required':
        throw rejected('DUE_DATE_REQUIRED', { periodNo: result.period_no });
      case 'amount_invalid':
        throw rejected('AMOUNT_INVALID', { periodNo: result.period_no });
      case 'amount_scale_invalid':
        throw rejected('AMOUNT_SCALE_INVALID', { periodNo: result.period_no });
      case 'plan_total_mismatch':
        // 契约 §6.4 定死了这个 reason 拼写：前端按它定位「合计不符」这一支。
        throw rejected('PLAN_TOTAL_MISMATCH', {
          plannedTotal: result.planned_total,
          contractTotal: result.contract_total,
        });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/** `GET /api/v1/ops/receivables/{receivableId}` */
opsReceivableRoutes.get(OPS_ROUTES.getOpsReceivable.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const params = parseParams(context, z.object({ receivableId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_receivable',
    { p_receivable_id: params.receivableId },
    receivableDetailEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'getOpsReceivable', {
      receivable: toReceivable(result.receivable),
      allocations: result.allocations.map((row) => toBillingAllocation(row)),
      extensions: result.extensions.map(toReceivableExtension),
      reversals: result.reversals.map((row) => toBillingReversal(row)),
    });
  }

  throw missing();
});

/** `POST /api/v1/ops/receivables/{receivableId}/extensions` */
opsReceivableRoutes.post(
  OPS_ROUTES.createOpsReceivableExtension.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'receivable.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ receivableId: z.uuid() }));
    const body = await parseJson(context, opsReceivableExtensionCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'extend_receivable',
      {
        p_receivable_id: params.receivableId,
        p_new_due_date: body.newDueDate,
        p_reason: body.reason,
        p_expected_version: body.version,
      },
      receivableExtensionCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'createOpsReceivableExtension', {
        receivable: toReceivable(result.receivable),
        extension: toReceivableExtension(result.extension),
      });
    }

    switch (result.status) {
      case 'receivable_not_found':
        throw missing();
      case 'version_mismatch':
        // 与合同域的 versionConflict 同一个理由：把刷新后要展示的版本带给前端。
        throw new ApiHttpError(
          409,
          ERROR_CODES.CONFLICT,
          'The receivable was modified by someone else',
          { currentVersion: result.current_version },
        );
      case 'reason_required':
        throw rejected('REASON_REQUIRED', { field: 'reason' });
      case 'receivable_settled':
        throw stateConflict('RECEIVABLE_SETTLED', {
          allocatedAmount: result.allocated_amount,
          reversedAmount: result.reversed_amount,
        });
      case 'invalid_due_date':
        throw rejected('INVALID_DUE_DATE', { currentDueDate: result.current_due_date });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);
