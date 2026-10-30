import { ERROR_CODES, z } from '@erp/contracts';
import { createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';

/**
 * GoTrue 的代理面。
 *
 * 抽成接口不是为了将来换供应商，而是因为**本地没有 GoTrue**：`db:local:*` 起的是
 * 一个光秃秃的 PostgREST，没有 `/auth/v1`。如果登录端点直接写 `fetch(SUPABASE_URL + ...)`，
 * 那么它的每一条分支都只能在有真实 Supabase 项目的地方才能被跑到，而那种「跑到了
 * 但没验证」的绿是最贵的。
 *
 * 注入点是 `Env.OPS_AUTH_UPSTREAM`：生产不存在这个绑定，测试通过 `app.request`
 * 的第三个参数传进去。这样不需要模块级可变的全局状态，也不需要 `if (IS_TEST)`。
 */
export type OpsTokenGrant =
  { kind: 'granted'; accessToken: string; refreshToken: string } | { kind: 'rejected' };

export interface OpsAuthUpstream {
  signInWithPassword(input: { email: string; password: string }): Promise<OpsTokenGrant>;
  refresh(refreshToken: string): Promise<OpsTokenGrant>;
  /** 尽力而为：失败只记日志，不影响登出结果。 */
  revoke(refreshToken: string): Promise<void>;
}

/** GoTrue 的令牌响应。只取三个字段，其余（user、expires_at…）不进契约。 */
const tokenGrantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});

type TokenGrantRow = z.infer<typeof tokenGrantSchema>;

export const GOTRUE_TOKEN_PATH = '/auth/v1/token';
export const GOTRUE_LOGOUT_PATH = '/auth/v1/logout';

export function createGoTrueUpstream(
  environment: ApiEnvironment['Bindings'],
  fetcher: typeof fetch = fetch,
): OpsAuthUpstream {
  const client = createRestClient(environment, environment.SUPABASE_PUBLISHABLE_KEY ?? '');

  /**
   * 400/401/403 一律是 `rejected`：GoTrue 对「邮箱不存在」「密码错误」「邮箱未确认」
   * 都回 400，而契约要求登录端点**不区分**这些原因，所以不把它们往下透。
   */
  async function grant(path: string, body: unknown): Promise<OpsTokenGrant> {
    const response = await client.auth(path, { method: 'POST', body });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { kind: 'rejected' };
    }
    // GoTrue 自己也会限流。透传 429 而不是报 503：这是「等一会儿再试」，
    // 与「服务不可用」对使用者是两件事。
    if (response.status === 429) {
      throw new ApiHttpError(429, ERROR_CODES.RATE_LIMITED, 'Too many sign-in attempts');
    }
    if (!response.ok) {
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The authentication service is unavailable',
      );
    }

    const payload: unknown = await response.json().catch(() => null);
    const parsed = tokenGrantSchema.safeParse(payload);
    if (!parsed.success) {
      // 上游形状变了却当成「密码错」，会让人一直重输密码；这里按服务异常报。
      console.error(
        JSON.stringify({
          event: 'gotrue_token_contract_violation',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            code: issue.code,
          })),
        }),
      );
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The authentication service is unavailable',
      );
    }

    const row: TokenGrantRow = parsed.data;
    return { kind: 'granted', accessToken: row.access_token, refreshToken: row.refresh_token };
  }

  return {
    signInWithPassword({ email, password }) {
      return grant(`${GOTRUE_TOKEN_PATH}?grant_type=password`, { email, password });
    },

    refresh(refreshToken) {
      return grant(`${GOTRUE_TOKEN_PATH}?grant_type=refresh_token`, {
        refresh_token: refreshToken,
      });
    },

    /**
     * 撤销上游会话。
     *
     * **这段形状未经真实 GoTrue 验证**：本地没有 `/auth/v1`，集成测试用的是替身。
     * refresh token 不是 access token，`POST /auth/v1/logout` 是否认它取决于
     * GoTrue 版本与 `scope` 参数，验不了的事不能写成已验证。
     *
     * 所以这里只做「尽力而为」并吞掉失败：登出对使用者的承诺是「这台设备不再有
     * 会话」，那句话由清 cookie 兑现；上游那个 refresh token 在有效期内仍然可用
     * 这件事，是已知缺口，不是被这段代码解决的问题。
     */
    async revoke(refreshToken) {
      try {
        const response = await fetcher(
          `${(environment.SUPABASE_URL ?? '').replace(/\/+$/, '')}${GOTRUE_LOGOUT_PATH}`,
          {
            method: 'POST',
            headers: {
              apikey: environment.SUPABASE_PUBLISHABLE_KEY ?? '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (!response.ok) {
          console.warn(JSON.stringify({ event: 'gotrue_revoke_failed', status: response.status }));
        }
      } catch {
        console.warn(JSON.stringify({ event: 'gotrue_revoke_failed', reason: 'request_failed' }));
      }
    },
  };
}
