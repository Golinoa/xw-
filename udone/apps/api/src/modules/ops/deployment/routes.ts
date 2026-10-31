import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsDeploymentCreateRequestSchema,
  opsDeploymentListQuerySchema,
  opsDeploymentTransitionRequestSchema,
  opsDeploymentUpdateRequestSchema,
  opsDeploymentVersionRecordCreateRequestSchema,
  opsDeploymentVersionRecordListQuerySchema,
  type OpsDeploymentListQuery,
  type OpsDeploymentVersionRecordListQuery,
  z,
} from '@erp/contracts';
import { parseJson, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  deploymentCreateEnvelopeSchema,
  deploymentDetailEnvelopeSchema,
  deploymentListEnvelopeSchema,
  deploymentTransitionEnvelopeSchema,
  deploymentUpdateEnvelopeSchema,
  toDeployment,
  toLicenseRef,
  toTicketRef,
  toVersionRecord,
  versionRecordCreateEnvelopeSchema,
  versionRecordListEnvelopeSchema,
} from './protocol';

export const opsDeploymentRoutes = new Hono<ApiEnvironment>();

/**
 * deployment 域（契约 §5.8 的七个端点：部署实例与升级记录）。
 *
 * 四件这一域特有的事：
 *
 * 1. **`currentVersion` 没有入站入口。** 建实例时可以给一个初始值，之后只能由
 *    「登记一条 succeeded 的升级记录」推进。所以 PATCH 的请求 schema 里找不到
 *    这个字段——想改版本只能走 `version-records`，那一步会留下一条不可改的记录。
 *
 * 2. **PATCH 的补丁里只放「真的传了」的键。** `{environmentRef: null}`（清空）
 *    与不传（别动）在 SQL 里长得一样，靠「键在不在 patch 里」区分。把整个
 *    body 原样丢下去，`null` 会被当成「清空所有没传的字段」。
 *
 * 3. **`version_mismatch` 在这一域有两条不同的落点。** PATCH 与 transition 是
 *    409 `CONFLICT`（乐观锁，换个版本号重试）；登记升级是 409 `STATE_CONFLICT`
 *    + `details.reason='VERSION_MISMATCH'`（用户该刷新看一眼当前版本，
 *    而不是换个数字再试）。契约 §5.8 的两行分别这么写，不是笔误。
 *
 * 4. **写端点不回 202。** 这些操作全部同步完成——没有远端。「当前版本变了」
 *    这件事在响应里就已经成立，前端不必轮询。
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
        'The deployment ledger reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The deployment ledger refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The deployment ledger rejected the request',
        );
      }
    }
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The deployment ledger is unavailable',
      { requestId },
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // 出站形状违约必须是 503 + 一条结构化日志：这不是调用方的错。
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
      'The deployment ledger returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** 契约 §5.8 标注「必填」的写端点都要判；缺键的拒绝只能由 handler 做。 */
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
    'The deployment request was rejected',
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
    'The deployment state does not allow it',
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
  if (raw.maintenanceUntilBefore === '') delete raw.maintenanceUntilBefore;

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

/** `GET /api/v1/ops/deployments` */
opsDeploymentRoutes.get(OPS_ROUTES.listOpsDeployments.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'deployment.read');
  const query = parseListQuery<OpsDeploymentListQuery>(context, opsDeploymentListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_deployment_instances',
    {
      p_customer_id: query.customerId ?? null,
      // 空数组与「不筛」是两件事：`status=[]` 表达的是「一个状态都不要」，
      // 而前端清空筛选时发的是空数组，语义应当是「不筛」。SQL 里按
      // `cardinality = 0` 归到「不筛」那一支。
      p_statuses: query.status ?? null,
      p_deployment_type: query.deploymentType ?? null,
      p_current_version: query.currentVersion ?? null,
      p_maintenance_until_before: query.maintenanceUntilBefore ?? null,
      p_limit: query.pageSize,
      p_offset: (query.page - 1) * query.pageSize,
    },
    deploymentListEnvelopeSchema,
  );

  return respond(context, 'listOpsDeployments', {
    items: result.items.map(toDeployment),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/** `POST /api/v1/ops/deployments` */
opsDeploymentRoutes.post(OPS_ROUTES.createOpsDeployment.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'deployment.write');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsDeploymentCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_deployment_instance',
    {
      p_customer_id: body.customerId,
      p_name: body.name,
      p_deployment_type: body.deploymentType,
      p_environment_ref: body.environmentRef ?? null,
      p_current_version: body.currentVersion ?? null,
      p_go_live_on: body.goLiveOn ?? null,
      p_maintenance_until: body.maintenanceUntil ?? null,
      p_owner_operator_id: body.ownerOperatorId ?? null,
      p_license_id: body.licenseId ?? null,
      p_contract_id: body.contractId ?? null,
    },
    deploymentCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsDeployment',
      { deployment: toDeployment(result.deployment) },
      201,
    );
  }

  switch (result.status) {
    case 'invalid_deployment_type':
      throw rejected('INVALID_DEPLOYMENT_TYPE', { field: 'deploymentType' });
    case 'name_required':
      throw rejected('NAME_REQUIRED', { field: 'name' });
    case 'customer_not_found':
      // 客户在请求体里而不是 URL 上，所以是 400 不是 404。
      throw rejected('CUSTOMER_NOT_FOUND', { field: 'customerId' });
    case 'owner_not_found':
      throw rejected('OWNER_NOT_FOUND', { field: 'ownerOperatorId' });
    case 'license_not_found':
      throw rejected('LICENSE_NOT_FOUND', { field: 'licenseId' });
    case 'license_customer_mismatch':
      throw rejected('LICENSE_CUSTOMER_MISMATCH', { field: 'licenseId' });
    case 'contract_not_found':
      throw rejected('CONTRACT_NOT_FOUND', { field: 'contractId' });
    case 'contract_customer_mismatch':
      throw rejected('CONTRACT_CUSTOMER_MISMATCH', { field: 'contractId' });
    case 'name_taken':
      throw conflict({ reason: 'DEPLOYMENT_NAME_TAKEN', name: result.name });
  }
});

/** `GET /api/v1/ops/deployments/:deploymentId` */
opsDeploymentRoutes.get(OPS_ROUTES.getOpsDeployment.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'deployment.read');
  const deploymentId = context.req.param('deploymentId');

  const result = await callOpsRpc(
    context,
    'get_deployment_instance',
    { p_instance_id: deploymentId },
    deploymentDetailEnvelopeSchema,
  );

  if (result.status !== 'ok') {
    throw notFound('deployment');
  }

  return respond(context, 'getOpsDeployment', {
    deployment: toDeployment(result.deployment),
    allowedActions: result.allowed_actions,
    versionRecords: result.versionRecords.map(toVersionRecord),
    licenses: result.licenses.map(toLicenseRef),
    tickets: result.tickets.map(toTicketRef),
  });
});

/** `PATCH /api/v1/ops/deployments/:deploymentId` */
opsDeploymentRoutes.patch(
  OPS_ROUTES.updateOpsDeployment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'deployment.write');
    const body = await parseJson(context, opsDeploymentUpdateRequestSchema);
    const deploymentId = context.req.param('deploymentId');

    // 只放「真的传了」的键：`null` 是「清空」，不传是「别动」。
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.deploymentType !== undefined) patch.deploymentType = body.deploymentType;
    if (body.environmentRef !== undefined) patch.environmentRef = body.environmentRef;
    if (body.goLiveOn !== undefined) patch.goLiveOn = body.goLiveOn;
    if (body.maintenanceUntil !== undefined) patch.maintenanceUntil = body.maintenanceUntil;
    if (body.ownerOperatorId !== undefined) patch.ownerOperatorId = body.ownerOperatorId;
    if (body.licenseId !== undefined) patch.licenseId = body.licenseId;
    if (body.contractId !== undefined) patch.contractId = body.contractId;

    const result = await callOpsRpc(
      context,
      'update_deployment_instance',
      {
        p_instance_id: deploymentId,
        p_patch: patch,
        p_expected_version: body.version,
      },
      deploymentUpdateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'updateOpsDeployment', {
        deployment: toDeployment(result.deployment),
      });
    }

    switch (result.status) {
      case 'not_found':
        throw notFound('deployment');
      case 'version_mismatch':
        throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
      case 'instance_retired':
        throw stateConflict('DEPLOYMENT_RETIRED');
      case 'name_required':
        throw rejected('NAME_REQUIRED', { field: 'name' });
      case 'invalid_deployment_type':
        throw rejected('INVALID_DEPLOYMENT_TYPE', { field: 'deploymentType' });
      case 'owner_not_found':
        throw rejected('OWNER_NOT_FOUND', { field: 'ownerOperatorId' });
      case 'license_not_found':
        throw rejected('LICENSE_NOT_FOUND', { field: 'licenseId' });
      case 'license_customer_mismatch':
        throw rejected('LICENSE_CUSTOMER_MISMATCH', { field: 'licenseId' });
      case 'contract_not_found':
        throw rejected('CONTRACT_NOT_FOUND', { field: 'contractId' });
      case 'contract_customer_mismatch':
        throw rejected('CONTRACT_CUSTOMER_MISMATCH', { field: 'contractId' });
      case 'go_live_on_required':
        throw rejected('GO_LIVE_ON_REQUIRED', { field: 'goLiveOn' });
      case 'name_taken':
        throw conflict({ reason: 'DEPLOYMENT_NAME_TAKEN', name: result.name });
    }
  },
);

/** `POST /api/v1/ops/deployments/:deploymentId/transition` */
opsDeploymentRoutes.post(
  OPS_ROUTES.transitionOpsDeployment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'deployment.write');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsDeploymentTransitionRequestSchema);
    const deploymentId = context.req.param('deploymentId');

    const result = await callOpsRpc(
      context,
      'transition_deployment_instance',
      {
        p_instance_id: deploymentId,
        p_action: body.action,
        p_reason: body.reason ?? null,
        p_go_live_on: body.goLiveOn ?? null,
        p_expected_version: body.version,
      },
      deploymentTransitionEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'transitionOpsDeployment', {
        deployment: toDeployment(result.deployment),
        allowedActions: result.allowed_actions,
      });
    }

    switch (result.status) {
      case 'not_found':
        throw notFound('deployment');
      case 'version_mismatch':
        throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
      case 'invalid_transition':
        // `allowedActions` 一起回：前端据此重画按钮，不必再查一次详情。
        throw stateConflict(
          'INVALID_TRANSITION',
          { currentStatus: result.current_status },
          result.allowed_actions,
        );
      case 'go_live_on_required':
        throw rejected('GO_LIVE_ON_REQUIRED', { field: 'goLiveOn' });
      case 'reason_required':
        throw rejected('REASON_REQUIRED', { field: 'reason' });
    }
  },
);

/** `POST /api/v1/ops/deployments/:deploymentId/version-records` */
opsDeploymentRoutes.post(
  OPS_ROUTES.createOpsDeploymentVersionRecord.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'deployment.write');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsDeploymentVersionRecordCreateRequestSchema);
    const deploymentId = context.req.param('deploymentId');

    const result = await callOpsRpc(
      context,
      'create_deployment_version_record',
      {
        p_instance_id: deploymentId,
        p_from_version: body.fromVersion,
        p_to_version: body.toVersion,
        p_executed_on: body.executedOn,
        p_result: body.result,
        p_impact_note: body.impactNote ?? null,
        p_rollback_note: body.rollbackNote ?? null,
      },
      versionRecordCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsDeploymentVersionRecord',
        {
          versionRecord: toVersionRecord(result.version_record),
          deployment: toDeployment(result.deployment),
        },
        201,
      );
    }

    switch (result.status) {
      case 'not_found':
        throw notFound('deployment');
      case 'invalid_result':
        throw rejected('INVALID_RESULT', { field: 'result' });
      case 'from_version_required':
        throw rejected('FROM_VERSION_REQUIRED', { field: 'fromVersion' });
      case 'to_version_required':
        throw rejected('TO_VERSION_REQUIRED', { field: 'toVersion' });
      case 'executed_on_required':
        throw rejected('EXECUTED_ON_REQUIRED', { field: 'executedOn' });
      case 'version_mismatch':
        // 与 PATCH 的 `VERSION_MISMATCH` 不同：这里不是乐观锁，是「你说的
        // 起点不是它现在的样子」。用户该刷新看当前版本，而不是换个数字重试。
        throw stateConflict('VERSION_MISMATCH', {
          currentVersion: result.current_version,
          fromVersion: result.from_version,
        });
    }
  },
);

/** `GET /api/v1/ops/deployments/:deploymentId/version-records` */
opsDeploymentRoutes.get(
  OPS_ROUTES.listOpsDeploymentVersionRecords.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'deployment.read');
    const deploymentId = context.req.param('deploymentId');
    const query = parseListQuery<OpsDeploymentVersionRecordListQuery>(
      context,
      opsDeploymentVersionRecordListQuerySchema,
    );

    const result = await callOpsRpc(
      context,
      'list_deployment_version_records',
      {
        p_instance_id: deploymentId,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      versionRecordListEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw notFound('deployment');
    }

    return respond(context, 'listOpsDeploymentVersionRecords', {
      items: result.items.map(toVersionRecord),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);
