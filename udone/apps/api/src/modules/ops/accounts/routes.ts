import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsAuditEventListQuerySchema,
  opsOperatorInvitationRequestSchema,
  opsOperatorListQuerySchema,
  opsOperatorUpdateRequestSchema,
  opsRoleCreateRequestSchema,
  opsRoleUpdateRequestSchema,
  type OpsAuditEventListResponse,
  type OpsOperatorListResponse,
  type OpsRoleListResponse,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import { createGoTrueInviteUpstream } from './invite-upstream';
import {
  auditEventListEnvelopeSchema,
  inviteEnvelopeSchema,
  operatorListEnvelopeSchema,
  operatorUpdateEnvelopeSchema,
  roleCreateEnvelopeSchema,
  roleListEnvelopeSchema,
  roleUpdateEnvelopeSchema,
  toAuditEvent,
  toOperator,
  toRole,
} from './protocol';

export const opsAccountRoutes = new Hono<ApiEnvironment>();

/**
 * RPC 调用与信封解析的唯一入口。
 *
 * 三件事必须一起做，分开做就一定会漏一件：
 *   1. 用**用户的**令牌调（不是 service_role）——RLS 与 `auth.uid()` 才有意义；
 *   2. 把上游的非 2xx 翻译成契约里的错误码；
 *   3. 用 zod 校验返回形状，形状不对就是迁移漂移，不能当成业务结果往下走。
 *
 * 第 3 条最容易省，代价也最隐蔽：RPC 少一个键，前端拿到 `undefined`，
 * 渲染成空字符串，看起来像「这个人没填名字」。
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
        'The operator directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The operator directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The operator directory rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The operator directory is unavailable',
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
      'The operator directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/**
 * 契约字段名 → 数据库列名。
 *
 * SQL 的 `CASE` 阶梯按列名排序，把契约字段名直接传下去会静默落到兜底（按邮箱升序），
 * 于是「按创建时间倒序」这个请求得到一个看起来正常、但顺序错误的列表。
 */
const OPERATOR_SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  email: 'email',
  displayName: 'display_name',
  lastLoginAt: 'last_login_at',
};

/**
 * `GET /api/v1/ops/operators`
 *
 * 权限在 Worker 判一次（403 带 `details.required`），库里再判一次（42501）。
 * 前者的意义是拒绝页能说清缺哪个动作码。
 */
opsAccountRoutes.get(OPS_ROUTES.listOpsOperators.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'operator.read');
  const query = parseQuery(context, opsOperatorListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_operators',
    {
      p_keyword: query.keyword ?? null,
      p_status: query.status ?? null,
      p_role_code: query.roleCode ?? null,
      p_sort: OPERATOR_SORT_COLUMNS[query.sort] ?? 'created_at',
      p_order: query.order,
      p_page: query.page,
      p_page_size: query.pageSize,
    },
    operatorListEnvelopeSchema,
  );

  const body: OpsOperatorListResponse = {
    items: result.items.map(toOperator),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  };
  return respond(context, 'listOpsOperators', body);
});

/**
 * `POST /api/v1/ops/operators/invitations`
 *
 * 顺序是「先 GoTrue、后 ops 行」，因为 `ops.operators.user_id` 的外键指向
 * `auth.users`：反过来的话要么先插一个假 uuid（外键会拒），要么先把外键去掉
 * （那它就不是约束了）。
 *
 * 代价必须写明白：这是**跨系统的两阶段写，不原子**。GoTrue 建了账号、ops 行却被
 * 拒（角色码在两次调用之间被删、并发邀请同一邮箱），会留下一个没有运营身份的
 * auth 用户。清理不了它——Worker 没有删除 auth 用户的路径。所以这里不打「已回滚」
 * 的幌子，而是落一条 `ops_invitation_orphan_user` 日志，把 userId 交给运维。
 * 之所以可接受：下次对同一邮箱重试会走到 `email_exists`，运维据此知道要处理残留。
 */
opsAccountRoutes.post(OPS_ROUTES.inviteOpsOperator.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'operator.manage');
  const body = await parseJson(context, opsOperatorInvitationRequestSchema);

  const upstream = context.env.OPS_INVITE_UPSTREAM ?? createGoTrueInviteUpstream(context.env);
  const outcome = await upstream.invite(body.email);

  if (outcome.kind === 'email_taken') {
    throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'An account with this email already exists', {
      field: 'email',
    });
  }
  if (outcome.kind === 'unavailable') {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Sending invitations is not available right now',
    );
  }

  const result = await callOpsRpc(
    context,
    'invite_operator',
    {
      p_user_id: outcome.userId,
      p_email: body.email,
      p_role_codes: body.roleCodes,
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    inviteEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'inviteOpsOperator',
      {
        operator: { id: result.operator.id, status: 'invited' },
        invitationExpiresAt: result.invitation_expires_at,
      },
      201,
    );
  }

  // 走到这里说明 auth 用户已经建好、ops 行没写成。日志记 userId 而不是邮箱：
  // 邮箱是个人信息，而清理残留需要的只是 id。
  console.error(
    JSON.stringify({
      event: 'ops_invitation_orphan_user',
      userId: outcome.userId,
      reason: result.status,
      requestId: context.get('requestId'),
    }),
  );

  switch (result.status) {
    case 'email_exists':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'An account with this email already exists',
      );
    case 'unknown_role':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Unknown role codes', {
        codes: result.codes,
      });
    case 'roles_required':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'At least one role is required');
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The invitation was rejected');
  }
});

/**
 * `PATCH /api/v1/ops/operators/{operatorId}`
 *
 * 三种 409 必须分开，因为它们指的人不同：
 *   - `CONFLICT` + `currentVersion`：有人先改了，刷新重试即可（并发，不是错误）；
 *   - `STATE_CONFLICT` + `LAST_ROLE`：这个账号会失去所有角色，需要先给别的角色；
 *   - `STATE_CONFLICT` + `LAST_ADMIN`：系统里会没有管理员，得先给别人加
 *     `operator.manage`——这条不做「确认后强制」的逃生口，因为逃生口一旦存在，
 *     误操作的现场就与有意为之无法区分。
 */
opsAccountRoutes.patch(OPS_ROUTES.updateOpsOperator.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'operator.manage');
  const params = parseParams(context, z.object({ operatorId: z.string().min(1) }));
  const body = await parseJson(context, opsOperatorUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_operator',
    {
      p_operator_id: params.operatorId,
      p_expected_version: body.version,
      p_status: body.status ?? null,
      p_role_codes: body.roleCodes ?? null,
      p_mfa_required: body.mfaRequired ?? null,
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    operatorUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsOperator', {
      operator: toOperator(result.operator),
      permissionsChanged: {
        added: result.permissions_changed.added,
        removed: result.permissions_changed.removed,
      },
    });
  }

  switch (result.status) {
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The account was modified by someone else',
        {
          currentVersion: result.current_version,
        },
      );
    case 'last_role':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'An account needs at least one role',
        {
          reason: 'LAST_ROLE',
        },
      );
    case 'last_admin':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'At least one active account must keep operator.manage',
        { reason: 'LAST_ADMIN' },
      );
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The operator account does not exist');
    case 'unknown_role':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Unknown role codes', {
        codes: result.codes,
      });
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The update was rejected');
  }
});

/** `GET /api/v1/ops/roles` —— 无分页：角色是配置项，数量是个位数。 */
opsAccountRoutes.get(OPS_ROUTES.listOpsRoles.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'operator.read');
  const result = await callOpsRpc(context, 'list_roles', {}, roleListEnvelopeSchema);
  const body: OpsRoleListResponse = { items: result.items.map(toRole) };
  return respond(context, 'listOpsRoles', body);
});

opsAccountRoutes.post(OPS_ROUTES.createOpsRole.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'role.manage');
  const body = await parseJson(context, opsRoleCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_role',
    {
      p_code: body.code,
      p_name: body.name,
      p_description: body.description ?? null,
      p_permission_codes: body.permissionCodes,
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    roleCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'createOpsRole', { role: toRole(result.role) }, 201);
  }

  switch (result.status) {
    case 'role_code_exists':
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'A role with this code already exists', {
        field: 'code',
      });
    case 'unknown_permission':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Unknown permission codes', {
        codes: result.codes,
      });
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The role was rejected');
  }
});

/**
 * `PATCH /api/v1/ops/roles/{roleId}`
 *
 * 契约没给这个端点要求 `version`，所以没有乐观锁。这是有代价的：两个人同时改
 * 同一角色的权限集合，后写者覆盖前写者，而两次操作各自看起来都成功了。
 * 记在案而不是偷偷加一个契约外的字段——前端不知道要传 `version` 的话，
 * 服务端要求它就是一次 400。
 */
opsAccountRoutes.patch(OPS_ROUTES.updateOpsRole.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'role.manage');
  const params = parseParams(context, z.object({ roleId: z.string().min(1) }));
  const body = await parseJson(context, opsRoleUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_role',
    {
      p_role_id: params.roleId,
      p_name: body.name ?? null,
      p_description: body.description ?? null,
      p_permission_codes: body.permissionCodes ?? null,
      p_status: body.status ?? null,
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    roleUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsRole', {
      role: toRole(result.role),
      beforePermissions: result.before_permissions,
      afterPermissions: result.after_permissions,
    });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The role does not exist');
    case 'last_admin':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'At least one active account must keep operator.manage',
        { reason: 'LAST_ADMIN' },
      );
    case 'unknown_permission':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Unknown permission codes', {
        codes: result.codes,
      });
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The role was rejected');
  }
});

/** `GET /api/v1/ops/audit-events` —— 只读，排序固定 `createdAt` 降序。 */
opsAccountRoutes.get(OPS_ROUTES.listOpsAuditEvents.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'audit.read');
  const query = parseQuery(context, opsAuditEventListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_audit_events',
    {
      p_actor_operator_id: query.actorOperatorId ?? null,
      p_action: query.action ?? null,
      p_entity_type: query.entityType ?? null,
      p_entity_id: query.entityId ?? null,
      p_request_id: query.requestId ?? null,
      p_from: query.from ?? null,
      p_to: query.to ?? null,
      p_page: query.page,
      p_page_size: query.pageSize,
    },
    auditEventListEnvelopeSchema,
  );

  const body: OpsAuditEventListResponse = {
    items: result.items.map(toAuditEvent),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  };
  return respond(context, 'listOpsAuditEvents', body);
});
