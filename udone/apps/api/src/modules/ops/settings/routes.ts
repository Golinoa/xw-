import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsDictionaryItemCreateRequestSchema,
  opsDictionaryItemUpdateRequestSchema,
  opsSettingsUpdateRequestSchema,
  type OpsSettingsUpdateRequest,
  z,
} from '@erp/contracts';
import { parseJson, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  dictionaryItemEnvelopeSchema,
  dictionaryListEnvelopeSchema,
  settingsEnvelopeSchema,
  toDictionaryItem,
  toDictionaryList,
  toSettingsEnvelope,
} from './protocol';

export const opsSettingsRoutes = new Hono<ApiEnvironment>();

/**
 * 设置页（契约 §5.9 的五个端点）：参数项两组 + 字典三组。
 *
 * 四件这一域特有的事：
 *
 * 1. **两道权限，边界不同。** 参数项与字典的**写**都要 `settings.manage`；
 *    字典的**读**不需要——契约把它开放给「任意已认证运营成员」，因为字典里
 *    只有选项文案。让创建工单的人先有 `settings.manage` 才能取到问题类型，
 *    等于把一个下拉框锁给了管理员。
 *
 * 2. **`PATCH` 的请求体是部分对象。** 只放「真的传了」的键：两个人各改一项时，
 *    把整份 body 传下去会让后到的把前一个改回去。
 *
 * 3. **越界是 400 + `details.field`，不是 422。** 设置页的三个输入框要能
 *    各自标红，所以拒绝理由必须指到字段——这正是库里那道 CHECK 给不出来的
 *    信息（它只报约束名）。
 *
 * 4. **202 用不上。** 五个端点全部同步完成，没有远端、没有队列。
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
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The settings page reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The settings page refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The settings page rejected the request',
        );
      }
      if (cause.status === 404) {
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The settings page has no such record');
      }
    }
    throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The settings page is unavailable', {
      requestId,
    });
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
      'The settings page returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** 契约 §5.9 标注「必填」的两个写端点。 */
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

function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The settings request was rejected', {
    reason,
    ...details,
  });
}

function notFound(resource: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `The ${resource} does not exist`, {
    resource,
    ...details,
  });
}

/**
 * 只放真的传了的键。
 *
 * `refine` 已经保证至少有一个键，所以这里不需要再判空；但 `undefined` 与
 * `null` 的区别仍然要保住——三个设置项都不接受 null，把 `undefined` 写进
 * patch 会让 SQL 侧的 `jsonb_object_keys` 多出一个键。
 */
function settingsPatch(body: OpsSettingsUpdateRequest): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.overviewExpiryWindowDays !== undefined) {
    patch.overviewExpiryWindowDays = body.overviewExpiryWindowDays;
  }
  if (body.ticketDueHours !== undefined) patch.ticketDueHours = body.ticketDueHours;
  if (body.exportRetentionDays !== undefined) patch.exportRetentionDays = body.exportRetentionDays;
  return patch;
}

/** `GET /api/v1/ops/settings` */
opsSettingsRoutes.get(OPS_ROUTES.getOpsSettings.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'settings.manage');

  const result = await callOpsRpc(context, 'get_ops_settings', {}, settingsEnvelopeSchema);

  if (result.status === 'ok') {
    return respond(context, 'getOpsSettings', toSettingsEnvelope(result));
  }

  // 读端点拿到写端点的拒绝理由是形状违约，不是业务分支：这条不能静默当成 200。
  throw new ApiHttpError(
    503,
    ERROR_CODES.INTERNAL_ERROR,
    'The settings page returned an unexpected status',
  );
});

/** `PATCH /api/v1/ops/settings` */
opsSettingsRoutes.patch(OPS_ROUTES.updateOpsSettings.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'settings.manage');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsSettingsUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_ops_settings',
    { p_patch: settingsPatch(body), p_request_id: context.get('requestId') },
    settingsEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsSettings', toSettingsEnvelope(result));
  }

  switch (result.status) {
    case 'empty_patch':
      // zod 的 refine 已经挡过一次；到这里说明调用方绕过了请求体校验，
      // 仍然要给一个可读的理由而不是 500。
      throw rejected('EMPTY_PATCH');
    case 'unknown_key':
      throw rejected('UNKNOWN_SETTING', { field: result.key });
    case 'invalid_value':
      throw rejected('INVALID_VALUE', { field: result.field, value: result.value });
    case 'out_of_range':
      throw rejected('OUT_OF_RANGE', {
        field: result.field,
        value: result.value,
        min: result.min,
        max: result.max,
      });
  }
});

/** `GET /api/v1/ops/dictionaries` */
opsSettingsRoutes.get(OPS_ROUTES.listOpsDictionaries.path, requireOpsAuth(), async (context) => {
  const code = context.req.query('code');

  const result = await callOpsRpc(
    context,
    'list_dictionaries',
    { p_code: code ?? null },
    dictionaryListEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'listOpsDictionaries', toDictionaryList(result.items));
  }

  // 「已认证但不是运营成员」：契约给的是 401/403，这里统一成 403（身份在
  // 鉴权中间件那层已经成立，缺的是成员资格）。
  throw new ApiHttpError(
    403,
    ERROR_CODES.FORBIDDEN,
    'Only an operations member can read the dictionaries',
  );
});

/** `POST /api/v1/ops/dictionaries/:code/items` */
opsSettingsRoutes.post(
  OPS_ROUTES.createOpsDictionaryItem.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'settings.manage');
    requireIdempotencyKey(context);
    const body = await parseJson(context, opsDictionaryItemCreateRequestSchema);
    const code = context.req.param('code');

    const result = await callOpsRpc(
      context,
      'create_dictionary_item',
      {
        p_code: code,
        p_value: body.value,
        p_label: body.label,
        p_sort_order: body.sortOrder ?? null,
        p_request_id: context.get('requestId'),
      },
      dictionaryItemEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'createOpsDictionaryItem', { item: toDictionaryItem(result.item) });
    }

    switch (result.status) {
      case 'dictionary_not_found':
        // 建字典没有端点，所以「码不存在」一定是拼错了——404 而不是新建。
        throw notFound('dictionary', { code: result.code });
      case 'value_required':
        throw rejected('VALUE_REQUIRED', { field: 'value' });
      case 'label_required':
        throw rejected('LABEL_REQUIRED', { field: 'label' });
      case 'duplicate_value':
        throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The dictionary value already exists', {
          reason: 'DUPLICATE_VALUE',
          value: result.value,
          itemId: result.item_id,
        });
      default:
        throw new ApiHttpError(
          503,
          ERROR_CODES.INTERNAL_ERROR,
          'The settings page returned an unexpected status',
        );
    }
  },
);

/** `PATCH /api/v1/ops/dictionary-items/:itemId` */
opsSettingsRoutes.patch(
  OPS_ROUTES.updateOpsDictionaryItem.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'settings.manage');
    const body = await parseJson(context, opsDictionaryItemUpdateRequestSchema);
    const itemId = context.req.param('itemId');

    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;
    if (body.isActive !== undefined) patch.isActive = body.isActive;

    const result = await callOpsRpc(
      context,
      'update_dictionary_item',
      { p_item_id: itemId, p_patch: patch, p_request_id: context.get('requestId') },
      dictionaryItemEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'updateOpsDictionaryItem', { item: toDictionaryItem(result.item) });
    }

    switch (result.status) {
      case 'not_found':
        throw notFound('dictionary item');
      case 'empty_patch':
        throw rejected('EMPTY_PATCH');
      case 'label_required':
        throw rejected('LABEL_REQUIRED', { field: 'label' });
      case 'invalid_value':
        throw rejected('INVALID_VALUE', { field: result.field, value: result.value });
      default:
        throw new ApiHttpError(
          503,
          ERROR_CODES.INTERNAL_ERROR,
          'The settings page returned an unexpected status',
        );
    }
  },
);
