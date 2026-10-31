import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_CONTRACT_ATTACHMENT_MAX_BYTES,
  OPS_ROUTES,
  opsContractAmendmentCreateRequestSchema,
  opsContractAmendmentTransitionRequestSchema,
  opsContractAttachmentCompleteRequestSchema,
  opsContractAttachmentCreateRequestSchema,
  opsContractCreateRequestSchema,
  opsContractListQuerySchema,
  opsContractRenewalRequestSchema,
  opsContractTransitionRequestSchema,
  opsContractUpdateRequestSchema,
  type OpsContractItemInput,
  type OpsContractListQuery,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import {
  StorageSignError,
  createSignedDownload,
  createSignedUpload,
  headStorageObject,
} from '../storage/sign';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  contractAmendmentCreateEnvelopeSchema,
  contractAmendmentTransitionEnvelopeSchema,
  contractAttachmentAccessEnvelopeSchema,
  contractAttachmentCompleteEnvelopeSchema,
  contractAttachmentCreateEnvelopeSchema,
  contractAttachmentListEnvelopeSchema,
  contractAttachmentLocationEnvelopeSchema,
  contractCreateEnvelopeSchema,
  contractDetailEnvelopeSchema,
  contractEntitlementPreviewEnvelopeSchema,
  contractListEnvelopeSchema,
  contractRenewalEnvelopeSchema,
  contractTransitionEnvelopeSchema,
  contractUpdateEnvelopeSchema,
  contractVersionListEnvelopeSchema,
  toContract,
  toContractAmendment,
  toContractAttachment,
  toContractItem,
  toContractVersion,
  toEntitlementFeature,
  toEntitlementWarning,
  toImpact,
} from './protocol';

/**
 * 合同域（契约 §5.4 的十四个端点）。
 *
 * 三件与客户域 / catalog 不同、照抄那两处就会错的事，先写在这里：
 *
 * 1. **没有 `p_request_id`**：本域十四个 RPC 的签名（§3）里都没有这个参数，
 *    PostgREST 收到未声明的参数会判「函数不存在」（404），整条端点直接不可用。
 *    审计的 requestId 由库侧 `ops.write_audit` 自己取，不需要调用方传。
 * 2. **条目的 `p_items` 是驼峰**（`packageId` / `priceVersionId` / `unitPrice`），
 *    与出站 snake_case 相反：`ops.contract_items_normalize` 按 §4 的入参名读。
 * 3. **附件的最后两条不在 `/contracts/{id}/` 下**（§5.4 第 13、14 条），
 *    前缀写成 `/contracts/...` 就是 404，类型系统抓不到。
 */
export const opsContractRoutes = new Hono<ApiEnvironment>();

/**
 * RPC 调用与信封解析的唯一入口。
 *
 * 与客户域 / catalog 里的两份 `callOpsRpc` 同构（用户令牌、`profile: 'ops'`、
 * 上游错误翻译、zod 信封校验）。同样刻意没有抽公共工具：三个域的失败文案与
 * 错误映射本来就不同（这里会说 contract directory），抽出去之后每一次文案调整
 * 都会变成跨域变更。合并留给后续的 `ops/rpc.ts` 重构。
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
        'The contract directory reported a conflict',
      );
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The contract directory refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The contract directory rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The contract directory is unavailable',
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
      'The contract directory returned an unexpected shape',
    );
  }
  return parsed.data;
}

/**
 * 列表查询的入站解析。
 *
 * 不能用 `parseQuery()`：它读 `context.req.query()`，而 Hono 对**同名重复参数**
 * 只保留第一个值（`?status=active&status=signed` → `{status:'active'}`）。本域的
 * `p_statuses` 是数组，用 `parseQuery()` 的结果是「筛了一半、页面显示正常」。
 * 校验与错误形状照抄 `lib/contract.ts` 的 `parseQuery`（只回字段路径与错误类型）。
 */
function parseContractListQuery(context: Context<ApiEnvironment>): OpsContractListQuery {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;

  const parsed = opsContractListQuerySchema.safeParse(raw);
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
 * 全局幂等中间件对**没带 key** 的请求直接放行（职责是「带了就回放」，不是
 * 「不带就拒绝」）。§5.4 的幂等列里，十四个端点只有六个 GET 是「—」，其余八个
 * 全是「必填」——包括 `PATCH /contracts/{id}`（客户域与 catalog 的 PATCH 都是
 * 「可选」，照抄那里会漏掉这一条）。缺键的拒绝必须由 handler 自己做，否则客户端
 * 忘了带时，这八个写端点会静默变成可重复提交的写操作。
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

/** 唯一性冲突：409 + `{field}`，前端据此把错误挂到对应输入框上。 */
function conflict(field: string): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The value is already taken', { field });
}

/** 并发冲突：`details.currentVersion` 是刷新后要让用户看到的那个版本号。 */
function versionConflict(currentVersion: number): ApiHttpError {
  return new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The contract was modified by someone else', {
    currentVersion,
  });
}

/**
 * 业务校验失败：400 + `{reason}`。
 *
 * 与 409 分家的理由：这些不是「和库里的数据打架」，而是「这次请求本身不成立」
 * （客户还没签约、套餐的销售方式没开、给了价又和价格版本不一致）。前端应该改
 * 表单，不是刷新后重试。
 */
function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The contract request was rejected', {
    reason,
    ...details,
  });
}

/**
 * 状态冲突：409 `STATE_CONFLICT` + `{reason, …}`。
 *
 * 三种都用它，但 `reason` 不同——前端据此决定是「刷新看当前状态」
 * （`INVALID_TRANSITION`）、还是「这份合同已经不能改了」（`CONTRACT_IMMUTABLE`）、
 * 还是「还没到续约时间」（`RENEWAL_NOT_DUE`）。
 */
function stateConflict(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(
    409,
    ERROR_CODES.STATE_CONFLICT,
    'The contract state does not allow this',
    {
      reason,
      ...details,
    },
  );
}

/** 资源不存在：404 + `{resource}`。四个 404 的来源不同，前端据此决定提示语。 */
function missing(resource: 'customer' | 'contract' | 'amendment' | 'attachment'): ApiHttpError {
  return new ApiHttpError(404, ERROR_CODES.NOT_FOUND, `The ${resource} does not exist`, {
    resource,
  });
}

/**
 * `contract_immutable` 的当前状态。
 *
 * §2 把信封写成 `{status:'contract_immutable', status:<当前>}`——同一个对象里两个
 * `status` 键，JSON 里后者会覆盖前者、整个信封就没了标签。DB 侧必然要换一个键名，
 * 而规格没写换成什么，所以这里同时认 `current` 与 `current_status`，取到哪个用哪个；
 * 两个都没有时 `details` 不带 `status`（宁可少一个字段，也不要编一个假状态）。
 * 这一条已记入交付报告的「规格说不通」清单。
 */
function immutableStatus(result: {
  current?: string | null;
  current_status?: string | null;
}): string | null {
  return result.current ?? result.current_status ?? null;
}

/**
 * 合同条目 → RPC 的 `p_items`。
 *
 * 键名是**驼峰**，与出站 snake_case 相反：`ops.contract_items_normalize` 读的是
 * `element ->> 'packageId'` / `'priceVersionId'` / `'unitPrice'`（规格 §4 的入参
 * 就叫这几个名字），传列名口径会让每个引用都变成 null，条目静默变成
 * 「1 × 0 元的无名行」——金额算出来是 0，而这一步没有任何错误。
 *
 * **不带 `amount`**（§4：金额由 SQL 重算）。`quantity` 缺省传 `null` 让库用默认
 * 值 1，而不是在这里替用户决定。
 */
function itemPayload(items: readonly OpsContractItemInput[]) {
  return items.map((item) => ({
    productId: item.productId ?? null,
    packageId: item.packageId ?? null,
    priceVersionId: item.priceVersionId ?? null,
    quantity: item.quantity ?? null,
    unitPrice: item.unitPrice ?? null,
    termMonths: item.termMonths ?? null,
  }));
}

/**
 * 存储不可用 → 503。
 *
 * 不用 500：500 说的是「这段代码有 bug」，503 说的是「依赖暂时不可用」，
 * 客户端的处置完全不同（重试 vs 报障）。错误码沿用既有约定。
 */
function storageUnavailable(cause: unknown): ApiHttpError {
  const detail = cause instanceof StorageSignError ? cause.detail : {};
  return new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'Object storage is unavailable', {
    ...detail,
    reason: 'STORAGE_UNAVAILABLE',
  });
}

// 签名 URL 的拼装搬到 `modules/ops/storage/sign.ts` 了。原因不是「文件太长」，
// 而是原来那一段**自己拼 token**：`crypto.randomUUID()` 当签名值，Supabase
// 一律 400。它在本地的桩里永远绿，在线上永远失败。签名必须由存储签。

/** `GET /api/v1/ops/contracts` */
opsContractRoutes.get(OPS_ROUTES.listOpsContracts.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'contract.read');
  const query = parseContractListQuery(context);

  const result = await callOpsRpc(
    context,
    'list_contracts',
    {
      // 空串等价于「没筛」：传 `''` 到库里会变成 `ILIKE '%%'`，结果相同但多一次扫描。
      p_keyword: query.keyword || null,
      p_customer_id: query.customerId ?? null,
      p_statuses: query.status ?? null,
      p_owner: query.ownerOperatorId ?? null,
      p_expires_from: query.expiresFrom ?? null,
      p_expires_to: query.expiresTo ?? null,
      p_sales_mode: query.salesMode ?? null,
      p_page: query.page,
      p_page_size: query.pageSize,
    },
    contractListEnvelopeSchema,
  );

  return respond(context, 'listOpsContracts', {
    items: result.items.map(toContract),
    total: result.total,
    page: query.page,
    pageSize: query.pageSize,
  });
});

/** `POST /api/v1/ops/contracts` */
opsContractRoutes.post(OPS_ROUTES.createOpsContract.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'contract.write');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsContractCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_contract',
    {
      p_customer_id: body.customerId,
      p_sales_mode: body.salesMode,
      p_currency: body.currency ?? null,
      p_payment_terms: body.paymentTerms ?? null,
      p_tax_note: body.taxNote ?? null,
      p_business_note: body.businessNote ?? null,
      p_items: itemPayload(body.items),
    },
    contractCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'createOpsContract', { contract: toContract(result.contract) }, 201);
  }

  switch (result.status) {
    case 'customer_not_found':
      throw missing('customer');
    case 'items_required':
      throw rejected('ITEMS_REQUIRED', { field: 'items' });
    case 'price_mismatch':
      throw rejected('PRICE_MISMATCH');
    case 'sales_mode_disabled':
      throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
    case 'contract_no_conflict':
      throw conflict('contractNo');
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/contracts/{contractId}` */
opsContractRoutes.get(OPS_ROUTES.getOpsContract.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'contract.read');
  const params = parseParams(context, z.object({ contractId: z.string().min(1) }));

  const result = await callOpsRpc(
    context,
    'get_contract',
    { p_contract_id: params.contractId },
    contractDetailEnvelopeSchema,
  );

  if (result.status === 'contract_not_found') {
    throw missing('contract');
  }

  return respond(context, 'getOpsContract', {
    contract: toContract(result.contract),
    items: result.items.map(toContractItem),
    // 应收域（T-07）没落地时是 `null`：没有摘要 ≠ 摘要全为 0。
    receivableSummary: result.receivable_summary ?? null,
    receivables: result.receivables,
    subscriptions: result.subscriptions,
    licenses: result.licenses,
    attachments: result.attachments.map(toContractAttachment),
  });
});

/**
 * `PATCH /api/v1/ops/contracts/{contractId}`
 *
 * 契约 §5.4 的幂等列对这条 PATCH 也是「必填」——与客户域、catalog 的 PATCH
 * （「可选」）不同，照抄那两处就会漏掉这一个 400。
 *
 * `p_items_provided` 显式传布尔而不是「`p_items` 为 null 就当没传」：`[]` 是
 * 「删光条目」，`null` 是「不动条目」，用 null 表达两件事会让「清空」永远做不到。
 */
opsContractRoutes.patch(OPS_ROUTES.updateOpsContract.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'contract.write');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ contractId: z.string().min(1) }));
  const body = await parseJson(context, opsContractUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_contract',
    {
      p_contract_id: params.contractId,
      p_expected_version: body.version,
      // 空串表示清空（与 catalog 同约定）；`undefined` → null = 不改。
      p_payment_terms: body.paymentTerms ?? null,
      p_tax_note: body.taxNote ?? null,
      p_business_note: body.businessNote ?? null,
      p_expires_on: body.expiresOn ?? null,
      p_items: body.items === undefined ? null : itemPayload(body.items),
      p_items_provided: body.items !== undefined,
    },
    contractUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsContract', { contract: toContract(result.contract) });
  }

  switch (result.status) {
    case 'contract_not_found':
      throw missing('contract');
    case 'version_mismatch':
      throw versionConflict(result.current_version);
    case 'contract_immutable': {
      const current = immutableStatus(result);
      throw stateConflict('CONTRACT_IMMUTABLE', current === null ? {} : { status: current });
    }
    case 'price_mismatch':
      throw rejected('PRICE_MISMATCH');
    case 'sales_mode_disabled':
      throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
    case 'items_required':
      throw rejected('ITEMS_REQUIRED', { field: 'items' });
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/**
 * `POST /api/v1/ops/contracts/{contractId}/transition`
 *
 * 权限按动作分档（§2）：`submit`/`withdraw` 是 `contract.write`，`sign`/`activate`/
 * `terminate`/`expire` 是 `contract.approve`。不按状态分、也不一律要 approve：
 * 「改草稿」与「批准签署」是两类人的职责，写成一个码等于把审批权发给所有能建单的人。
 *
 * 四种 409 必须分开：`CONFLICT + currentVersion`（刷新重试）、
 * `STATE_CONFLICT + INVALID_TRANSITION`（这条边不存在，带当前状态与动作）、
 * `OBJECT_REFERENCED + impact`（先去处理应收/权益/租户命令）。
 */
const CONTRACT_APPROVAL_ACTIONS = new Set(['sign', 'activate', 'terminate', 'expire']);

opsContractRoutes.post(OPS_ROUTES.transitionOpsContract.path, requireOpsAuth(), async (context) => {
  const params = parseParams(context, z.object({ contractId: z.string().min(1) }));
  const body = await parseJson(context, opsContractTransitionRequestSchema);
  requireOpsPermission(
    context,
    CONTRACT_APPROVAL_ACTIONS.has(body.action) ? 'contract.approve' : 'contract.write',
  );
  requireIdempotencyKey(context);

  const result = await callOpsRpc(
    context,
    'transition_contract',
    {
      p_contract_id: params.contractId,
      p_action: body.action,
      p_reason: body.reason,
      p_signed_on: body.signedOn ?? null,
      p_effective_on: body.effectiveOn ?? null,
      // 默认 false：终止是有副作用的动作，必须显式确认。
      p_confirm_impact: body.confirmImpact ?? false,
      p_expected_version: body.version,
    },
    contractTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsContract', {
      contract: { status: result.contract.status, version: result.contract.version },
      impact: toImpact(result.impact),
      // 只有 `activate` 会写新快照；其余动作这里是 null。
      ...(result.created_version_no ? { createdVersionNo: result.created_version_no } : {}),
    });
  }

  switch (result.status) {
    case 'contract_not_found':
      throw missing('contract');
    case 'customer_not_found':
      // `submit` 校验客户资格时客户行已经不在了（并发终止/删除后的极端情形）。
      throw missing('customer');
    case 'version_mismatch':
      throw versionConflict(result.current_version);
    case 'invalid_transition':
      throw stateConflict('INVALID_TRANSITION', {
        current: result.current,
        action: result.action,
      });
    case 'referenced':
      // impact 只放计数：确认弹窗要说「会影响什么量级」，明细在各自域的端点上。
      throw new ApiHttpError(
        409,
        ERROR_CODES.OBJECT_REFERENCED,
        'The contract is still referenced by active records',
        { impact: toImpact(result.impact) },
      );
    case 'customer_not_eligible':
      throw rejected('CUSTOMER_NOT_ELIGIBLE');
    case 'sales_mode_disabled':
      throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
    case 'items_required':
      throw rejected('ITEMS_REQUIRED', { field: 'items' });
    case 'total_mismatch':
      throw rejected('TOTAL_MISMATCH');
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/contracts/{contractId}/versions` */
opsContractRoutes.get(
  OPS_ROUTES.listOpsContractVersions.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.read');
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'list_contract_versions',
      { p_contract_id: params.contractId },
      contractVersionListEnvelopeSchema,
    );

    if (result.status === 'contract_not_found') {
      throw missing('contract');
    }

    return respond(context, 'listOpsContractVersions', {
      items: result.items.map(toContractVersion),
    });
  },
);

/**
 * `POST /api/v1/ops/contracts/{contractId}/amendments`
 *
 * `p_header_provided` / `p_items_provided` 分开传：变更单可以只改条目、也可以只改
 * 头字段，`{}` 与 `null` 在这里分别是「这次不动头字段」与「这次把头字段改成空」。
 */
opsContractRoutes.post(
  OPS_ROUTES.createOpsContractAmendment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));
    const body = await parseJson(context, opsContractAmendmentCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_contract_amendment',
      {
        p_contract_id: params.contractId,
        p_reason: body.reason,
        p_header:
          body.header === undefined
            ? null
            : {
                // 驼峰：变更单的 before/after 摘要就是这个形状（§4 的快照口径），
                // `apply` 时照着重放，混进 snake_case 会让那四列全部变成「不改」。
                paymentTerms: body.header.paymentTerms ?? null,
                taxNote: body.header.taxNote ?? null,
                businessNote: body.header.businessNote ?? null,
                expiresOn: body.header.expiresOn ?? null,
              },
        p_items: body.items === undefined ? null : itemPayload(body.items),
        p_header_provided: body.header !== undefined,
        p_items_provided: body.items !== undefined,
      },
      contractAmendmentCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsContractAmendment',
        { amendment: toContractAmendment(result.amendment) },
        201,
      );
    }

    switch (result.status) {
      case 'contract_not_found':
        throw missing('contract');
      case 'amendment_conflict':
        throw conflict('amendment');
      case 'contract_immutable': {
        const current = immutableStatus(result);
        throw stateConflict('CONTRACT_IMMUTABLE', current === null ? {} : { status: current });
      }
      case 'items_required':
        throw rejected('ITEMS_REQUIRED', { field: 'items' });
      case 'price_mismatch':
        throw rejected('PRICE_MISMATCH');
      case 'sales_mode_disabled':
        throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/**
 * `POST /api/v1/ops/contracts/{contractId}/amendments/{amendmentId}/transition`
 *
 * `contractId` 由 RPC 校验归属：`ops.transition_contract_amendment` 收
 * `p_contract_id`，与变更单的 `contract_id` 不符时返回 `amendment_not_found`（404）。
 * 不校验的话这条路径会「成功」但作用在另一张合同上，审计里的合同 id 就记错了。
 * 归属不符按「不存在」处理，不区分「不存在」与「不属于这份合同」——区分等于
 * 允许用别的合同 id 探测变更单是否存在。
 *
 * 权限：`submit` 是提交人（`contract.write`），`approve`/`reject`/`apply` 是审批人
 * （`contract.approve`）。
 */
const AMENDMENT_APPROVAL_ACTIONS = new Set(['approve', 'reject', 'apply']);

opsContractRoutes.post(
  OPS_ROUTES.transitionOpsContractAmendment.path,
  requireOpsAuth(),
  async (context) => {
    const params = parseParams(
      context,
      z.object({ contractId: z.string().min(1), amendmentId: z.string().min(1) }),
    );
    const body = await parseJson(context, opsContractAmendmentTransitionRequestSchema);
    requireOpsPermission(
      context,
      AMENDMENT_APPROVAL_ACTIONS.has(body.action) ? 'contract.approve' : 'contract.write',
    );
    requireIdempotencyKey(context);

    const result = await callOpsRpc(
      context,
      'transition_contract_amendment',
      {
        p_contract_id: params.contractId,
        p_amendment_id: params.amendmentId,
        p_action: body.action,
        p_reason: body.reason,
        p_expected_version: body.version,
      },
      contractAmendmentTransitionEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'transitionOpsContractAmendment', {
        amendment: { status: result.amendment.status, version: result.amendment.version },
        // 只有 `apply` 写新快照。
        ...(result.created_version_no ? { createdVersionNo: result.created_version_no } : {}),
      });
    }

    switch (result.status) {
      case 'amendment_not_found':
        throw missing('amendment');
      case 'version_mismatch':
        throw versionConflict(result.current_version);
      /**
       * 职责分离：申请人不能批自己那张（`reason: 'SELF_APPROVAL'`）。`details` 在
       * §7 的 `{field:'amendment'}` 之外附上 reason——前端要说的不是「变更单有冲突」，
       * 而是「这张单是你自己提交的」，少这一句用户只会反复点同一个按钮。
       */
      case 'amendment_conflict': {
        const details: Record<string, unknown> = { field: 'amendment' };
        if (result.reason) details.reason = result.reason;
        throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The amendment conflicts', details);
      }
      case 'contract_not_found':
        throw missing('contract');
      case 'invalid_transition':
        throw stateConflict('INVALID_TRANSITION', {
          current: result.current,
          action: result.action,
        });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/**
 * `POST /api/v1/ops/contracts/{contractId}/renewals`
 *
 * 续约建**新**合同（`draft`），原合同不动（§4），所以 201 回的是新合同。
 * `force` 越过 `renewal_not_due`：提前续约合法，但不该是默认行为。
 */
opsContractRoutes.post(
  OPS_ROUTES.createOpsContractRenewal.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));
    const body = await parseJson(context, opsContractRenewalRequestSchema);

    const result = await callOpsRpc(
      context,
      'renew_contract',
      {
        p_contract_id: params.contractId,
        p_effective_on: body.effectiveOn,
        p_expires_on: body.expiresOn,
        // `undefined` → null = 沿用原合同条目（库负责复制）；`[]` = 新合同没有条目。
        p_items: body.items === undefined ? null : itemPayload(body.items),
        p_reason: body.reason,
        p_force: body.force ?? false,
      },
      contractRenewalEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsContractRenewal',
        { contract: toContract(result.contract) },
        201,
      );
    }

    switch (result.status) {
      case 'contract_not_found':
        throw missing('contract');
      case 'customer_not_found':
        throw missing('customer');
      case 'renewal_not_due':
        throw stateConflict('RENEWAL_NOT_DUE');
      case 'invalid_transition':
        // `draft`/`reviewing` 的合同还没有生效过，续约没有意义（`action: 'renew'`）。
        throw stateConflict('INVALID_TRANSITION', {
          current: result.current,
          action: result.action,
        });
      case 'contract_no_conflict':
        throw conflict('contractNo');
      case 'customer_not_eligible':
        throw rejected('CUSTOMER_NOT_ELIGIBLE');
      case 'items_required':
        throw rejected('ITEMS_REQUIRED', { field: 'items' });
      case 'price_mismatch':
        throw rejected('PRICE_MISMATCH');
      case 'sales_mode_disabled':
        throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/** `GET /api/v1/ops/contracts/{contractId}/entitlement-preview` */
opsContractRoutes.get(
  OPS_ROUTES.getOpsContractEntitlementPreview.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.read');
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'contract_entitlement_preview',
      { p_contract_id: params.contractId },
      contractEntitlementPreviewEnvelopeSchema,
    );

    if (result.status === 'contract_not_found') {
      throw missing('contract');
    }

    return respond(context, 'getOpsContractEntitlementPreview', {
      features: result.features.map(toEntitlementFeature),
      warnings: result.warnings.map(toEntitlementWarning),
    });
  },
);

/** `GET /api/v1/ops/contracts/{contractId}/attachments` */
opsContractRoutes.get(
  OPS_ROUTES.listOpsContractAttachments.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.read');
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'list_contract_attachments',
      { p_contract_id: params.contractId },
      contractAttachmentListEnvelopeSchema,
    );

    if (result.status === 'contract_not_found') {
      throw missing('contract');
    }

    return respond(context, 'listOpsContractAttachments', {
      items: result.items.map(toContractAttachment),
    });
  },
);

/**
 * `POST /api/v1/ops/contracts/{contractId}/attachments`
 *
 * 只申请一次上传（返回 `status='pending'` 的附件行 + 上传地址），不传字节；
 * 上传完成由 `/contract-attachments/{id}/complete` 确认。
 *
 * 上传地址在这里拼、**不直连 Storage**（§8）：本地 shim 没有 Storage，而且签名
 * 地址的基址属于部署环境，不属于库。
 */
opsContractRoutes.post(
  OPS_ROUTES.createOpsContractAttachment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ contractId: z.string().min(1) }));
    const body = await parseJson(context, opsContractAttachmentCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_contract_attachment',
      {
        p_contract_id: params.contractId,
        p_file_name: body.fileName,
        p_content_type: body.contentType,
        p_byte_size: body.byteSize,
      },
      contractAttachmentCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      const attachment = toContractAttachment(result.attachment);
      // 元数据已经落库（状态 pending），但拿不到签名时回 503 而不是 201：
      // 一个点不开的上传地址会让客户端以为「传过了」，而对象从来没有到存储里。
      const signed = await createSignedUpload(context.env, attachment.storagePath).catch(
        (cause) => {
          throw storageUnavailable(cause);
        },
      );
      return respond(context, 'createOpsContractAttachment', { attachment, ...signed }, 201);
    }

    switch (result.status) {
      case 'contract_not_found':
        throw missing('contract');
      case 'attachment_too_large':
        throw rejected('ATTACHMENT_TOO_LARGE', {
          // 库没回上限时用契约常量兜底：前端要显示「超过 25 MB」，不是「太大了」。
          maxBytes: result.max_bytes ?? OPS_CONTRACT_ATTACHMENT_MAX_BYTES,
        });
      case 'attachment_type_rejected':
        throw rejected('ATTACHMENT_TYPE_REJECTED');
      case 'items_required':
        // 文件名为空走这一条（词表里没有 attachment_name_required）：字段名照库里回。
        throw rejected('ITEMS_REQUIRED', { field: result.field ?? 'fileName' });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/**
 * `POST /api/v1/ops/contract-attachments/{attachmentId}/complete`
 *
 * 前缀**不在** `/contracts/{id}/` 下（§5.4 第 13 条）。200 而不是 201：
 * 它不是「新建一个东西」，是把已有行从 `pending` 推到 `stored`。
 */
opsContractRoutes.post(
  OPS_ROUTES.completeOpsContractAttachment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ attachmentId: z.string().min(1) }));
    const body = await parseJson(context, opsContractAttachmentCompleteRequestSchema);

    // 先确认对象真的在存储里，再推进状态。
    //
    // 为什么必须先读：如果先 complete 再校验，一次失败的校验会留下
    // `stored` 但存储里没有文件的行——那个状态比拒绝更糟，因为列表里它会
    // 正常显示，点下载才 404。
    const location = await callOpsRpc(
      context,
      'contract_attachment_location',
      { p_attachment_id: params.attachmentId },
      contractAttachmentLocationEnvelopeSchema,
    );

    if (location.status === 'attachment_not_found') throw missing('attachment');

    const object = await headStorageObject(context.env, location.storage_path).catch((cause) => {
      throw storageUnavailable(cause);
    });

    if (object === null) {
      // 契约 §5.4 第 13 条：409 `STATE_CONFLICT`（未上传）。这一条此前永远
      // 不会触发——函数只看数据库状态，而那一行在 create 时就写好了。
      throw stateConflict('ATTACHMENT_NOT_UPLOADED');
    }

    const result = await callOpsRpc(
      context,
      'complete_contract_attachment',
      {
        p_attachment_id: params.attachmentId,
        // 没给校验和就是 null：库里那列可空，而编一个空串会让「校验过」与「没校验」分不开。
        p_checksum_sha256: body.checksumSha256 ?? null,
      },
      contractAttachmentCompleteEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(context, 'completeOpsContractAttachment', {
        attachment: toContractAttachment(result.attachment),
      });
    }

    switch (result.status) {
      case 'attachment_not_found':
        throw missing('attachment');
      case 'invalid_checksum':
        throw rejected('INVALID_CHECKSUM', { field: result.field });
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/**
 * `GET /api/v1/ops/contract-attachments/{attachmentId}/access`
 *
 * 前缀与上一条同为 `/contract-attachments/`（§5.4 第 14 条）。这条是 GET，
 * 幂等列是「—」，所以不要求 `Idempotency-Key`。
 */
opsContractRoutes.get(
  OPS_ROUTES.accessOpsContractAttachment.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'contract.read');
    const params = parseParams(context, z.object({ attachmentId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'contract_attachment_access',
      { p_attachment_id: params.attachmentId },
      contractAttachmentAccessEnvelopeSchema,
    );

    if (result.status === 'attachment_not_found') {
      throw missing('attachment');
    }

    const attachment = toContractAttachment(result.attachment);
    const signed = await createSignedDownload(context.env, attachment.storagePath).catch(
      (cause) => {
        throw storageUnavailable(cause);
      },
    );
    return respond(context, 'accessOpsContractAttachment', {
      attachmentId: attachment.id,
      storagePath: attachment.storagePath,
      accessScope: attachment.accessScope,
      ...signed,
    });
  },
);
