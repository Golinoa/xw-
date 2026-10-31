import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsReceiptAllocationCreateRequestSchema,
  opsReceiptAllocationReverseRequestSchema,
  opsReceiptCreateRequestSchema,
  opsReceiptListQuerySchema,
  opsReceiptReverseRequestSchema,
  opsReceiptTransitionRequestSchema,
  opsRefundCreateRequestSchema,
  opsRefundListQuerySchema,
  opsRefundTransitionRequestSchema,
  type OpsReceiptListQuery,
  type OpsRefundListQuery,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import { toReceivable } from '../receivables/protocol';
import {
  receiptAllocationCreateEnvelopeSchema,
  receiptAllocationReverseEnvelopeSchema,
  receiptCreateEnvelopeSchema,
  receiptDetailEnvelopeSchema,
  receiptListEnvelopeSchema,
  receiptReverseEnvelopeSchema,
  receiptTransitionEnvelopeSchema,
  refundCreateEnvelopeSchema,
  refundListEnvelopeSchema,
  refundTransitionEnvelopeSchema,
  toDuplicateWarning,
  toReceipt,
  toRefund,
} from './protocol';
import { toBillingAllocation, toBillingReversal } from '../receivables/protocol';

export const opsReceiptRoutes = new Hono<ApiEnvironment>();

/**
 * 收款域（契约 §5.5 的后十个端点：收款、核销、退款）。
 *
 * 四件照抄应收域会错的地方：
 *
 * 1. **七个写端点全部要幂等键。** 契约那张表的「幂等」列里，本域只有三个 GET
 *    是「—」。全局幂等中间件对没带 key 的请求直接放行（它的职责是「带了就回放」），
 *    所以缺键必须由 handler 自己拒——漏带时核销会被执行两次，第二次撞
 *    `RECEIPT_EXCEEDED`，用户看到的是「超额」，实际原因是重复提交。
 *
 * 2. **职责分离是 403 不是 409。** 登记人自审被挡时，换个人点同一个按钮就通了，
 *    所以它是「人不允许」而不是「状态不允许」。契约 §6.4 明确要求
 *    `details.rule='SEGREGATION_OF_DUTY'`，前端按 `rule` 提示「请让另一个人审核」；
 *    给 409 + `INVALID_TRANSITION` 会让界面显示「这笔单子状态不对」。
 *
 * 3. **金额类冲突是 409 `STATE_CONFLICT` 不是 422。** 契约 §6.3 的设计说明：
 *    超额核销、超退由并发/余额不变量触发，语义是「当前状态不允许」，前端已有
 *    409 分支。四个 reason 各自带可以渲染的上限（`allocatable` / `outstanding` /
 *    `reversible` / `refundable`），不拼进 message。
 *
 * 4. **`status` 筛选是数组。** `context.req.query()` 只取重复键的最后一个值，
 *    照抄单值解析会把多选静默变成「只筛最后一个」，症状是筛选看着生效、条数总
 *    比预期少。
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
    }
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The billing directory is unavailable',
      { requestId },
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // 出站形状违约必须是 503 + 一条结构化日志：这不是调用方的错，把它报成 400
    // 会让前端以为是自己发错了字段，而真正要改的是服务端。
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

/** 契约 §5.5 标注「必填」的七个写端点都要判；缺键的拒绝只能由 handler 做。 */
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

/** 400 + `{reason}`：契约 §6.4 的 `details.reason` 词表在这里落地。 */
function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The receipt request was rejected', {
    reason,
    ...details,
  });
}

/** 409 `STATE_CONFLICT` + `{reason, allowedActions?}`。 */
function stateConflict(
  reason: string,
  details: Record<string, unknown> = {},
  allowedActions?: string[],
): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.STATE_CONFLICT, 'The receipt state does not allow it', {
    reason,
    ...(allowedActions && allowedActions.length > 0 ? { allowedActions } : {}),
    ...details,
  });
}

/** 409 `CONFLICT`：唯一约束或乐观锁，与状态无关。 */
function conflict(details: Record<string, unknown>): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The value is already taken', details);
}

function notFound(resource: string): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `The ${resource} does not exist`, {
    resource,
  });
}

/**
 * 列表查询解析。
 *
 * `status` 走 `queries()`（多选）；其余直接交给 schema。日期与 `methodCode`
 * 是普通单值参数，不需要特殊处理。
 */
function parseListQuery<T>(context: Context<ApiEnvironment>, schema: z.ZodType<T>): T {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;

  const parsed = schema.safeParse(raw);
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

/** `GET /api/v1/ops/receipts` */
opsReceiptRoutes.get(OPS_ROUTES.listOpsReceipts.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const query = parseListQuery<OpsReceiptListQuery>(context, opsReceiptListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_receipts',
    {
      p_customer_id: query.customerId ?? null,
      p_contract_id: query.contractId ?? null,
      p_statuses: query.status ?? null,
      p_method_code: query.methodCode ?? null,
      p_date_from: query.dateFrom ?? null,
      p_date_to: query.dateTo ?? null,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    receiptListEnvelopeSchema,
  );

  return respond(context, 'listOpsReceipts', {
    items: result.items.map(toReceipt),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/** `POST /api/v1/ops/receipts` */
opsReceiptRoutes.post(OPS_ROUTES.createOpsReceipt.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receipt.record');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsReceiptCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'record_receipt',
    {
      p_customer_id: body.customerId,
      p_contract_id: body.contractId ?? null,
      p_transaction_date: body.transactionDate,
      p_amount: body.amount,
      p_currency: body.currency,
      p_method_code: body.methodCode,
      p_reference_no: body.referenceNo ?? null,
      p_voucher_ref: body.voucherRef ?? null,
      p_reason: body.reason,
    },
    receiptCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsReceipt',
      {
        receipt: toReceipt(result.receipt),
        duplicateWarnings: result.duplicate_warnings.map(toDuplicateWarning),
      },
      201,
    );
  }

  switch (result.status) {
    case 'customer_not_found':
      throw notFound('customer');
    case 'contract_not_found':
      throw notFound('contract');
    case 'customer_mismatch':
      throw rejected('CUSTOMER_MISMATCH', { contractCustomerId: result.contract_customer_id });
    case 'currency_mismatch':
      throw rejected('CURRENCY_MISMATCH', { contractCurrency: result.contract_currency });
    case 'currency_invalid':
      throw rejected('CURRENCY_INVALID', { field: 'currency' });
    case 'amount_invalid':
      throw rejected('AMOUNT_INVALID', { field: 'amount' });
    case 'amount_scale_invalid':
      throw rejected('AMOUNT_SCALE_INVALID', { field: 'amount' });
    case 'transaction_date_required':
      throw rejected('TRANSACTION_DATE_REQUIRED', { field: 'transactionDate' });
    case 'method_required':
      throw rejected('METHOD_REQUIRED', { field: 'methodCode' });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    case 'duplicate_reference':
      // 409 而不是 400：这笔钱已经在这本账上了，不是「输入格式不对」。
      throw conflict({ field: 'referenceNo' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/receipts/{receiptId}` */
opsReceiptRoutes.get(OPS_ROUTES.getOpsReceipt.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const params = parseParams(context, z.object({ receiptId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_receipt',
    { p_receipt_id: params.receiptId },
    receiptDetailEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'getOpsReceipt', {
      receipt: toReceipt(result.receipt),
      allocations: result.allocations.map((row) => toBillingAllocation(row)),
      reversals: result.reversals.map((row) => toBillingReversal(row)),
      refunds: result.refunds.map(toRefund),
    });
  }

  throw notFound('receipt');
});

/** `POST /api/v1/ops/receipts/{receiptId}/transition` */
opsReceiptRoutes.post(OPS_ROUTES.transitionOpsReceipt.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receipt.approve');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ receiptId: z.uuid() }));
  const body = await parseJson(context, opsReceiptTransitionRequestSchema);

  const result = await callOpsRpc(
    context,
    'transition_receipt',
    {
      p_receipt_id: params.receiptId,
      p_action: body.action,
      p_reason: body.reason ?? null,
      p_expected_version: body.version,
    },
    receiptTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsReceipt', { receipt: toReceipt(result.receipt) });
  }

  switch (result.status) {
    case 'receipt_not_found':
      throw notFound('receipt');
    case 'version_mismatch':
      throw conflict({ currentVersion: result.current_version });
    case 'segregation_of_duty':
      // 403 而不是 409（见设计要点 2）。`rule` 是契约 §6.4 定的键。
      throw new ApiHttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'The recorder cannot approve their own receipt',
        { rule: 'SEGREGATION_OF_DUTY' },
      );
    case 'invalid_transition':
      throw stateConflict(
        'INVALID_TRANSITION',
        { currentStatus: result.current_status },
        result.allowed_actions,
      );
    case 'invalid_action':
      throw rejected('INVALID_ACTION', { allowedActions: result.allowed_actions });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/receipts/{receiptId}/allocations` */
opsReceiptRoutes.post(
  OPS_ROUTES.createOpsReceiptAllocation.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'receipt.reconcile');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ receiptId: z.uuid() }));
    const body = await parseJson(context, opsReceiptAllocationCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'allocate_receipt',
      {
        p_receipt_id: params.receiptId,
        p_allocations: body.allocations.map((entry) => ({
          receivableId: entry.receivableId,
          amount: entry.amount,
        })),
        p_reason: body.reason ?? null,
      },
      receiptAllocationCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsReceiptAllocation',
        {
          receipt: toReceipt(result.receipt),
          receivablesSummary: result.receivables_summary.map(toReceivable),
        },
        201,
      );
    }

    switch (result.status) {
      case 'receipt_not_found':
        throw notFound('receipt');
      case 'receivable_not_found':
        throw notFound('receivable');
      case 'receipt_not_approved':
        throw stateConflict(
          'RECEIPT_NOT_APPROVED',
          { currentStatus: 'recorded' },
          result.allowed_actions,
        );
      case 'invalid_transition':
        throw stateConflict(
          'INVALID_TRANSITION',
          { currentStatus: result.current_status },
          result.allowed_actions,
        );
      case 'receipt_exceeded':
        throw stateConflict('RECEIPT_EXCEEDED', {
          requestedTotal: result.requested_total,
          allocatable: result.allocatable,
        });
      case 'receivable_exceeded':
        throw stateConflict('RECEIVABLE_EXCEEDED', {
          index: result.index,
          receivableId: result.receivable_id,
          outstanding: result.outstanding,
        });
      case 'customer_mismatch':
        throw rejected('CUSTOMER_MISMATCH', {
          index: result.index,
          receivableId: result.receivable_id,
        });
      case 'currency_mismatch':
        throw rejected('CURRENCY_MISMATCH', {
          index: result.index,
          receivableId: result.receivable_id,
          receivableCurrency: result.receivable_currency,
        });
      case 'duplicate_receivable':
        throw rejected('DUPLICATE_RECEIVABLE', {
          index: result.index,
          receivableId: result.receivable_id,
        });
      case 'allocations_required':
        throw rejected('ALLOCATIONS_REQUIRED', { field: 'allocations' });
      case 'allocation_invalid':
        throw rejected('ALLOCATION_INVALID', { index: result.index });
      case 'amount_scale_invalid':
        throw rejected('AMOUNT_SCALE_INVALID', { index: result.index });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/** `POST /api/v1/ops/receipts/{receiptId}/reverse` */
opsReceiptRoutes.post(OPS_ROUTES.reverseOpsReceipt.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receipt.reverse');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ receiptId: z.uuid() }));
  const body = await parseJson(context, opsReceiptReverseRequestSchema);

  const result = await callOpsRpc(
    context,
    'reverse_receipt',
    {
      p_receipt_id: params.receiptId,
      p_reason: body.reason,
      p_expected_version: body.version,
    },
    receiptReverseEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'reverseOpsReceipt', {
      receipt: toReceipt(result.receipt),
      reversal: { amount: result.reversal.amount },
    });
  }

  switch (result.status) {
    case 'receipt_not_found':
      throw notFound('receipt');
    case 'version_mismatch':
      throw conflict({ currentVersion: result.current_version });
    case 'has_allocations':
      // 有核销就必须先撤核销——这是契约 §6.4 明写的词。
      throw stateConflict('HAS_ALLOCATIONS', { allocatedAmount: result.allocated_amount });
    case 'invalid_transition':
      throw stateConflict(
        'INVALID_TRANSITION',
        { currentStatus: result.current_status },
        result.allowed_actions,
      );
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/receipt-allocations/{allocationId}/reverse` */
opsReceiptRoutes.post(
  OPS_ROUTES.reverseOpsReceiptAllocation.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'receipt.reverse');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ allocationId: z.uuid() }));
    const body = await parseJson(context, opsReceiptAllocationReverseRequestSchema);

    const result = await callOpsRpc(
      context,
      'reverse_allocation',
      {
        p_allocation_id: params.allocationId,
        p_amount: body.amount ?? null,
        p_reason: body.reason,
      },
      receiptAllocationReverseEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'reverseOpsReceiptAllocation', {
        allocation: {
          id: result.allocation.id,
          amount: result.allocation.amount,
          reversedAmount: result.allocation.reversed_amount,
        },
        receivable: toReceivable(result.receivable),
        receipt: toReceipt(result.receipt),
      });
    }

    switch (result.status) {
      case 'allocation_not_found':
        throw notFound('receipt allocation');
      case 'reversal_exceeded':
        throw stateConflict('REVERSAL_EXCEEDED', { reversible: result.reversible });
      case 'amount_invalid':
        throw rejected('AMOUNT_INVALID', { reversible: result.reversible });
      case 'amount_scale_invalid':
        throw rejected('AMOUNT_SCALE_INVALID', { field: 'amount' });
      case 'reason_required':
        throw rejected('REASON_REQUIRED', { field: 'reason' });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/** `GET /api/v1/ops/refunds` */
opsReceiptRoutes.get(OPS_ROUTES.listOpsRefunds.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const query = parseListQuery<OpsRefundListQuery>(context, opsRefundListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_refunds',
    {
      p_customer_id: query.customerId ?? null,
      p_statuses: query.status ?? null,
      p_date_from: query.dateFrom ?? null,
      p_date_to: query.dateTo ?? null,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    refundListEnvelopeSchema,
  );

  return respond(context, 'listOpsRefunds', {
    items: result.items.map(toRefund),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/** `POST /api/v1/ops/refunds` */
opsReceiptRoutes.post(OPS_ROUTES.createOpsRefund.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receipt.refund');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsRefundCreateRequestSchema);

  // `contractId` 收在入站 schema 里（契约 §5.5 列为可选），但 RPC 不接受它：
  // 退款必然挂在原收款上，合同从收款继承。传进来的值与收款不一致时不该静默
  // 丢弃——那是「用户以为在 A 合同上退款，实际记到了 B」的来源。
  if (body.contractId) {
    const detail = await callOpsRpc(
      context,
      'get_receipt',
      { p_receipt_id: body.receiptId },
      receiptDetailEnvelopeSchema,
    );
    if (detail.status !== 'ok') {
      throw notFound('receipt');
    }
    if (detail.receipt.contract_id !== body.contractId) {
      throw rejected('CONTRACT_MISMATCH', {
        field: 'contractId',
        receiptContractId: detail.receipt.contract_id,
      });
    }
  }

  const result = await callOpsRpc(
    context,
    'record_refund',
    {
      p_receipt_id: body.receiptId,
      p_amount: body.amount,
      p_refund_date: body.refundDate,
      p_reason: body.reason,
      p_external_voucher_ref: body.externalVoucherRef ?? null,
    },
    refundCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'createOpsRefund', { refund: toRefund(result.refund) }, 201);
  }

  switch (result.status) {
    case 'receipt_not_found':
      throw notFound('receipt');
    case 'refund_exceeded':
      // 409 而不是 400：可退额是「已核销净额 - 未取消退款」这个动态值，
      // 不是入参错了（契约 §6.3 的设计说明）。
      throw stateConflict('REFUND_EXCEEDED', {
        requestedAmount: result.requested_amount,
        refundable: result.refundable,
      });
    case 'refund_date_required':
      throw rejected('REFUND_DATE_REQUIRED', { field: 'refundDate' });
    case 'amount_invalid':
      throw rejected('AMOUNT_INVALID', { field: 'amount' });
    case 'amount_scale_invalid':
      throw rejected('AMOUNT_SCALE_INVALID', { field: 'amount' });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `POST /api/v1/ops/refunds/{refundId}/transition` */
opsReceiptRoutes.post(OPS_ROUTES.transitionOpsRefund.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receipt.refund');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ refundId: z.uuid() }));
  const body = await parseJson(context, opsRefundTransitionRequestSchema);

  const result = await callOpsRpc(
    context,
    'transition_refund',
    {
      p_refund_id: params.refundId,
      p_action: body.action,
      p_reason: body.reason,
    },
    refundTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsRefund', {
      refund: toRefund(result.refund),
      receipt: toReceipt(result.receipt),
    });
  }

  switch (result.status) {
    case 'refund_not_found':
      throw notFound('refund');
    case 'invalid_transition':
      throw stateConflict(
        'INVALID_TRANSITION',
        { currentStatus: result.current_status },
        result.allowed_actions,
      );
    case 'invalid_action':
      throw rejected('INVALID_ACTION', { allowedActions: result.allowed_actions });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});
