import type { Context } from 'hono';
import { ERROR_CODES, z } from '@erp/contracts';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';

/**
 * 导出域调 PostgREST 的唯一入口。
 *
 * 与设置页那份 `callOpsRpc` 几乎一样，但**不共用**：两处的错误语义不同。
 * 设置页会撞 409（字典 value 重复），导出不会——导出没有唯一约束冲突这条路径，
 * 把 409 分支抄过来只会让下一个人以为「导出也可能冲突」，然后在路由里补一个
 * 永远走不到的 case。少一个分支比少一次复制更值得。
 *
 * 形状违约（RPC 回了没声明的 status）一律 503 并打日志：那是代码与库之间
 * 失配，不是用户输入问题，回 400 会把排查方向指错。
 */
export async function callOpsExportRpc<S extends z.ZodType>(
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
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The export service reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(
          403,
          ERROR_CODES.FORBIDDEN,
          'The export service refused this request',
        );
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The export service rejected the request',
        );
      }
      if (cause.status === 404) {
        throw new ApiHttpError(404, ERROR_CODES.NOT_FOUND, 'The export service has no such record');
      }
    }
    throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The export service is unavailable', {
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
      'The export service returned an unexpected shape',
    );
  }
  return parsed.data;
}
