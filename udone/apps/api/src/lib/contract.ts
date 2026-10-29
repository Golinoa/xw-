import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from '@erp/contracts';
import { ERROR_CODES, ROUTES, type RouteKey, type RouteResponse } from '@erp/contracts';
import type { ApiEnvironment } from '../middleware/auth';
import { ApiHttpError } from '../middleware/error-handler';

type ApiContext = Context<ApiEnvironment>;

/** 只回报字段路径与错误类型，绝不回报用户提交的原始值。 */
function issueSummary(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    code: issue.code,
  }));
}

function invalid(message: string, error: z.ZodError) {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, message, {
    issues: issueSummary(error),
  });
}

/** 解析并校验 JSON 请求体。禁止在路由里直接 `context.req.json()`。 */
export async function parseJson<T extends z.ZodType>(
  context: ApiContext,
  schema: T,
): Promise<z.output<T>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'A valid JSON body is required');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw invalid('The request body is invalid', result.error);
  return result.data;
}

export function parseParams<T extends z.ZodType>(context: ApiContext, schema: T): z.output<T> {
  const result = schema.safeParse(context.req.param());
  if (!result.success) throw invalid('The request path is invalid', result.error);
  return result.data;
}

export function parseQuery<T extends z.ZodType>(context: ApiContext, schema: T): z.output<T> {
  const result = schema.safeParse(context.req.query());
  if (!result.success) throw invalid('The query parameters are invalid', result.error);
  return result.data;
}

/**
 * 出站校验：响应体必须满足该端点在 `ROUTES` 注册的 schema。
 *
 * 多字段、少字段、类型不符都会在这里变成 500 + 结构化日志，而不是静默流到前端。
 * 这是「服务端不会先走形」的强制门：只要写路由时用 respond()，就无法返回契约外的字段。
 */
export function respond<K extends RouteKey>(
  context: ApiContext,
  key: K,
  data: RouteResponse<K>,
  status: ContentfulStatusCode = 200,
) {
  const parsed = ROUTES[key].response.safeParse(data);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'response_contract_violation',
        route: key,
        requestId: context.get('requestId'),
        issues: issueSummary(parsed.error),
      }),
    );
    throw new ApiHttpError(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      'The server produced a response that does not match its contract',
      { route: key, issues: issueSummary(parsed.error) },
    );
  }
  return context.json(parsed.data as RouteResponse<K>, status);
}
