import { ERROR_CODES } from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';

/**
 * 邀请上游：GoTrue 的 `auth.admin`。
 *
 * 为什么必须走 service_role：`auth.users` 的写入没有用户令牌可用的路径，邀请本来
 * 就是「管理员替还没账号的人建账号」。契约 §7.2 把 service_role 限定在三处，
 * 这是其中之一——**只用于建账号，不用于写任何 ops 表**。
 *
 * 与登录上游同一套注入方式：本地没有 `/auth/v1`（`db:local:*` 只起 PostgREST），
 * 若直接写 `fetch`，这条分支只能在有真实 Supabase 项目的地方跑到。绑定是对象，
 * `wrangler.toml` 里写不出来，所以它也不可能在生产被误配成一个开关。
 */
export type OpsInviteOutcome =
  /** 上游已建好 auth 用户，返回它的 id。 */
  | { kind: 'invited'; userId: string }
  /** 该邮箱已经有 auth 用户。契约 §5.1 要求映射成 409 `CONFLICT`。 */
  | { kind: 'email_taken' }
  /** 上游不可用或返回了认不出的形状。调用方映射成 503。 */
  | { kind: 'unavailable' };

export interface OpsInviteUpstream {
  invite(email: string): Promise<OpsInviteOutcome>;
  /**
   * 补偿删除（D-04）：邀请时 auth 用户已建、成员行没写成，用它把刚建的账号删掉，
   * 让「邀请失败」对人是一次干净失败——可以直接换邮箱重试，而不是卡在
   * 「邮箱已存在」上一个不知道要去哪删的账号。
   *
   * 契约：**不抛异常**，只回答「删掉了吗」。补偿是尽力而为的收尾，它自己的失败
   * 不该把「邀请失败」这个已经确定的结论变成一次 500。
   */
  deleteUser(userId: string): Promise<boolean>;
}

/**
 * 上游返回 422 时是「邮箱已存在」，返回 5xx 时是「上游坏了」。
 *
 * 两者不能合并：前者是用户可修正的输入问题（409 + 换邮箱），后者是运维问题
 * （503 + 稍后重试）。合并成一个通用错误，会让运营人员对着一个能自己解决的
 * 问题等运维。
 */
export function createGoTrueInviteUpstream(
  environment: Pick<ApiEnvironment['Bindings'], 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): OpsInviteUpstream {
  return {
    async invite(email: string): Promise<OpsInviteOutcome> {
      const base = environment.SUPABASE_URL?.replace(/\/+$/, '');
      const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
      if (!base || !serviceKey) {
        throw new ApiHttpError(
          503,
          ERROR_CODES.INTERNAL_ERROR,
          'Sending invitations is not configured',
        );
      }

      const response = await fetch(`${base}/auth/v1/admin/invite`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(8_000),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (response.ok) {
        const userId =
          typeof payload === 'object' && payload !== null
            ? (payload as { id?: unknown }).id
            : undefined;
        if (typeof userId !== 'string' || userId.length === 0) return { kind: 'unavailable' };
        return { kind: 'invited', userId };
      }

      // 422 是 GoTrue 对「邮箱已注册」的标准答复；个别版本用 400 + error_code。
      // 两个都按「已存在」处理，但只在错误体确实是 email_exists 时才这么认——
      // 把所有 422 都当成「已存在」会把「邮箱格式不合法」也说成「已注册」。
      const errorCode =
        typeof payload === 'object' && payload !== null
          ? (payload as { error_code?: unknown }).error_code
          : undefined;
      if (response.status === 422 || errorCode === 'email_exists') return { kind: 'email_taken' };

      return { kind: 'unavailable' };
    },

    /**
     * `DELETE /auth/v1/admin/users/{id}`。
     *
     * 2xx 与 404 都算成功：404 是「已经不在了」，而补偿的目标就是「这个 id 不再
     * 存在」，所以它已经达成。把 404 当失败会让人去处理一个并不存在的问题。
     *
     * **本地无法验证这条路径**：`db:local:*` 只起 PostgREST，没有 `/auth/v1`。
     * 因此单测与集成测试只证明「补偿被调用了、失败分支落日志」，不能声称
     * 「auth 用户真的被删掉了」——那需要真实的 Supabase 项目。
     */
    async deleteUser(userId: string): Promise<boolean> {
      const base = environment.SUPABASE_URL?.replace(/\/+$/, '');
      const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
      // 没配置就不是「删失败」，是根本发不出这条请求。仍然返回 false：调用方
      // 会落到「孤儿账号」那条日志，运维据此去后台手工清理。
      if (!base || !serviceKey) return false;

      try {
        const response = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          signal: AbortSignal.timeout(8_000),
        });
        return response.ok || response.status === 404;
      } catch {
        // 网络错误 / 超时：补偿没做成，但异常不该冒泡到路由——那里的结论已经
        // 是「邀请失败」，把它换成 500 只会让人以为是另一次故障。
        return false;
      }
    },
  };
}
