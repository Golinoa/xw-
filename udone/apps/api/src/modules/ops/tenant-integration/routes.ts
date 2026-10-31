import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsTenantCommandCreateRequestSchema,
  opsTenantCommandListQuerySchema,
  opsTenantCommandTransitionRequestSchema,
  opsTenantMappingCreateRequestSchema,
  opsTenantMappingListQuerySchema,
  opsTenantMappingUpdateRequestSchema,
  type OpsTenantCommandListQuery,
  type OpsTenantMappingListQuery,
  z,
} from '@erp/contracts';
import { parseJson, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  attemptListEnvelopeSchema,
  commandCreateEnvelopeSchema,
  commandDetailEnvelopeSchema,
  commandListEnvelopeSchema,
  commandTransitionEnvelopeSchema,
  mappingCreateEnvelopeSchema,
  mappingDetailEnvelopeSchema,
  mappingListEnvelopeSchema,
  mappingUpdateEnvelopeSchema,
  toAttempt,
  toCommand,
  toMapping,
} from './protocol';

export const opsTenantIntegrationRoutes = new Hono<ApiEnvironment>();

/**
 * tenant-integration 域（契约 §5.7 的十个端点：租户映射与租户命令）。
 *
 * 四件这一域特有的事：
 *
 * 1. **建命令的权限按 `commandType` 判，不按端点判。** 一个端点八种命令、
 *    三类权限（`provision`/`bind`/`activate`→`tenant.provision`；
 *    `suspend`→`tenant.suspend`；`resume`→`tenant.restore`；
 *    `sync_entitlement`/`extend`/`revoke`→`entitlement.execute`）。
 *    端点级固定判一个权限的话，`suspend` 会被 `tenant.provision` 放行、
 *    `sync_entitlement` 会被挡成 403——两种错都不报错。
 *
 * 2. **`retry`/`cancel` 的权限只能由库里判。** 这两个端点要的是「原命令的
 *    动作码」，而命令类型要读一次库才知道；在 handler 里只判 `tenant.retry`
 *    （`retry` 独有的一半），另一半留给 RPC——它在同一条语句里已经拿到
 *    `command_type`，比在这里多查一次再判更准。
 *
 * 3. **建命令与重试回 202，不是 201/200。** 202 的含义是「受理了，但远端还没
 *    确认」。202 的可信度不是靠状态码本身，是靠 `record_tenant_command_attempt`
 *    不授给 `authenticated`——运营端没有任何办法把 pending 写成 succeeded。
 *
 * 4. **`syncVersion` 过期是 409 `STATE_CONFLICT`，不是 `CONFLICT`。** 它不是
 *    「值被占用」，是「你看到的状态已经过去了」，用户下一步是刷新重来，
 *    而不是换个值再试。
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
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The tenant directory reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The tenant directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The tenant directory rejected the request',
        );
      }
    }
    throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The tenant directory is unavailable', {
      requestId,
    });
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
      'The tenant directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** 契约 §5.7 标注「必填」的写端点都要判；缺键的拒绝只能由 handler 做。 */
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
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The tenant request was rejected', {
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
  return new ApiHttpError(409, ERROR_CODES.STATE_CONFLICT, 'The tenant state does not allow it', {
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

function parseListQuery<T>(context: Context<ApiEnvironment>, schema: z.ZodType<T>): T {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;
  if (raw.createdFrom === '') delete raw.createdFrom;
  if (raw.createdTo === '') delete raw.createdTo;

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

/** 建命令的动作 → 权限码（契约 §5.7「按 commandType 映射」）。 */
const COMMAND_TYPE_PERMISSIONS = {
  provision: 'tenant.provision',
  bind: 'tenant.provision',
  activate: 'tenant.provision',
  suspend: 'tenant.suspend',
  resume: 'tenant.restore',
  sync_entitlement: 'entitlement.execute',
  extend: 'entitlement.execute',
  revoke: 'entitlement.execute',
} as const;

function commandCreateFailure(
  result:
    | { status: 'mapping_not_found' }
    | { status: 'invalid_command_type' }
    | { status: 'idempotency_conflict'; existing_command_id: string }
    | { status: 'expected_sync_version_required' }
    | { status: 'sync_version_mismatch'; current_sync_version: number }
    | { status: 'change_request_not_found' }
    | { status: 'change_request_not_approved'; change_request_status: string }
    | { status: 'mapping_already_bound' }
    | { status: 'mapping_not_bound' }
    | { status: 'mapping_not_active'; mapping_status: string }
    | { status: 'mapping_not_suspended'; mapping_status: string }
    | { status: 'reason_required' },
): ApiHttpError {
  switch (result.status) {
    case 'mapping_not_found':
      return notFound('tenantMapping');
    case 'invalid_command_type':
      return rejected('INVALID_COMMAND_TYPE', { field: 'commandType' });
    case 'expected_sync_version_required':
      return rejected('EXPECTED_SYNC_VERSION_REQUIRED', { field: 'expectedSyncVersion' });
    case 'reason_required':
      return rejected('REASON_REQUIRED', { field: 'reason' });
    case 'change_request_not_found':
      // 被引用的行不存在，属于请求体里的外键指错了，不是 URL 上的资源缺失。
      return rejected('CHANGE_REQUEST_NOT_FOUND', { field: 'changeRequestId' });
    case 'change_request_not_approved':
      return stateConflict('APPROVAL_REQUIRED', {
        changeRequestStatus: result.change_request_status,
      });
    case 'idempotency_conflict':
      return conflict({
        reason: 'IDEMPOTENCY_KEY_CONFLICT',
        existingCommandId: result.existing_command_id,
      });
    case 'sync_version_mismatch':
      return stateConflict('SYNC_VERSION_MISMATCH', {
        currentSyncVersion: result.current_sync_version,
      });
    case 'mapping_already_bound':
      return stateConflict('MAPPING_ALREADY_BOUND');
    case 'mapping_not_bound':
      return stateConflict('MAPPING_NOT_BOUND');
    case 'mapping_not_active':
      return stateConflict('MAPPING_NOT_ACTIVE', { mappingStatus: result.mapping_status });
    case 'mapping_not_suspended':
      return stateConflict('MAPPING_NOT_SUSPENDED', { mappingStatus: result.mapping_status });
  }
}

/** `GET /api/v1/ops/tenant-mappings` */
opsTenantIntegrationRoutes.get(
  OPS_ROUTES.listOpsTenantMappings.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const query = parseListQuery<OpsTenantMappingListQuery>(
      context,
      opsTenantMappingListQuerySchema,
    );

    const result = await callOpsRpc(
      context,
      'list_tenant_mappings',
      {
        p_customer_id: query.customerId ?? null,
        p_mapping_status: query.mappingStatus ?? null,
        p_product_id: query.productId ?? null,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      mappingListEnvelopeSchema,
    );

    return respond(context, 'listOpsTenantMappings', {
      items: result.items.map(toMapping),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

/** `POST /api/v1/ops/tenant-mappings` */
opsTenantIntegrationRoutes.post(
  OPS_ROUTES.createOpsTenantMapping.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.provision');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsTenantMappingCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_tenant_mapping',
      {
        p_customer_id: body.customerId,
        p_product_id: body.productId,
        p_udone_organization_id: body.udoneOrganizationId ?? null,
        p_external_ref: body.externalRef ?? null,
        p_reason: body.reason ?? null,
      },
      mappingCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsTenantMapping',
        { mapping: toMapping(result.mapping) },
        201,
      );
    }

    switch (result.status) {
      case 'customer_not_found':
        throw rejected('CUSTOMER_NOT_FOUND', { field: 'customerId' });
      case 'product_not_found':
        throw rejected('PRODUCT_NOT_FOUND', { field: 'productId' });
      case 'tenant_mapping_conflict':
        throw conflict({
          reason: 'TENANT_MAPPING_CONFLICT',
          existingMappingId: result.existing_mapping_id,
        });
    }
  },
);

/** `GET /api/v1/ops/tenant-mappings/:mappingId` */
opsTenantIntegrationRoutes.get(
  OPS_ROUTES.getOpsTenantMapping.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const mappingId = context.req.param('mappingId');

    const result = await callOpsRpc(
      context,
      'get_tenant_mapping',
      { p_mapping_id: mappingId },
      mappingDetailEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw notFound('tenantMapping');
    }

    return respond(context, 'getOpsTenantMapping', {
      mapping: toMapping(result.mapping),
      commands: result.commands.map(toCommand),
    });
  },
);

/** `PATCH /api/v1/ops/tenant-mappings/:mappingId` */
opsTenantIntegrationRoutes.patch(
  OPS_ROUTES.updateOpsTenantMapping.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.provision');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsTenantMappingUpdateRequestSchema);
    const mappingId = context.req.param('mappingId');

    // 「传了 null」与「没传」在 SQL 里长得一样，所以显式带一对 set_* 布尔：
    // 否则 externalRef 永远清不掉（coalesce 会把 null 当成「保持原值」）。
    const result = await callOpsRpc(
      context,
      'update_tenant_mapping',
      {
        p_mapping_id: mappingId,
        p_set_organization: body.udoneOrganizationId !== undefined,
        p_udone_organization_id: body.udoneOrganizationId ?? null,
        p_set_external_ref: body.externalRef !== undefined,
        p_external_ref: body.externalRef ?? null,
        p_version: body.version,
        p_reason: null,
      },
      mappingUpdateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'updateOpsTenantMapping', { mapping: toMapping(result.mapping) });
    }

    switch (result.status) {
      case 'mapping_not_found':
        throw notFound('tenantMapping');
      case 'version_mismatch':
        throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
      case 'mapping_not_pending':
        throw stateConflict('MAPPING_NOT_PENDING', { mappingStatus: result.mapping_status });
      case 'organization_required':
        throw rejected('ORGANIZATION_REQUIRED', { field: 'udoneOrganizationId' });
      case 'tenant_mapping_conflict':
        throw conflict({
          reason: 'TENANT_MAPPING_CONFLICT',
          existingMappingId: result.existing_mapping_id,
        });
    }
  },
);

/** `POST /api/v1/ops/tenant-mappings/:mappingId/commands` */
opsTenantIntegrationRoutes.post(
  OPS_ROUTES.createOpsTenantCommand.path,
  requireOpsAuth(),
  async (context) => {
    const body = await parseJson(context, opsTenantCommandCreateRequestSchema);
    // 权限按命令类型判（见文件头注释 1）。
    requireOpsPermission(context, COMMAND_TYPE_PERMISSIONS[body.commandType]);
    requireIdempotencyKey(context);
    const mappingId = context.req.param('mappingId');

    const result = await callOpsRpc(
      context,
      'create_tenant_command',
      {
        p_mapping_id: mappingId,
        p_command_type: body.commandType,
        p_reason: body.reason,
        p_idempotency_key: context.req.header('Idempotency-Key'),
        p_contract_id: body.contractId ?? null,
        p_change_request_id: body.changeRequestId ?? null,
        p_expected_sync_version: body.expectedSyncVersion ?? null,
        p_payload: body.payload ?? null,
      },
      commandCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsTenantCommand',
        {
          command: toCommand(result.command),
          mapping: result.mapping ? toMapping(result.mapping) : null,
        },
        202,
      );
    }

    throw commandCreateFailure(result);
  },
);

/** `GET /api/v1/ops/tenant-commands` */
opsTenantIntegrationRoutes.get(
  OPS_ROUTES.listOpsTenantCommands.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const query = parseListQuery<OpsTenantCommandListQuery>(
      context,
      opsTenantCommandListQuerySchema,
    );

    const result = await callOpsRpc(
      context,
      'list_tenant_commands',
      {
        p_mapping_id: query.mappingId ?? null,
        p_statuses: query.status ?? null,
        p_command_type: query.commandType ?? null,
        p_created_from: query.createdFrom ?? null,
        p_created_to: query.createdTo ?? null,
        p_limit: query.pageSize,
        p_offset: (query.page - 1) * query.pageSize,
      },
      commandListEnvelopeSchema,
    );

    return respond(context, 'listOpsTenantCommands', {
      items: result.items.map(toCommand),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    });
  },
);

/** `GET /api/v1/ops/tenant-commands/:commandId` */
opsTenantIntegrationRoutes.get(
  OPS_ROUTES.getOpsTenantCommand.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const commandId = context.req.param('commandId');

    const result = await callOpsRpc(
      context,
      'get_tenant_command',
      { p_command_id: commandId },
      commandDetailEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      throw notFound('tenantCommand');
    }

    return respond(context, 'getOpsTenantCommand', {
      command: toCommand(result.command),
      attempts: result.attempts.map(toAttempt),
      retryable: result.retryable,
    });
  },
);

/** `GET /api/v1/ops/tenant-commands/:commandId/attempts` */
opsTenantIntegrationRoutes.get(
  OPS_ROUTES.listOpsTenantCommandAttempts.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const commandId = context.req.param('commandId');
    // 尝试记录一次最多也就几十条，不接分页参数；但响应形状仍是分页壳，
    // 免得将来加参数时前端要改两处。
    const page = 1;
    const pageSize = 100;

    const result = await callOpsRpc(
      context,
      'list_tenant_command_attempts',
      { p_command_id: commandId },
      attemptListEnvelopeSchema,
    );

    if (result.status === 'command_not_found') {
      throw notFound('tenantCommand');
    }

    return respond(context, 'listOpsTenantCommandAttempts', {
      items: result.items.map(toAttempt),
      total: result.total,
      page,
      pageSize,
    });
  },
);

/** `POST /api/v1/ops/tenant-commands/:commandId/retry` */
opsTenantIntegrationRoutes.post(
  OPS_ROUTES.retryOpsTenantCommand.path,
  requireOpsAuth(),
  async (context) => {
    // 契约要求 `tenant.retry` **加上**原命令的动作码；后者要读库才知道类型，
    // 由 RPC 在同一个事务里判（见文件头注释 2）。
    requireOpsPermission(context, 'tenant.retry');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsTenantCommandTransitionRequestSchema);
    const commandId = context.req.param('commandId');

    const result = await callOpsRpc(
      context,
      'transition_tenant_command',
      {
        p_command_id: commandId,
        p_action: body.action,
        p_reason: body.reason ?? null,
        p_version: body.version ?? null,
      },
      commandTransitionEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'retryOpsTenantCommand', { command: toCommand(result.command) }, 202);
    }

    switch (result.status) {
      case 'command_not_found':
        throw notFound('tenantCommand');
      case 'invalid_transition':
        throw stateConflict(
          'INVALID_TRANSITION',
          { currentStatus: result.current_status },
          result.allowed_actions,
        );
      case 'version_mismatch':
        throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
      case 'permanent_error':
        // 永久错误重试是「状态不允许」，不是「没权限」——用户下一步是修配置，
        // 不是找管理员要权限。
        throw stateConflict('PERMANENT_ERROR');
      case 'command_attempted':
        throw stateConflict('COMMAND_ATTEMPTED', { attemptCount: result.attempt_count });
    }
  },
);

/** `POST /api/v1/ops/tenant-commands/:commandId/cancel` */
opsTenantIntegrationRoutes.post(
  OPS_ROUTES.cancelOpsTenantCommand.path,
  requireOpsAuth(),
  async (context) => {
    // 取消要的是「原命令的动作码」，handler 里查不到；由 RPC 判。
    const body = await parseJson(context, opsTenantCommandTransitionRequestSchema);
    const commandId = context.req.param('commandId');

    const result = await callOpsRpc(
      context,
      'transition_tenant_command',
      {
        p_command_id: commandId,
        p_action: 'cancel',
        p_reason: body.reason ?? null,
        p_version: body.version ?? null,
      },
      commandTransitionEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'cancelOpsTenantCommand', { command: toCommand(result.command) });
    }

    switch (result.status) {
      case 'command_not_found':
        throw notFound('tenantCommand');
      case 'invalid_transition':
        throw stateConflict(
          'INVALID_TRANSITION',
          { currentStatus: result.current_status },
          result.allowed_actions,
        );
      case 'version_mismatch':
        throw conflict({ reason: 'VERSION_MISMATCH', currentVersion: result.current_version });
      case 'permanent_error':
        throw stateConflict('PERMANENT_ERROR');
      case 'command_attempted':
        throw stateConflict('COMMAND_ATTEMPTED', { attemptCount: result.attempt_count });
    }
  },
);
