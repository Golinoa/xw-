import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsCustomerContactCreateRequestSchema,
  opsCustomerContactUpdateRequestSchema,
  opsCustomerCreateRequestSchema,
  opsCustomerDuplicateCheckRequestSchema,
  opsCustomerListQuerySchema,
  opsCustomerTransitionRequestSchema,
  opsCustomerUpdateRequestSchema,
  type OpsCustomerContactListResponse,
  type OpsCustomerContactResponse,
  type OpsCustomerDuplicateCheckResponse,
  type OpsCustomerListQuery,
  type OpsCustomerListResponse,
  type OpsCustomerOverviewResponse,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  customerContactDeleteEnvelopeSchema,
  customerContactEnvelopeSchema,
  customerContactListEnvelopeSchema,
  customerContactUpdateEnvelopeSchema,
  customerCreateEnvelopeSchema,
  customerDetailEnvelopeSchema,
  customerDuplicateCheckEnvelopeSchema,
  customerListEnvelopeSchema,
  customerOverviewEnvelopeSchema,
  customerTransitionEnvelopeSchema,
  customerUpdateEnvelopeSchema,
  toContactView,
  toCounts,
  toCustomer,
  toCustomerListItem,
  toDuplicateCheckItem,
  toDuplicateHint,
  toImpact,
  toOverview,
} from './protocol';

export const opsCustomerRoutes = new Hono<ApiEnvironment>();

/**
 * RPC 调用与信封解析的唯一入口。
 *
 * 与 `modules/ops/accounts/routes.ts` 里的 `callOpsRpc` **同构**（同一套：用户令牌、
 * `profile: 'ops'`、上游错误翻译、zod 信封校验）。刻意没有抽成共享模块：
 * 那份实现是 accounts 的私有函数，没有导出；为了复用而把它提升成公共工具，
 * 会让「运营端 RPC 边界」这个概念的归属从一个域扩散到全仓，而两个域的失败文案
 * 与错误映射本来就不一样（账号域会把 409 说成 operator directory conflict）。
 * 两份实现的合并留给后续重构，届时用一个 `ops/rpc.ts` 承接并让两边都走它。
 *
 * 现在这样写的代价是重复约 40 行，收益是每一处翻译都能单独改、单独测；
 * 跨模块 import 一个私有 helper 才是最糟的选项——它会让 accounts 的无害重构
 * 变成 customers 的行为变更。
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
        'The customer directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The customer directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The customer directory rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The customer directory is unavailable',
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
      'The customer directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/**
 * 契约字段名 → 数据库列名。
 *
 * 和账号列表同一个坑：SQL 里按列名写 `CASE` 阶梯，把 `createdAt` 直接传下去会
 * 静默落到兜底排序，请求看起来成功、顺序却是错的。
 */
const CUSTOMER_SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
};

/**
 * 列表查询的入站解析。
 *
 * 不能用 `parseQuery()`：它读 `context.req.query()`，而 Hono 对**同名重复参数**
 * 只保留第一个值（`?status=signed&status=active` → `{status:'signed'}`）。契约要求
 * `status[]` 按重复参数传，用 `parseQuery()` 得到的结果是「筛了一半、页面显示
 * 正常」——这种问题不会报错，只会让统计对不上。
 *
 * 校验与错误形状照抄 `lib/contract.ts` 的 `parseQuery`（只回字段路径与错误类型，
 * 不回显原值），所以调用方看不出差别。单独放在这里而不是改公共函数：改公共的
 * `parseQuery` 会同时改变 30 多个既有端点的入站语义，那不该由客户域顺带完成。
 */
function parseCustomerListQuery(context: Context<ApiEnvironment>): OpsCustomerListQuery {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;

  const parsed = opsCustomerListQuerySchema.safeParse(raw);
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
 * 契约标注「必填」的幂等键，只能在这里判。
 *
 * 全局幂等中间件对**没带 key** 的请求直接放行（`if (!key) { await next(); return }`），
 * 它的职责是「带了就回放」，不是「不带就拒绝」。契约 §2.5 把创建客户、状态迁移、
 * 新建联系人划进必填范围，所以缺 key 的拒绝必须由 handler 自己做——否则这三个
 * 端点会在「客户端忘了带」时静默变成可重复提交的写操作，而那正是幂等键要防的事。
 */
function requireIdempotencyKey(context: Context<ApiEnvironment>): void {
  if (!context.req.header('Idempotency-Key')) {
    throw new ApiHttpError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'An Idempotency-Key header is required for this endpoint',
    );
  }
}

/** `GET /api/v1/ops/customers` */
opsCustomerRoutes.get(OPS_ROUTES.listOpsCustomers.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.read');
  const query = parseCustomerListQuery(context);

  const result = await callOpsRpc(
    context,
    'list_customers',
    {
      p_keyword: query.keyword ?? null,
      p_statuses: query.status ?? null,
      p_owner_operator_id: query.ownerOperatorId ?? null,
      p_contract_status: query.contractStatus ?? null,
      p_entitlement_expiring_in_days: query.entitlementExpiringInDays ?? null,
      p_sort: CUSTOMER_SORT_COLUMNS[query.sort] ?? 'created_at',
      p_order: query.order,
      p_page: query.page,
      p_page_size: query.pageSize,
    },
    customerListEnvelopeSchema,
  );

  const body: OpsCustomerListResponse = {
    items: result.items.map(toCustomerListItem),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  };
  return respond(context, 'listOpsCustomers', body);
});

/**
 * `POST /api/v1/ops/customers`
 *
 * 同名/同信用代码**不阻断**：返回 `duplicateHints` 让前端提示，判定与合并是人的事
 * （§3.1「不自动合并」）。真正会 409 的只有编号冲突，而编号由序列生成——
 * 也就是说这条 409 是「序列重号」而不是「你填重了」。
 */
opsCustomerRoutes.post(OPS_ROUTES.createOpsCustomer.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.write');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsCustomerCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_customer',
    {
      p_name: body.name,
      p_unified_social_credit_code: body.unifiedSocialCreditCode ?? null,
      p_region_code: body.regionCode ?? null,
      p_source_note: body.sourceNote ?? null,
      p_internal_note: body.internalNote ?? null,
      p_owner_operator_id: body.ownerOperatorId ?? null,
      // 内嵌联系人的键名用 snake_case：这条 jsonb 是**入站**给 SQL 的，
      // 与出站同一套列名口径。传空数组而不是 null，是让「没带联系人」与
      // 「带了空列表」在库里是同一件事（都插 0 行），少一个 NULL 分支。
      p_contacts: (body.contacts ?? []).map((contact) => ({
        name: contact.name,
        job_title: contact.jobTitle ?? null,
        phone: contact.phone ?? null,
        email: contact.email ?? null,
        is_primary: contact.isPrimary ?? false,
        usage_scene: contact.usageScene ?? null,
      })),
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    customerCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsCustomer',
      {
        customer: toCustomer(result.customer),
        duplicateHints: result.duplicate_hints.map(toDuplicateHint),
      },
      201,
    );
  }

  switch (result.status) {
    case 'customer_no_conflict':
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The customer number is already taken', {
        field: 'customerNo',
      });
    case 'unknown_owner':
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The owner operator does not exist',
        {
          field: 'ownerOperatorId',
          ownerOperatorId: result.owner_operator_id,
        },
      );
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The customer was rejected');
  }
});

/**
 * `POST /api/v1/ops/customers/duplicate-check`
 *
 * 权限是 `customer.read` 而不是 `customer.write`：表单在用户还没提交之前就要查重，
 * 只读账号同样需要。写权限放在这里会让「能看不能建」的人连输入提示都没有。
 */
opsCustomerRoutes.post(
  OPS_ROUTES.checkOpsCustomerDuplicates.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'customer.read');
    const body = await parseJson(context, opsCustomerDuplicateCheckRequestSchema);

    const result = await callOpsRpc(
      context,
      'check_customer_duplicates',
      {
        p_name: body.name,
        p_unified_social_credit_code: body.unifiedSocialCreditCode ?? null,
      },
      customerDuplicateCheckEnvelopeSchema,
    );

    const response: OpsCustomerDuplicateCheckResponse = {
      items: result.items.map(toDuplicateCheckItem),
    };
    return respond(context, 'checkOpsCustomerDuplicates', response);
  },
);

/**
 * `GET /api/v1/ops/customers/{customerId}`
 *
 * 联系人的原值键由库里 `has_permission('customer.sensitive.read')` 决定是否返回，
 * Worker 原样透传（`toContactView` 只看键在不在）。这里**不做** `customer.sensitive.read`
 * 判定：Worker 手里的 `opsContext.permissions` 与库里那份是同一份数据的两个快照，
 * 在这里再判一次就多了一条会与库不一致的实现，而失败形态是「有权限的人看到掩码」
 * 或反过来。
 */
opsCustomerRoutes.get(OPS_ROUTES.getOpsCustomer.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.read');
  const params = parseParams(context, z.object({ customerId: z.string().min(1) }));

  const result = await callOpsRpc(
    context,
    'get_customer',
    { p_customer_id: params.customerId },
    customerDetailEnvelopeSchema,
  );

  if (result.status === 'not_found') {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
  }

  return respond(context, 'getOpsCustomer', {
    customer: toCustomer(result.customer),
    contacts: result.contacts.map(toContactView),
    counts: toCounts(result.counts),
  });
});

/**
 * `PATCH /api/v1/ops/customers/{customerId}`
 *
 * 契约给这个端点的幂等标注是「可选」，所以不强制 `Idempotency-Key`；但带了就由
 * 全局中间件回放。乐观锁是必填的 `version`——「可选」指的是幂等，不是版本。
 */
opsCustomerRoutes.patch(OPS_ROUTES.updateOpsCustomer.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.write');
  const params = parseParams(context, z.object({ customerId: z.string().min(1) }));
  const body = await parseJson(context, opsCustomerUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_customer',
    {
      p_customer_id: params.customerId,
      p_expected_version: body.version,
      p_name: body.name ?? null,
      p_unified_social_credit_code: body.unifiedSocialCreditCode ?? null,
      p_region_code: body.regionCode ?? null,
      p_source_note: body.sourceNote ?? null,
      p_internal_note: body.internalNote ?? null,
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    customerUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsCustomer', { customer: toCustomer(result.customer) });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The customer was modified by someone else',
        {
          currentVersion: result.current_version,
        },
      );
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The update was rejected');
  }
});

/**
 * `POST /api/v1/ops/customers/{customerId}/transition`
 *
 * 四种 409 必须分开：它们要求下一步动作不同。
 *   - `CONFLICT` + `currentVersion`：有人先改了，刷新重试；
 *   - `STATE_CONFLICT` + `INVALID_TRANSITION`：这条边不存在（或当前状态不允许），
 *     要刷新详情看当前状态；
 *   - `STATE_CONFLICT` + `CONTACTS_REQUIRED`：先补联系人，不是刷新能解决的；
 *   - `OBJECT_REFERENCED` + `impact`：被合同/授权/工单/部署引用，要先去处理那些。
 */
opsCustomerRoutes.post(OPS_ROUTES.transitionOpsCustomer.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.write');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ customerId: z.string().min(1) }));
  const body = await parseJson(context, opsCustomerTransitionRequestSchema);

  const result = await callOpsRpc(
    context,
    'transition_customer',
    {
      p_customer_id: params.customerId,
      p_action: body.action,
      p_reason: body.reason,
      p_expected_version: body.version,
      p_request_id: context.get('requestId'),
    },
    customerTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsCustomer', {
      customer: { status: result.customer.status, version: result.customer.version },
      impact: toImpact(result.impact),
    });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The customer was modified by someone else',
        { currentVersion: result.current_version },
      );
    case 'invalid_transition':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'The customer status does not allow this action',
        { reason: 'INVALID_TRANSITION' },
      );
    case 'contacts_required':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'The customer needs at least one contact before onboarding',
        { reason: 'CONTACTS_REQUIRED' },
      );
    case 'referenced':
      // impact 只放计数，不放明细：确认弹窗要说的是「会影响什么量级」，
      // 明细在各自域的端点上，塞进 details 会让一个错误响应变成跨域查询结果。
      throw new ApiHttpError(
        409,
        ERROR_CODES.OBJECT_REFERENCED,
        'The customer is still referenced by active records',
        { impact: toImpact(result.impact) },
      );
    default:
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The transition was rejected');
  }
});

/** `GET /api/v1/ops/customers/{customerId}/overview` */
opsCustomerRoutes.get(OPS_ROUTES.getOpsCustomerOverview.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'customer.read');
  const params = parseParams(context, z.object({ customerId: z.string().min(1) }));

  const result = await callOpsRpc(
    context,
    'customer_overview',
    { p_customer_id: params.customerId },
    customerOverviewEnvelopeSchema,
  );

  if (result.status === 'not_found') {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
  }

  const body: OpsCustomerOverviewResponse = toOverview(result);
  return respond(context, 'getOpsCustomerOverview', body);
});

/** `GET /api/v1/ops/customers/{customerId}/contacts` */
opsCustomerRoutes.get(
  OPS_ROUTES.listOpsCustomerContacts.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'customer.read');
    const params = parseParams(context, z.object({ customerId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'list_customer_contacts',
      { p_customer_id: params.customerId },
      customerContactListEnvelopeSchema,
    );

    if (result.status === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
    }

    const body: OpsCustomerContactListResponse = { items: result.items.map(toContactView) };
    return respond(context, 'listOpsCustomerContacts', body);
  },
);

/** `POST /api/v1/ops/customers/{customerId}/contacts` */
opsCustomerRoutes.post(
  OPS_ROUTES.createOpsCustomerContact.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'customer.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ customerId: z.string().min(1) }));
    const body = await parseJson(context, opsCustomerContactCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_customer_contact',
      {
        p_customer_id: params.customerId,
        p_name: body.name,
        p_job_title: body.jobTitle ?? null,
        p_phone: body.phone ?? null,
        p_email: body.email ?? null,
        // `null` = 用库默认值（false），而不是把「没传」当成「明确设成 false」。
        p_is_primary: body.isPrimary ?? null,
        p_usage_scene: body.usageScene ?? null,
        p_reason: body.reason,
        p_request_id: context.get('requestId'),
      },
      customerContactEnvelopeSchema,
    );

    if (result.status === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The customer does not exist');
    }

    const response: OpsCustomerContactResponse = { contact: toContactView(result.contact) };
    return respond(context, 'createOpsCustomerContact', response, 201);
  },
);

/** `PATCH /api/v1/ops/customers/{customerId}/contacts/{contactId}` */
opsCustomerRoutes.patch(
  OPS_ROUTES.updateOpsCustomerContact.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'customer.write');
    const params = parseParams(
      context,
      z.object({ customerId: z.string().min(1), contactId: z.string().min(1) }),
    );
    const body = await parseJson(context, opsCustomerContactUpdateRequestSchema);

    const result = await callOpsRpc(
      context,
      'update_customer_contact',
      {
        p_customer_id: params.customerId,
        p_contact_id: params.contactId,
        p_expected_version: body.version,
        p_name: body.name ?? null,
        p_job_title: body.jobTitle ?? null,
        p_phone: body.phone ?? null,
        p_email: body.email ?? null,
        p_is_primary: body.isPrimary ?? null,
        p_usage_scene: body.usageScene ?? null,
        p_reason: body.reason,
        p_request_id: context.get('requestId'),
      },
      customerContactUpdateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      const response: OpsCustomerContactResponse = { contact: toContactView(result.contact) };
      return respond(context, 'updateOpsCustomerContact', response);
    }

    switch (result.status) {
      case 'not_found':
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The contact does not exist');
      case 'version_mismatch':
        throw new ApiHttpError(
          409,
          ERROR_CODES.CONFLICT,
          'The contact was modified by someone else',
          {
            currentVersion: result.current_version,
          },
        );
      default:
        throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The update was rejected');
    }
  },
);

/**
 * `DELETE /api/v1/ops/customers/{customerId}/contacts/{contactId}`
 *
 * `p_reason` 传 `null`：契约 §5.2 的 DELETE 行**没有**请求字段（没有 reason，
 * 也没有 body），而约定的 RPC 签名要求一个 `p_reason`。这里如实传「没有理由」，
 * 不自造一句写死的审计文案——固定字符串会让人以为每次删除都有登记过理由。
 * 这个不对称（RPC 要 reason、HTTP 层没有入口）已记入交付报告，等主会话与 S1 裁定：
 * 要么把该参数改成可选，要么给 DELETE 一个 query 参数。
 */
opsCustomerRoutes.delete(
  OPS_ROUTES.deleteOpsCustomerContact.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'customer.write');
    const params = parseParams(
      context,
      z.object({ customerId: z.string().min(1), contactId: z.string().min(1) }),
    );

    const result = await callOpsRpc(
      context,
      'delete_customer_contact',
      {
        p_customer_id: params.customerId,
        p_contact_id: params.contactId,
        p_reason: null,
        p_request_id: context.get('requestId'),
      },
      customerContactDeleteEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'deleteOpsCustomerContact', {
        deletedContactId: result.deleted_contact_id,
      });
    }

    switch (result.status) {
      case 'not_found':
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The contact does not exist');
      case 'last_primary':
        throw new ApiHttpError(
          409,
          ERROR_CODES.STATE_CONFLICT,
          'The only contact of a non-terminated customer cannot be removed',
          { reason: 'LAST_PRIMARY_CONTACT' },
        );
      default:
        throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The deletion was rejected');
    }
  },
);
