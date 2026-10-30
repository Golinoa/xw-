import type { MiddlewareHandler } from 'hono';
import { ERROR_CODES, type OpsContext, z } from '@erp/contracts';
import type { ApiEnvironment } from './auth';
import { ApiHttpError } from './error-handler';

/**
 * 运营端鉴权：调用者身份来自 `ops.get_current_ops_context()`，不来自令牌自述。
 *
 * 这里有一个刻意的选择——**不自己验签**。PostgREST 拿到用户令牌后会用同一个
 * JWT secret 验签并 `SET LOCAL ROLE authenticated`，验签失败它自己回 401；
 * 验签通过但 `ops.operators` 没有对应的 active 行，RPC 返回零行。也就是说，
 * 「令牌有效」与「是运营成员」两件事由两个真正知道答案的地方分别回答，
 * Worker 只负责把它们翻译成状态码。
 *
 * 如果在这里再验一次签，就会得到第二份判定实现：它可能与 PostgREST 对
 * `alg`、`aud`、时钟偏差的处理不一致，而症状是「同一个令牌，RPC 通、鉴权不通」，
 * 排查方向会先落到令牌本身。
 */

const OPS_CONTEXT_RPC = '/rest/v1/rpc/get_current_ops_context';

/**
 * RPC 返回的是数据库列名（snake_case），契约要的是小驼峰。映射必须显式写出来：
 * 用 `as` 直接断言会让「列改名了但响应还是旧的」这种漂移一路流到前端，
 * 而症状是某个字段变 undefined。
 */
const opsContextRowSchema = z.object({
  operator_id: z.string().min(1),
  operator_email: z.string().min(1),
  operator_display_name: z.string().nullable(),
  operator_status: z.literal('active'),
  mfa_required: z.boolean(),
  permission_version: z.number().int().positive(),
  last_login_at: z.string().nullable(),
  role_codes: z.array(z.string()),
  role_names: z.array(z.string()),
  permission_codes: z.array(z.string()),
});

type OpsContextRow = z.infer<typeof opsContextRowSchema>;

function toOpsContext(row: OpsContextRow): OpsContext {
  return {
    operatorId: row.operator_id,
    email: row.operator_email,
    displayName: row.operator_display_name,
    status: row.operator_status,
    mfaRequired: row.mfa_required,
    permissionVersion: row.permission_version,
    lastLoginAt: row.last_login_at,
    roleCodes: row.role_codes,
    roleNames: row.role_names,
    permissions: row.permission_codes,
  };
}

export type OpsResolution =
  { kind: 'ok'; context: OpsContext } | { kind: 'unauthenticated' } | { kind: 'forbidden' };

export async function resolveOpsContext(
  environment: Pick<ApiEnvironment['Bindings'], 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'>,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<OpsResolution> {
  const baseUrl = environment.SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY;
  if (!baseUrl || !publishableKey) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Authentication service is not configured',
    );
  }

  const response = await fetcher(`${baseUrl}${OPS_CONTEXT_RPC}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // `Content-Profile` 才是这条请求的关键：RPC 是 POST，PostgREST 用它决定
      // 到哪个 schema 找函数。少了它同样是 404，与「函数不存在」形态一致。
      // `Accept-Profile` 只影响响应 schema 解析，这对 POST RPC 不是必需——
      // 变异验证过：删掉它仍然是 200。保留它是为了后续 GET 读表复用同一个客户端。
      'Accept-Profile': 'ops',
      'Content-Profile': 'ops',
    },
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  });

  // 401 来自网关：令牌无效或已过期。403 来自 Postgres：连 schema 都进不去。
  // 两者对调用方是同一件事——「先登录」。
  if (response.status === 401 || response.status === 403) return { kind: 'unauthenticated' };
  if (!response.ok) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The operator directory is unavailable',
    );
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The operator directory is unavailable',
    );
  }
  if (payload.length === 0) return { kind: 'forbidden' };

  const parsed = opsContextRowSchema.safeParse(payload[0]);
  if (!parsed.success) {
    // 形状不对就是配置/迁移漂移，不能当成「没权限」放过去：那会让一个
    // 字段改名变成「所有运营账号突然都没权限」，而真正的原因在迁移里。
    console.error(
      JSON.stringify({
        event: 'ops_context_contract_violation',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }),
    );
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The operator directory is unavailable',
    );
  }
  return { kind: 'ok', context: toOpsContext(parsed.data) };
}

/**
 * 契约 §5.1：其余端点全部要求 `Authorization`，`/auth/*` 三个例外。
 * 没有令牌 401；令牌有效但不是 active 运营成员 403。
 */
export function requireOpsAuth(): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const header = context.req.header('authorization');
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
    }

    const resolution = await resolveOpsContext(context.env, token);
    if (resolution.kind === 'unauthenticated') {
      throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
    }
    if (resolution.kind === 'forbidden') {
      // 这里不带 `details.reason`：RPC 对「没有账号」与「账号停用」都返回零行，
      // 编一个 reason 会让其中一半是错的。需要区分这两个原因的只有登录端点
      // （U05），那次查询有邮箱可用，能一次问准。
      throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'An active operator account is required');
    }

    context.set('opsContext', resolution.context);
    context.set('opsToken', token);
    await next();
  };
}
