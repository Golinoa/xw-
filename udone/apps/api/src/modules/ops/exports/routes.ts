import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsExportCreateRequestSchema,
  opsExportListQuerySchema,
  type OpsExportCreateRequest,
  type OpsExportListQuery,
} from '@erp/contracts';
import { parseJson, respond } from '../../../lib/contract';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import { STORAGE_BUCKETS, createSignedDownload, StorageSignError } from '../storage/sign';
import {
  exportCreateEnvelopeSchema,
  exportDetailEnvelopeSchema,
  exportListEnvelopeSchema,
  toOpsExportDetail,
  toOpsExportList,
} from './protocol';
import { callOpsExportRpc } from './rpc';
import { runPendingExports } from './runner';

export const opsExportsRoutes = new Hono<ApiEnvironment>();

/**
 * 导出任务（契约 §5.9 三个端点）。
 *
 * 四件这一域特有的事：
 *
 * 1. **`GET` 会顺手推进一条待办**（懒执行）。没有队列的环境里，一个只写不跑
 *    的任务就是幽灵。推进放在读路径上，是因为读的人正好在等这份文件。
 * 2. **`POST` 返回 202**，不是 200：此刻只有任务行，没有数据。响应体也只有
 *    `id/exportNo/exportType/status` 四个键，前端不会误以为能立即下载。
 * 3. **`downloadUrl` 视权限决定给不给。** 能看到任务（`export.read`）不等于
 *    有权下载那类数据；库里算好的 `can_download` 就是这个判断，路由只照着做。
 * 4. **签名失败不吞成 500。** 存储不可用时 `downloadUrl` 给 null 并继续返回
 *    详情——「这条导出存在但链接暂时签不出来」是有用信息，而 503 会让整页
 *    打不开，包括那些跟存储无关的元信息。
 */
opsExportsRoutes.get(OPS_ROUTES.listOpsExports.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'export.read');
  const query = parseListQuery(context);

  await runPendingExports(context);

  const result = await callOpsExportRpc(
    context,
    'list_exports',
    {
      p_export_type: query.exportType ?? null,
      p_statuses: query.status ?? null,
      p_requested_by: query.requestedBy ?? null,
    },
    exportListEnvelopeSchema,
  );

  if (result.status === 'ok') {
    return respond(context, 'listOpsExports', toOpsExportList(result.items));
  }

  throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'Only an export reader can list export jobs');
});

opsExportsRoutes.post(OPS_ROUTES.createOpsExport.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'export.create');
  requireIdempotencyKey(context);
  const body = await parseJson(context, opsExportCreateRequestSchema);

  const result = await callOpsExportRpc(
    context,
    'create_export',
    {
      p_export_type: body.exportType,
      p_filters: filtersOf(body),
      p_reason: body.reason,
      p_request_id: context.get('requestId'),
    },
    exportCreateEnvelopeSchema,
  );

  if (result.status === 'ok') {
    // `Location` 指到详情：202 的消费方接下来该轮询的就是这个地址。
    // 必须在 `respond` 之前设置——`c.json()` 已经把响应构造好了，之后再
    // 加头是往一个已经完成的 Response 上写，什么都不会发生。
    context.header('Location', `/api/v1/ops/exports/${result.export.id}`);
    return respond(
      context,
      'createOpsExport',
      {
        export: {
          id: result.export.id,
          exportNo: result.export.export_no,
          exportType: body.exportType,
          status: 'queued' as const,
        },
      },
      202,
    );
  }

  switch (result.status) {
    case 'unsupported_type':
      // zod 的 enum 已经挡过一次；到这里说明请求体校验被绕过，仍然给可读理由。
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'The export type is not supported',
        {
          reason: 'UNSUPPORTED_TYPE',
          field: 'exportType',
          value: result.export_type,
        },
      );
    case 'reason_required':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A reason is required to export', {
        reason: 'REASON_REQUIRED',
        field: 'reason',
      });
    case 'invalid_filters':
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The filters must be an object', {
        reason: 'INVALID_FILTERS',
        field: 'filters',
      });
  }
});

opsExportsRoutes.get(OPS_ROUTES.getOpsExport.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'export.read');
  const exportId = context.req.param('exportId');

  await runPendingExports(context);

  const result = await callOpsExportRpc(
    context,
    'get_export',
    { p_export_id: exportId },
    exportDetailEnvelopeSchema,
  );

  if (result.status !== 'ok') {
    throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The export job does not exist', {
      resource: 'export',
    });
  }

  const { export: entry, can_download: canDownload } = result;

  // 三个条件缺一不可：有权下载、真的成功了、还没过期。少判「未过期」会在
  // `expired` 行上仍然签出一个能用的地址，那等于把保留期作废。
  const downloadable =
    canDownload &&
    entry.status === 'succeeded' &&
    entry.storage_path !== null &&
    entry.expires_at !== null &&
    new Date(entry.expires_at).getTime() > Date.now();

  if (!downloadable) {
    return respond(context, 'getOpsExport', toOpsExportDetail(entry, null, null));
  }

  try {
    const signed = await createSignedDownload(
      context.env,
      entry.storage_path!,
      STORAGE_BUCKETS.exports,
    );
    return respond(context, 'getOpsExport', toOpsExportDetail(entry, signed.url, signed.expiresAt));
  } catch (cause) {
    if (cause instanceof StorageSignError) {
      console.error(
        JSON.stringify({
          event: 'ops_export_sign_failed',
          exportId: entry.id,
          requestId: context.get('requestId'),
          message: cause.message,
          status: cause.detail.status,
        }),
      );
      return respond(context, 'getOpsExport', toOpsExportDetail(entry, null, null));
    }
    throw cause;
  }
});

/** 契约 §5.9 标注「必填」的那个写端点。 */
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

/**
 * 列表筛选。
 *
 * `status` 是数组，必须用 `req.queries()` 取——`req.query()` 只保留重复参数的
 * 第一个值，于是 `?status=failed&status=succeeded` 会静默变成只筛 failed。
 * 这条坑在客户列表那轮踩过，这里不再踩第二次。
 */
function parseListQuery(context: Context<ApiEnvironment>): OpsExportListQuery {
  const rawStatuses = context.req.queries('status') ?? [];
  const status = rawStatuses.flatMap((value) => value.split(',')).filter((value) => value !== '');

  const parsed = opsExportListQuerySchema.safeParse({
    exportType: context.req.query('exportType') ?? undefined,
    status: status.length > 0 ? status : undefined,
    requestedBy: context.req.query('requestedBy') ?? undefined,
  });

  if (!parsed.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The export list query is invalid', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  return parsed.data;
}

/**
 * `filters` 的缺省值。
 *
 * 契约说 `filters` 与列表端点同构，但不要求必填；不给就是「全量」。空对象
 * 而不是 null：`ops.exports.filters` 是 `NOT NULL`，而 `{}` 与 `null` 在这里
 * 语义相同（不筛），存 `{}` 让读的人不用猜。
 */
function filtersOf(body: OpsExportCreateRequest): Record<string, unknown> {
  return body.filters ?? {};
}
