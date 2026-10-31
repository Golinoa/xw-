import { Hono, type Context } from 'hono';
import { ERROR_CODES, OPS_ROUTES, opsOverviewQuerySchema, z } from '@erp/contracts';
import { respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import { overviewEnvelopeSchema, toOverview } from './protocol';

export const opsOverviewRoutes = new Hono<ApiEnvironment>();

/**
 * overview 域（契约 §5.9 第一条：`GET /overview`）。
 *
 * 三件这一域特有的事：
 *
 * 1. **不完整的响应也是 200。** 少权限的指标进 `restrictedMetrics[]`、数据不全
 *    的区块进 `partialFailures[]`，状态码仍是 200——这份总览「成功算出来了，
 *    只是有些部分你看不到或算不准」。用 4xx/5xx 表达会让整页打不开，而运营
 *    真正需要的是「看得到的那些先看」。前端负责显式提示，后端只负责说清楚。
 * 2. **`windowDays` 不在 API 层兜底。** 不传就交给 SQL 读 settings（那是唯一
 *    真源，运营在设置页改的值必须立刻生效）。在这里写 `?? 30` 会让设置页形同
 *    虚设，且两处默认值迟早分叉。
 * 3. **`invalid_window` 映射成 400 而不是 422。** 契约 §6.4 的词表按 code 归组，
 *    参数范围错属于 `VALIDATION_ERROR`；422 在本项目里留给「形状对但语义冲突」。
 */
async function callOverview(
  context: Context<ApiEnvironment>,
  body: Record<string, unknown>,
): Promise<z.infer<typeof overviewEnvelopeSchema>> {
  const client = createRestClient(context.env, context.get('opsToken'));

  let payload: unknown;
  try {
    payload = await client.rest<unknown>('rpc/get_ops_overview', {
      method: 'POST',
      body,
      profile: 'ops',
    });
  } catch (cause) {
    const requestId = context.get('requestId');
    if (cause instanceof RestConflictError) {
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The overview reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'The overview refused this request');
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The overview rejected the request',
        );
      }
    }
    throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The overview is unavailable', {
      requestId,
    });
  }

  const parsed = overviewEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    // 出站形状违约是服务端的错，不是调用方的错：503 + 一条结构化日志。
    console.error(
      JSON.stringify({
        event: 'ops_rpc_shape_invalid',
        rpc: 'get_ops_overview',
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
      'The overview returned an unexpected shape',
    );
  }
  return parsed.data;
}

/** `GET /api/v1/ops/overview` */
opsOverviewRoutes.get(OPS_ROUTES.getOpsOverview.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'overview.read');

  const raw: Record<string, unknown> = { ...context.req.query() };
  // `?windowDays=` 与「没传」是两件事：前者是前端把一个空输入框发了上来，
  // 交给 zod 会 coerce 成 0 而被判越界。删掉它等于「没传」，回到 settings 的默认值。
  if (raw.windowDays === '') delete raw.windowDays;

  const parsed = opsOverviewQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The query parameters are invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
      })),
    });
  }

  const result = await callOverview(context, {
    p_window_days: parsed.data.windowDays ?? null,
  });

  if (result.status === 'invalid_window') {
    // API 层的 zod 已经挡过一次；走到这里说明是直接调 RPC 或两者范围不一致。
    // 仍然按 400 回，并把越界值带出去——比 500 更能说明问题在哪。
    throw new ApiHttpError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'The overview window is out of range',
      {
        reason: 'INVALID_WINDOW',
        field: 'windowDays',
        value: result.value,
      },
    );
  }

  return respond(context, 'getOpsOverview', toOverview(result));
});
