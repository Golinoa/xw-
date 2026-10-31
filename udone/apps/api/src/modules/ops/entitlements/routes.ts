import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsChangeRequestCreateRequestSchema,
  opsChangeRequestListQuerySchema,
  opsChangeRequestTransitionRequestSchema,
  opsLicenseCreateRequestSchema,
  opsLicenseListQuerySchema,
  opsSnapshotListQuerySchema,
  opsSubjectTransitionRequestSchema,
  opsSubscriptionCreateRequestSchema,
  opsSubscriptionListQuerySchema,
  type OpsChangeRequestListQuery,
  type OpsLicenseListQuery,
  type OpsSnapshotListQuery,
  type OpsSubscriptionListQuery,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  changeRequestCreateEnvelopeSchema,
  changeRequestDetailEnvelopeSchema,
  changeRequestListEnvelopeSchema,
  changeRequestTransitionEnvelopeSchema,
  licenseCreateEnvelopeSchema,
  licenseDetailEnvelopeSchema,
  licenseListEnvelopeSchema,
  licenseTransitionEnvelopeSchema,
  snapshotDetailEnvelopeSchema,
  snapshotListEnvelopeSchema,
  subscriptionCreateEnvelopeSchema,
  subscriptionDetailEnvelopeSchema,
  subscriptionListEnvelopeSchema,
  subscriptionTransitionEnvelopeSchema,
  toChangeRequest,
  toDiff,
  toLicense,
  toSnapshot,
  toSnapshotDetail,
  toSnapshotLine,
  toSubscription,
} from './protocol';

export const opsEntitlementRoutes = new Hono<ApiEnvironment>();

/**
 * entitlement 域（契约 §5.6 的十五条端点：订阅、授权、变更申请、快照）。
 *
 * 四件这个域特有、照抄别的域会错的地方：
 *
 * 1. **`transition` 的权限按 `action` 判，不按端点判。** 一个端点三种权限：
 *    `submit` → `entitlement.request`、`approve`/`reject` → `entitlement.approve`、
 *    其余 → `entitlement.execute`。端点级只固定判一个权限的话，`approve` 会被
 *    `entitlement.request` 挡成 403（看着像「没权限」），而 `submit` 又能被
 *    `entitlement.execute` 放行（看着像「有权限」）——两种错都不会报错，只会
 *    在真实分权时才浮现。
 *
 * 2. **`suspend`/`resume`/`revoke` 返回 202 但 `command` 是 null。**
 *    契约 §5.6 要求这三个动作下发租户命令并回 `command{id,status}`，而命令表
 *    （`tenant_commands`）属 o-t10。状态确实变了、租户侧还没同步，这正是 202
 *    的含义。不伪造 id，也不改成 200——后者会让 o-t10 落地时变成一次破坏性
 *    变更（前端已经按 200 写了分支）。
 *
 * 3. **`approval_required` 是 409 而不是 400。** 契约 §3.5 明写
 *    409 `STATE_CONFLICT` + `details.reason='APPROVAL_REQUIRED'`。这与
 *    `invalid_transition` 的分工是：前者让用户去催审批，后者说明按钮点错了。
 *    两者都给 `allowedActions`（后者），前端才能画出「现在能点哪些」。
 *
 * 4. **`segregation_of_duty` 是 403。** 申请人自批被挡时，换个人点同一个按钮
 *    就通了，所以它是「人不允许」而不是「状态不允许」——与收款域同款。
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
        'The entitlement directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The entitlement directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The entitlement directory rejected the request',
        );
      }
    }
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The entitlement directory is unavailable',
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
      'The entitlement directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** 契约 §5.6 标注「必填」的七个写端点都要判；缺键的拒绝只能由 handler 做。 */
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
  return new ApiHttpError(
    400,
    ERROR_CODES.VALIDATION_ERROR,
    'The entitlement request was rejected',
    {
      reason,
      ...details,
    },
  );
}

/** 409 `STATE_CONFLICT` + `{reason, allowedActions?}`。 */
function stateConflict(
  reason: string,
  details: Record<string, unknown> = {},
  allowedActions?: string[],
): ApiHttpError {
  return new ApiHttpError(
    409,
    ERROR_CODES.STATE_CONFLICT,
    'The entitlement state does not allow it',
    {
      reason,
      ...(allowedActions && allowedActions.length > 0 ? { allowedActions } : {}),
      ...details,
    },
  );
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

/**
 * 权益行校验失败的统一映射。
 *
 * 每个分支都带 `featureKey`——表单要把具体的输入框标红，只给一句话是定位不到
 * 哪一行的。`feature_duplicate` 例外（没有单一的 key 可指），改为把整段提示
 * 留给前端自己组织。
 */
function featureFailure(
  result:
    | { status: 'feature_unknown'; feature_key: string }
    | { status: 'feature_duplicate' }
    | { status: 'feature_key_required' }
    | { status: 'feature_invalid'; feature_key: string },
): ApiHttpError {
  switch (result.status) {
    case 'feature_unknown':
      return rejected('FEATURE_UNKNOWN', { featureKey: result.feature_key });
    case 'feature_duplicate':
      return rejected('FEATURE_DUPLICATE');
    case 'feature_key_required':
      return rejected('FEATURE_KEY_REQUIRED', { field: 'features[].featureKey' });
    case 'feature_invalid':
      return rejected('FEATURE_INVALID', { featureKey: result.feature_key });
  }
}

/** 迁移动作 → 权限码（契约 §5.6 的「按 action 映射」）。 */
const SUBJECT_ACTION_PERMISSIONS = {
  submit: 'entitlement.request',
  approve: 'entitlement.approve',
  reject: 'entitlement.approve',
  suspend: 'entitlement.execute',
  resume: 'entitlement.execute',
  revoke: 'entitlement.execute',
  mark_expired: 'entitlement.execute',
} as const;

/** 变更单动作 → 权限码。`cancel` 是「request 或 approve 之一」，由库里判。 */
const CHANGE_REQUEST_ACTION_PERMISSIONS = {
  submit: 'entitlement.request',
  approve: 'entitlement.approve',
  reject: 'entitlement.approve',
  execute: 'entitlement.execute',
  retry: 'entitlement.execute',
  cancel: 'entitlement.request',
} as const;

/** `suspend` / `resume` / `revoke` 会下发租户命令，所以是 202。 */
const COMMAND_ACTIONS = new Set<string>(['suspend', 'resume', 'revoke']);

function subjectTransitionFailure(
  result:
    | { status: 'subscription_not_found' }
    | { status: 'license_not_found' }
    | { status: 'invalid_subject_type' }
    | { status: 'invalid_action' }
    | { status: 'version_mismatch'; current_version: number }
    | { status: 'approval_required'; current_status: string }
    | { status: 'invalid_transition'; current_status: string; allowed_actions: string[] }
    | { status: 'reason_required' }
    | { status: 'snapshot_required' }
    | { status: 'not_expired'; expiry_date: string | null },
  subjectType: 'subscription' | 'license',
): ApiHttpError {
  switch (result.status) {
    case 'subscription_not_found':
    case 'license_not_found':
      return notFound(subjectType);
    case 'invalid_subject_type':
    case 'invalid_action':
      return rejected(
        result.status === 'invalid_action' ? 'INVALID_ACTION' : 'INVALID_SUBJECT_TYPE',
      );
    case 'version_mismatch':
      return conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
    case 'approval_required':
      return stateConflict('APPROVAL_REQUIRED', { currentStatus: result.current_status });
    case 'invalid_transition':
      return stateConflict(
        'INVALID_TRANSITION',
        { currentStatus: result.current_status },
        result.allowed_actions,
      );
    case 'reason_required':
      return rejected('REASON_REQUIRED', { field: 'reason' });
    case 'snapshot_required':
      return stateConflict('SNAPSHOT_REQUIRED');
    case 'not_expired':
      return stateConflict('NOT_EXPIRED', { expiryDate: result.expiry_date });
  }
}

/** `GET /api/v1/ops/subscriptions` */
opsEntitlementRoutes.get(
  OPS_ROUTES.listOpsSubscriptions.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.read');
    const query = parseListQuery<OpsSubscriptionListQuery>(context, opsSubscriptionListQuerySchema);

    const result = await callOpsRpc(
      context,
      'list_subscriptions',
      {
        p_customer_id: query.customerId ?? null,
        p_statuses: query.status ?? null,
        p_product_id: query.productId ?? null,
        p_expiring_in_days: query.expiringInDays ?? null,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      subscriptionListEnvelopeSchema,
    );

    return respond(context, 'listOpsSubscriptions', {
      items: result.items.map(toSubscription),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

/** `POST /api/v1/ops/subscriptions` */
opsEntitlementRoutes.post(
  OPS_ROUTES.createOpsSubscription.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.request');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsSubscriptionCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_subscription',
      {
        p_customer_id: body.customerId,
        p_contract_item_id: body.contractItemId,
        p_billing_cycle: body.billingCycle,
        p_starts_on: body.startsOn,
        p_ends_on: body.endsOn ?? null,
        p_auto_renew_intent: body.autoRenewIntent ?? false,
        p_features: body.features ?? null,
        p_reason: body.reason ?? null,
      },
      subscriptionCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsSubscription',
        {
          subscription: toSubscription(result.subscription),
          snapshot: result.snapshot ? toSnapshot(result.snapshot) : null,
        },
        201,
      );
    }

    switch (result.status) {
      case 'contract_item_not_found':
        throw notFound('contractItem');
      case 'customer_mismatch':
        throw rejected('CUSTOMER_MISMATCH', { contractCustomerId: result.contract_customer_id });
      case 'contract_not_active':
        throw stateConflict('CONTRACT_NOT_ACTIVE', { contractStatus: result.contract_status });
      case 'sales_mode_mismatch':
        throw rejected('SALES_MODE_MISMATCH', { salesMode: result.sales_mode });
      case 'invalid_billing_cycle':
        throw rejected('INVALID_BILLING_CYCLE', { field: 'billingCycle' });
      case 'start_date_required':
        throw rejected('START_DATE_REQUIRED', { field: 'startsOn' });
      case 'invalid_period':
        throw rejected('INVALID_PERIOD', { field: 'endsOn' });
      case 'duplicate_subscription':
        throw conflict({ reason: 'DUPLICATE_SUBSCRIPTION' });
      default:
        throw featureFailure(result);
    }
  },
);

/** `GET /api/v1/ops/subscriptions/:subscriptionId` */
opsEntitlementRoutes.get(OPS_ROUTES.getOpsSubscription.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'entitlement.read');
  const params = parseParams(context, z.object({ subscriptionId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_subscription',
    { p_subscription_id: params.subscriptionId },
    subscriptionDetailEnvelopeSchema,
  );

  if (result.status !== 'ok') {
    throw notFound('subscription');
  }

  return respond(context, 'getOpsSubscription', {
    subscription: toSubscription(result.subscription),
    snapshot: result.snapshot ? toSnapshotDetail(result.snapshot) : null,
    changeRequests: result.change_requests.map(toChangeRequest),
    tenantMapping: null,
  });
});

/** `POST /api/v1/ops/subscriptions/:subscriptionId/change-requests` */
opsEntitlementRoutes.post(
  OPS_ROUTES.createOpsSubscriptionChangeRequest.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.request');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ subscriptionId: z.uuid() }));
    const body = await parseJson(context, opsChangeRequestCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_entitlement_change_request',
      {
        p_subject_type: 'subscription',
        p_subject_id: params.subscriptionId,
        p_change_type: body.changeType,
        p_reason: body.reason,
        p_proposed_features: body.proposedFeatures ?? null,
        p_effective_on: body.effectiveOn ?? null,
      },
      changeRequestCreateEnvelopeSchema,
    );

    return respondToChangeRequestCreate(
      context,
      'createOpsSubscriptionChangeRequest',
      result,
      'subscription',
    );
  },
);

/** `POST /api/v1/ops/subscriptions/:subscriptionId/transition` */
opsEntitlementRoutes.post(
  OPS_ROUTES.transitionOpsSubscription.path,
  requireOpsAuth(),
  async (context) => {
    const params = parseParams(context, z.object({ subscriptionId: z.uuid() }));
    const body = await parseJson(context, opsSubjectTransitionRequestSchema);
    requireOpsPermission(context, SUBJECT_ACTION_PERMISSIONS[body.action]);
    requireIdempotencyKey(context);

    const result = await callOpsRpc(
      context,
      'transition_entitlement_subject',
      {
        p_subject_type: 'subscription',
        p_subject_id: params.subscriptionId,
        p_action: body.action,
        p_reason: body.reason ?? null,
        p_expected_version: body.version ?? null,
      },
      subscriptionTransitionEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw subjectTransitionFailure(result, 'subscription');
    }

    return respond(
      context,
      'transitionOpsSubscription',
      { subscription: toSubscription(result.subscription), command: null },
      COMMAND_ACTIONS.has(body.action) ? 202 : 200,
    );
  },
);

/** `GET /api/v1/ops/licenses` */
opsEntitlementRoutes.get(OPS_ROUTES.listOpsLicenses.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'entitlement.read');
  const query = parseListQuery<OpsLicenseListQuery>(context, opsLicenseListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_licenses',
    {
      p_customer_id: query.customerId ?? null,
      p_statuses: query.status ?? null,
      p_expiring_in_days: query.expiringInDays ?? null,
      p_deployment_instance_id: query.deploymentInstanceId ?? null,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    licenseListEnvelopeSchema,
  );

  return respond(context, 'listOpsLicenses', {
    items: result.items.map(toLicense),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/** `POST /api/v1/ops/licenses` */
opsEntitlementRoutes.post(OPS_ROUTES.createOpsLicense.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'entitlement.request');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsLicenseCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_license',
    {
      p_customer_id: body.customerId,
      p_contract_item_id: body.contractItemId,
      p_deployment_instance_id: body.deploymentInstanceId ?? null,
      p_license_mode: body.licenseMode,
      p_valid_from: body.validFrom,
      p_valid_to: body.validTo ?? null,
      p_maintenance_until: body.maintenanceUntil ?? null,
      p_features: body.features ?? null,
      p_reason: body.reason ?? null,
    },
    licenseCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsLicense',
      {
        license: toLicense(result.license),
        snapshot: result.snapshot ? toSnapshot(result.snapshot) : null,
      },
      201,
    );
  }

  switch (result.status) {
    case 'contract_item_not_found':
      throw notFound('contractItem');
    case 'customer_mismatch':
      throw rejected('CUSTOMER_MISMATCH', { contractCustomerId: result.contract_customer_id });
    case 'contract_not_active':
      throw stateConflict('CONTRACT_NOT_ACTIVE', { contractStatus: result.contract_status });
    case 'sales_mode_mismatch':
      throw rejected('SALES_MODE_MISMATCH', { salesMode: result.sales_mode });
    case 'invalid_license_mode':
      throw rejected('INVALID_LICENSE_MODE', { field: 'licenseMode' });
    // T-09 的两条验收断言都是 400：永久授权带有效期、期限授权缺有效期。
    // 两个方向都要判，只判一边的话「term + 无 validTo」会一路走到表约束，
    // 前端拿到的是一句 23514。
    case 'perpetual_with_valid_to':
      throw rejected('PERPETUAL_WITH_VALID_TO', { field: 'validTo' });
    case 'term_requires_valid_to':
      throw rejected('TERM_REQUIRES_VALID_TO', { field: 'validTo' });
    case 'valid_from_required':
      throw rejected('VALID_FROM_REQUIRED', { field: 'validFrom' });
    case 'invalid_period':
      throw rejected('INVALID_PERIOD', { field: 'validTo' });
    case 'invalid_maintenance_period':
      throw rejected('INVALID_MAINTENANCE_PERIOD', { field: 'maintenanceUntil' });
    case 'duplicate_license':
      throw conflict({ reason: 'DUPLICATE_LICENSE' });
    default:
      throw featureFailure(result);
  }
});

/** `GET /api/v1/ops/licenses/:licenseId` */
opsEntitlementRoutes.get(OPS_ROUTES.getOpsLicense.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'entitlement.read');
  const params = parseParams(context, z.object({ licenseId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_license',
    { p_license_id: params.licenseId },
    licenseDetailEnvelopeSchema,
  );

  if (result.status !== 'ok') {
    throw notFound('license');
  }

  return respond(context, 'getOpsLicense', {
    license: toLicense(result.license),
    snapshot: result.snapshot ? toSnapshotDetail(result.snapshot) : null,
    changeRequests: result.change_requests.map(toChangeRequest),
    deployment: null,
  });
});

/** `POST /api/v1/ops/licenses/:licenseId/change-requests` */
opsEntitlementRoutes.post(
  OPS_ROUTES.createOpsLicenseChangeRequest.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.request');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ licenseId: z.uuid() }));
    const body = await parseJson(context, opsChangeRequestCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_entitlement_change_request',
      {
        p_subject_type: 'license',
        p_subject_id: params.licenseId,
        p_change_type: body.changeType,
        p_reason: body.reason,
        p_proposed_features: body.proposedFeatures ?? null,
        p_effective_on: body.effectiveOn ?? null,
      },
      changeRequestCreateEnvelopeSchema,
    );

    return respondToChangeRequestCreate(
      context,
      'createOpsLicenseChangeRequest',
      result,
      'license',
    );
  },
);

/** `POST /api/v1/ops/licenses/:licenseId/transition` */
opsEntitlementRoutes.post(
  OPS_ROUTES.transitionOpsLicense.path,
  requireOpsAuth(),
  async (context) => {
    const params = parseParams(context, z.object({ licenseId: z.uuid() }));
    const body = await parseJson(context, opsSubjectTransitionRequestSchema);
    requireOpsPermission(context, SUBJECT_ACTION_PERMISSIONS[body.action]);
    requireIdempotencyKey(context);

    const result = await callOpsRpc(
      context,
      'transition_entitlement_subject',
      {
        p_subject_type: 'license',
        p_subject_id: params.licenseId,
        p_action: body.action,
        p_reason: body.reason ?? null,
        p_expected_version: body.version ?? null,
      },
      licenseTransitionEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw subjectTransitionFailure(result, 'license');
    }

    return respond(
      context,
      'transitionOpsLicense',
      { license: toLicense(result.license), command: null },
      COMMAND_ACTIONS.has(body.action) ? 202 : 200,
    );
  },
);

/** `GET /api/v1/ops/entitlement-change-requests` */
opsEntitlementRoutes.get(
  OPS_ROUTES.listOpsChangeRequests.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.read');
    const query = parseListQuery<OpsChangeRequestListQuery>(
      context,
      opsChangeRequestListQuerySchema,
    );

    const result = await callOpsRpc(
      context,
      'list_entitlement_change_requests',
      {
        p_subject_type: query.subjectType ?? null,
        p_statuses: query.status ?? null,
        p_customer_id: query.customerId ?? null,
        p_requested_by: query.requestedBy ?? null,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      changeRequestListEnvelopeSchema,
    );

    return respond(context, 'listOpsChangeRequests', {
      items: result.items.map(toChangeRequest),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

/** `GET /api/v1/ops/entitlement-change-requests/:changeRequestId` */
opsEntitlementRoutes.get(OPS_ROUTES.getOpsChangeRequest.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'entitlement.read');
  const params = parseParams(context, z.object({ changeRequestId: z.uuid() }));

  const result = await callOpsRpc(
    context,
    'get_entitlement_change_request',
    { p_change_request_id: params.changeRequestId },
    changeRequestDetailEnvelopeSchema,
  );

  if (result.status !== 'ok') {
    throw notFound('changeRequest');
  }

  return respond(context, 'getOpsChangeRequest', {
    changeRequest: toChangeRequest(result.change_request),
    diff: toDiff(result.diff),
    command: null,
  });
});

/** `POST /api/v1/ops/entitlement-change-requests/:changeRequestId/transition` */
opsEntitlementRoutes.post(
  OPS_ROUTES.transitionOpsChangeRequest.path,
  requireOpsAuth(),
  async (context) => {
    const params = parseParams(context, z.object({ changeRequestId: z.uuid() }));
    const body = await parseJson(context, opsChangeRequestTransitionRequestSchema);
    requireOpsPermission(context, CHANGE_REQUEST_ACTION_PERMISSIONS[body.action]);
    requireIdempotencyKey(context);

    const result = await callOpsRpc(
      context,
      'transition_entitlement_change_request',
      {
        p_change_request_id: params.changeRequestId,
        p_action: body.action,
        p_reason: body.reason ?? null,
        p_expected_version: body.version ?? null,
      },
      changeRequestTransitionEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      switch (result.status) {
        case 'change_request_not_found':
          throw notFound('changeRequest');
        case 'invalid_action':
          throw rejected('INVALID_ACTION');
        case 'version_mismatch':
          throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
        case 'approval_required':
          throw stateConflict('APPROVAL_REQUIRED', { currentStatus: result.current_status });
        case 'invalid_transition':
          throw stateConflict(
            'INVALID_TRANSITION',
            { currentStatus: result.current_status },
            result.allowed_actions,
          );
        case 'reason_required':
          throw rejected('REASON_REQUIRED', { field: 'reason' });
        case 'segregation_of_duty':
          // 换个人点同一个按钮就通了 —— 是「人不允许」，所以 403。
          throw new ApiHttpError(
            403,
            ERROR_CODES.FORBIDDEN,
            'The requester cannot approve their own change request',
            { reason: 'SEGREGATION_OF_DUTY', rule: 'SEGREGATION_OF_DUTY' },
          );
      }
    }

    return respond(
      context,
      'transitionOpsChangeRequest',
      {
        changeRequest: toChangeRequest(result.change_request),
        diff: toDiff(result.diff),
        command: null,
      },
      body.action === 'execute' ? 202 : 200,
    );
  },
);

/** `GET /api/v1/ops/entitlement-snapshots` */
opsEntitlementRoutes.get(
  OPS_ROUTES.listOpsEntitlementSnapshots.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.read');
    const query = parseListQuery<OpsSnapshotListQuery>(context, opsSnapshotListQuerySchema);

    const result = await callOpsRpc(
      context,
      'list_entitlement_snapshots',
      {
        p_subject_type: query.subjectType ?? null,
        p_subject_id: query.subjectId ?? null,
        p_valid_from_from: query.validFromFrom ?? null,
        p_valid_from_to: query.validFromTo ?? null,
        p_source_type: query.sourceType ?? null,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      snapshotListEnvelopeSchema,
    );

    return respond(context, 'listOpsEntitlementSnapshots', {
      items: result.items.map(toSnapshot),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

/** `GET /api/v1/ops/entitlement-snapshots/:snapshotId` */
opsEntitlementRoutes.get(
  OPS_ROUTES.getOpsEntitlementSnapshot.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.read');
    const params = parseParams(context, z.object({ snapshotId: z.uuid() }));

    const result = await callOpsRpc(
      context,
      'get_entitlement_snapshot',
      { p_snapshot_id: params.snapshotId },
      snapshotDetailEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw notFound('snapshot');
    }

    return respond(context, 'getOpsEntitlementSnapshot', {
      snapshot: toSnapshot(result.snapshot),
      lines: result.lines.map(toSnapshotLine),
    });
  },
);

/**
 * 建变更单的两个入口（订阅 / 授权）共用一段错误映射。
 *
 * 两个端点的请求体与返回完全一样，差别只在 `subjectType`；把映射写两遍的话，
 * 补一个 reason 词时必然只补一处。
 */
function respondToChangeRequestCreate(
  context: Context<ApiEnvironment>,
  route: 'createOpsSubscriptionChangeRequest' | 'createOpsLicenseChangeRequest',
  result: z.output<typeof changeRequestCreateEnvelopeSchema>,
  subjectType: 'subscription' | 'license',
): Response {
  if (result.status === 'ok') {
    return respond(
      context,
      route,
      { changeRequest: toChangeRequest(result.change_request), diff: toDiff(result.diff) },
      201,
    );
  }

  switch (result.status) {
    case 'subscription_not_found':
    case 'license_not_found':
      throw notFound(subjectType);
    case 'invalid_subject_type':
      throw rejected('INVALID_SUBJECT_TYPE');
    case 'invalid_change_type':
      throw rejected('INVALID_CHANGE_TYPE', { field: 'changeType' });
    case 'reason_required':
      throw rejected('REASON_REQUIRED', { field: 'reason' });
    case 'subject_not_active':
      throw stateConflict('SUBJECT_NOT_ACTIVE', { currentStatus: result.current_status });
    default:
      throw featureFailure(result);
  }
}
