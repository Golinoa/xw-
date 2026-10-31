import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsFeatureCreateRequestSchema,
  opsFeatureListQuerySchema,
  opsFeatureUpdateRequestSchema,
  opsPackageCreateRequestSchema,
  opsPackageListQuerySchema,
  opsPackagePriceVersionCreateRequestSchema,
  opsPackageTransitionRequestSchema,
  opsPackageUpdateRequestSchema,
  opsProductCreateRequestSchema,
  opsProductListQuerySchema,
  opsProductUpdateRequestSchema,
  z,
} from '@erp/contracts';
import { parseJson, parseParams, parseQuery, respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  catalogImpactRowSchema,
  featureCreateEnvelopeSchema,
  featureListEnvelopeSchema,
  featureUpdateEnvelopeSchema,
  packageCreateEnvelopeSchema,
  packageDetailEnvelopeSchema,
  packageListEnvelopeSchema,
  packageTransitionEnvelopeSchema,
  packageUpdateEnvelopeSchema,
  priceVersionCreateEnvelopeSchema,
  priceVersionListEnvelopeSchema,
  productCreateEnvelopeSchema,
  productListEnvelopeSchema,
  productUpdateEnvelopeSchema,
  toFeature,
  toFeatureListItem,
  toImpact,
  toPackage,
  toPackageFeature,
  toPackageListItem,
  toPriceVersion,
  toPriceVersionListItem,
  toProduct,
  toProductListItem,
} from './protocol';

export const opsCatalogRoutes = new Hono<ApiEnvironment>();

/**
 * RPC 调用与信封解析的唯一入口。
 *
 * 与 `modules/ops/customers/routes.ts` 里那份同构（用户令牌、`profile: 'ops'`、
 * 上游错误翻译、zod 信封校验）。同样刻意没有抽公共工具：两处失败文案与错误映射
 * 本来就不同（客户域把 409 说成 customer directory conflict，这里是 catalog），
 * 抽出去之后每一次文案调整都会变成跨域变更。合并留给后续的 `ops/rpc.ts` 重构。
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
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The catalog reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'The catalog refused this request');
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The catalog rejected the request',
        );
      }
      console.error(
        JSON.stringify({ event: 'ops_rpc_failed', rpc: name, status: cause.status, requestId }),
      );
      throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The catalog is unavailable');
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
      'The catalog returned an unexpected shape',
    );
  }
  return parsed.data;
}

/**
 * 契约标注「必填」的幂等键，只能在这里判。
 *
 * 全局幂等中间件对没带 key 的请求直接放行（职责是「带了就回放」，不是「不带就
 * 拒绝」）。§7 把四个 POST 划进必填范围：三个新建（产品/套餐/价格版本）与套餐状态
 * 迁移。缺键的拒绝必须由 handler 自己做，否则客户端忘了带时，这几个端点会静默
 * 变成可重复提交的写操作——而那正是幂等键要防的事。
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

/**
 * 业务校验失败：400 + `{reason}`。
 *
 * 与 409 分家的理由：这些不是「和库里的数据打架」，而是「这次请求本身不成立」
 * （套餐的销售方式没开、权益键不存在、没有价格版本就激活）。前端应该改表单，
 * 不是刷新后重试。
 */
function rejected(reason: string, details: Record<string, unknown> = {}): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The catalog request was rejected', {
    reason,
    ...details,
  });
}

/** 产品/套餐改到 `retired` 时被草稿合同引用。`impact` 只放计数，明细在合同域。 */
function referenced(impact: z.infer<typeof catalogImpactRowSchema>): ApiHttpError {
  return new ApiHttpError(
    409,
    ERROR_CODES.OBJECT_REFERENCED,
    'The catalog entity is still referenced by draft contracts',
    { impact: toImpact(impact) },
  );
}

/**
 * 非法销售方式。库里回的是触发的那一个值，键名是 `mode`（§4 的文字叫法是
 * `sales_mode`）；两个都认，缺省就不带这个键——`details` 里塞 `salesMode: null`
 * 会让前端以为「值是 null」而不是「没指出是哪一个」。
 */
function invalidSalesMode(result: {
  mode?: string | null;
  sales_mode?: string | null;
}): ApiHttpError {
  const salesMode = result.mode ?? result.sales_mode ?? null;
  return rejected('INVALID_SALES_MODE', salesMode === null ? {} : { salesMode });
}

/** 权益键不存在。键同样可能为 null（元素里没带 `feature_key`）。 */
function featureMissing(result: { feature_key?: string | null }): ApiHttpError {
  return rejected(
    'FEATURE_NOT_FOUND',
    result.feature_key == null ? {} : { featureKey: result.feature_key },
  );
}

/** `GET /api/v1/ops/products` */
opsCatalogRoutes.get(OPS_ROUTES.listOpsProducts.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.read');
  const query = parseQuery(context, opsProductListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_products',
    {
      // 空串等价于「没筛」：传 `''` 到库里会变成 `ILIKE '%%'`，结果相同但多一次扫描。
      p_keyword: query.keyword || null,
      p_lifecycle_status: query.lifecycleStatus ?? null,
      p_sales_mode: query.salesMode ?? null,
    },
    productListEnvelopeSchema,
  );

  return respond(context, 'listOpsProducts', { items: result.items.map(toProductListItem) });
});

/** `POST /api/v1/ops/products` */
opsCatalogRoutes.post(OPS_ROUTES.createOpsProduct.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsProductCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_product',
    {
      p_code: body.code,
      p_name: body.name,
      p_description: body.description ?? null,
      // 入站 jsonb 用列名口径（`is_enabled`），与出站同一套命名规则，只差大小写。
      p_sales_modes: body.salesModes.map((mode) => ({
        mode: mode.mode,
        is_enabled: mode.isEnabled,
      })),
      p_request_id: context.get('requestId'),
    },
    productCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'createOpsProduct', { product: toProduct(result.product) }, 201);
  }

  switch (result.status) {
    case 'code_conflict':
      throw conflict('code');
    case 'sales_modes_required':
      throw rejected('SALES_MODES_REQUIRED');
    case 'invalid_sales_mode':
      throw invalidSalesMode(result);
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `PATCH /api/v1/ops/products/{productId}` */
opsCatalogRoutes.patch(OPS_ROUTES.updateOpsProduct.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  const params = parseParams(context, z.object({ productId: z.string().min(1) }));
  const body = await parseJson(context, opsProductUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_product',
    {
      p_product_id: params.productId,
      p_name: body.name ?? null,
      p_description: body.description ?? null,
      p_lifecycle_status: body.lifecycleStatus ?? null,
      // `undefined` → null = 不动；`[]` → 空数组 = 全删（库返回 sales_modes_required）。
      p_sales_modes:
        body.salesModes === undefined
          ? null
          : body.salesModes.map((mode) => ({
              mode: mode.mode,
              is_enabled: mode.isEnabled,
            })),
      p_expected_version: body.version,
      p_reason: body.reason ?? null,
      p_request_id: context.get('requestId'),
    },
    productUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsProduct', { product: toProduct(result.product) });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The product does not exist');
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The product was modified by someone else',
        { currentVersion: result.current_version },
      );
    case 'referenced':
      throw referenced(result.impact);
    case 'invalid_transition':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'A retired product cannot return to draft or active',
        { reason: 'INVALID_TRANSITION' },
      );
    case 'sales_modes_required':
      throw rejected('SALES_MODES_REQUIRED');
    case 'invalid_sales_mode':
      throw invalidSalesMode(result);
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/packages` */
opsCatalogRoutes.get(OPS_ROUTES.listOpsPackages.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.read');
  const query = parseQuery(context, opsPackageListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_packages',
    {
      p_product_id: query.productId ?? null,
      p_sales_mode: query.salesMode ?? null,
      p_status: query.status ?? null,
      p_keyword: query.keyword || null,
    },
    packageListEnvelopeSchema,
  );

  return respond(context, 'listOpsPackages', { items: result.items.map(toPackageListItem) });
});

/**
 * `POST /api/v1/ops/packages`
 *
 * 创建套餐会同时写首条价格版本（`versionNo = 1`）并回填 `currentPriceVersionId`，
 * 所以 201 的响应里有两个对象。分开两次调用会让「套餐存在但没价」成为可达状态。
 */
opsCatalogRoutes.post(OPS_ROUTES.createOpsPackage.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsPackageCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_package',
    {
      p_product_id: body.productId,
      p_internal_name: body.internalName ?? null,
      p_customer_name: body.customerName ?? null,
      p_sales_mode: body.salesMode,
      p_billing_type: body.billingType,
      p_default_term_months: body.defaultTermMonths ?? null,
      p_currency: body.currency ?? null,
      p_list_price: body.listPrice,
      p_features: (body.features ?? []).map((feature) => ({
        feature_key: feature.featureKey,
        enabled: feature.enabled,
        quota_value: feature.quotaValue ?? null,
        term_months: feature.termMonths ?? null,
        applies_to: feature.appliesTo,
      })),
      p_effective_from: body.effectiveFrom ?? null,
      p_request_id: context.get('requestId'),
    },
    packageCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(
      context,
      'createOpsPackage',
      { package: toPackage(result.package), priceVersion: toPriceVersion(result.price_version) },
      201,
    );
  }

  switch (result.status) {
    case 'product_not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The product does not exist');
    case 'sales_mode_disabled':
      throw rejected('SALES_MODE_DISABLED', { salesMode: result.sales_mode });
    case 'internal_name_conflict':
      throw conflict('internalName');
    case 'feature_not_found':
      throw featureMissing(result);
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/packages/{packageId}` */
opsCatalogRoutes.get(OPS_ROUTES.getOpsPackage.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.read');
  const params = parseParams(context, z.object({ packageId: z.string().min(1) }));

  const result = await callOpsRpc(
    context,
    'get_package',
    { p_package_id: params.packageId },
    packageDetailEnvelopeSchema,
  );

  if (result.status === 'not_found') {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The package does not exist');
  }

  return respond(context, 'getOpsPackage', {
    package: toPackage(result.package),
    features: result.features.map(toPackageFeature),
    currentPriceVersion:
      result.current_price_version === null ? null : toPriceVersion(result.current_price_version),
  });
});

/** `PATCH /api/v1/ops/packages/{packageId}` */
opsCatalogRoutes.patch(OPS_ROUTES.updateOpsPackage.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  const params = parseParams(context, z.object({ packageId: z.string().min(1) }));
  const body = await parseJson(context, opsPackageUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_package',
    {
      p_package_id: params.packageId,
      p_internal_name: body.internalName ?? null,
      p_customer_name: body.customerName ?? null,
      // `undefined` → null = 不动；`[]` → 空数组 = 清空全部权益（整体替换）。
      p_features:
        body.features === undefined
          ? null
          : body.features.map((feature) => ({
              feature_key: feature.featureKey,
              enabled: feature.enabled,
              quota_value: feature.quotaValue ?? null,
              term_months: feature.termMonths ?? null,
              applies_to: feature.appliesTo,
            })),
      p_expected_version: body.version,
      p_request_id: context.get('requestId'),
    },
    packageUpdateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'updateOpsPackage', { package: toPackage(result.package) });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The package does not exist');
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The package was modified by someone else',
        { currentVersion: result.current_version },
      );
    case 'internal_name_conflict':
      throw conflict('internalName');
    case 'feature_not_found':
      throw featureMissing(result);
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/packages/{packageId}/price-versions` */
opsCatalogRoutes.get(
  OPS_ROUTES.listOpsPackagePriceVersions.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'catalog.read');
    const params = parseParams(context, z.object({ packageId: z.string().min(1) }));

    const result = await callOpsRpc(
      context,
      'list_package_price_versions',
      { p_package_id: params.packageId },
      priceVersionListEnvelopeSchema,
    );

    if (result.status === 'not_found') {
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The package does not exist');
    }

    return respond(context, 'listOpsPackagePriceVersions', {
      items: result.items.map(toPriceVersionListItem),
    });
  },
);

/**
 * `POST /api/v1/ops/packages/{packageId}/price-versions`
 *
 * 没有 `versionNo` 入参：号由库在行锁下取 `max + 1`。成功后套餐的
 * `listPrice`/`currency` 会同步成新版本的值，所以响应里要带回套餐。
 */
opsCatalogRoutes.post(
  OPS_ROUTES.createOpsPackagePriceVersion.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'catalog.write');
    requireIdempotencyKey(context);
    const params = parseParams(context, z.object({ packageId: z.string().min(1) }));
    const body = await parseJson(context, opsPackagePriceVersionCreateRequestSchema);

    const result = await callOpsRpc(
      context,
      'create_package_price_version',
      {
        p_package_id: params.packageId,
        p_price: body.price,
        p_currency: body.currency ?? null,
        p_term_months: body.termMonths ?? null,
        p_effective_from: body.effectiveFrom,
        p_request_id: context.get('requestId'),
      },
      priceVersionCreateEnvelopeSchema,
    );

    if (result.status === 'ok') {
      return respond(
        context,
        'createOpsPackagePriceVersion',
        {
          priceVersion: toPriceVersion(result.price_version),
          package: toPackage(result.package),
        },
        201,
      );
    }

    switch (result.status) {
      case 'not_found':
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The package does not exist');
      case 'price_version_conflict':
        throw conflict('versionNo');
      default:
        throw rejected('REQUEST_REJECTED');
    }
  },
);

/**
 * `POST /api/v1/ops/packages/{packageId}/transition`
 *
 * 三种 409 分开：`CONFLICT + currentVersion` 刷新重试、`STATE_CONFLICT +
 * INVALID_TRANSITION` 看当前状态、`OBJECT_REFERENCED + impact` 先去处理合同。
 * `price_version_required` 是 400 而不是 409——契约 §7 把它归在业务校验失败里。
 */
opsCatalogRoutes.post(OPS_ROUTES.transitionOpsPackage.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  requireIdempotencyKey(context);
  const params = parseParams(context, z.object({ packageId: z.string().min(1) }));
  const body = await parseJson(context, opsPackageTransitionRequestSchema);

  const result = await callOpsRpc(
    context,
    'transition_package',
    {
      p_package_id: params.packageId,
      p_action: body.action,
      p_reason: body.reason,
      p_expected_version: body.version,
      p_request_id: context.get('requestId'),
    },
    packageTransitionEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'transitionOpsPackage', {
      package: { status: result.package.status, version: result.package.version },
      impact: toImpact(result.impact),
    });
  }

  switch (result.status) {
    case 'not_found':
      throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The package does not exist');
    case 'version_mismatch':
      throw new ApiHttpError(
        409,
        ERROR_CODES.CONFLICT,
        'The package was modified by someone else',
        { currentVersion: result.current_version },
      );
    case 'invalid_transition':
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'The package status does not allow this action',
        { reason: 'INVALID_TRANSITION' },
      );
    case 'referenced':
      throw referenced(result.impact);
    case 'price_version_required':
      throw rejected('PRICE_VERSION_REQUIRED');
    default:
      throw rejected('REQUEST_REJECTED');
  }
});

/** `GET /api/v1/ops/features` */
opsCatalogRoutes.get(OPS_ROUTES.listOpsFeatures.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.read');
  const query = parseQuery(context, opsFeatureListQuerySchema);

  const result = await callOpsRpc(
    context,
    'list_features',
    {
      p_is_active: query.isActive ?? null,
      p_keyword: query.keyword || null,
    },
    featureListEnvelopeSchema,
  );

  return respond(context, 'listOpsFeatures', { items: result.items.map(toFeatureListItem) });
});

/** `POST /api/v1/ops/features` */
opsCatalogRoutes.post(OPS_ROUTES.createOpsFeature.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  // 契约 §5.3 的幂等列对 `POST /features` 也是「必填」：它是五个写端点里唯一没有
  // 业务唯一键兜底的一个（`feature_key_conflict` 只在同键重复时出现），重试同一个
  // 新建请求而不带键，会得到两条不同的功能键或一次 409，取决于重试时机。
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsFeatureCreateRequestSchema);

  const result = await callOpsRpc(
    context,
    'create_feature',
    {
      p_feature_key: body.featureKey,
      p_display_name: body.displayName,
      p_value_type: body.valueType,
      p_unit: body.unit ?? null,
      p_description: body.description ?? null,
      p_request_id: context.get('requestId'),
    },
    featureCreateEnvelopeSchema,
  );

  if (result.status === 'feature_key_conflict') {
    throw conflict('featureKey');
  }

  return respond(context, 'createOpsFeature', { feature: toFeature(result.feature) }, 201);
});

/**
 * `PATCH /api/v1/ops/features/{featureKey}`
 *
 * 契约 §6/§7 要求「试图改 `featureKey`」是 400 而不是 409：它由
 * `opsFeatureUpdateRequestSchema` 的 `strictObject` 在入站直接拒绝，走不到 RPC。
 * 这条端点不要求 `Idempotency-Key`（PATCH 不在必填范围）。
 */
opsCatalogRoutes.patch(OPS_ROUTES.updateOpsFeature.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'catalog.write');
  const params = parseParams(context, z.object({ featureKey: z.string().min(1) }));
  const body = await parseJson(context, opsFeatureUpdateRequestSchema);

  const result = await callOpsRpc(
    context,
    'update_feature',
    {
      p_feature_key: params.featureKey,
      p_display_name: body.displayName ?? null,
      p_unit: body.unit ?? null,
      p_description: body.description ?? null,
      p_is_active: body.isActive ?? null,
      p_request_id: context.get('requestId'),
    },
    featureUpdateEnvelopeSchema,
  );

  if (result.status === 'not_found') {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The feature does not exist');
  }

  return respond(context, 'updateOpsFeature', { feature: toFeature(result.feature) });
});
