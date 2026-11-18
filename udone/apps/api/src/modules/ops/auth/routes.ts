import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsLoginRequestSchema,
  type OpsMemberReason,
  type OpsTokenResponse,
} from '@erp/contracts';
import { parseJson, respond, respondNoContent } from '../../../lib/contract';
import { createRestClient } from '../../../lib/rest-client';
import { createFixedWindowRateLimiter } from '../../../lib/rate-limit-store';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import {
  activateInvitedMember,
  resolveMemberState,
  touchLastLogin,
} from '../../../middleware/ops-auth';
import { clientKey } from '../../../middleware/rate-limit';
import { clearRefreshCookie, readRefreshToken, writeRefreshCookie } from './cookie';
import { createGoTrueUpstream, type OpsAuthUpstream } from './upstream';

/** 从 Authorization: Bearer 里取访问令牌；没有就返回 null（登出允许匿名调用）。 */
function readAccessToken(context: Context<ApiEnvironment>): string | null {
  const header = context.req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * 写一条访问审计。
 *
 * 用**调用者的令牌**调 RPC，而不是 service_role + 传 actor：传 actor 等于让任何人
 * 都能替别人留痕，那比不记更糟。
 *
 * 失败只记日志不抛：审计写不进去不该让登录失败——否则审计表的可用性会绑架整个后台。
 */
async function recordAccessAudit(
  context: Context<ApiEnvironment>,
  accessToken: string,
  action: 'auth.login' | 'auth.logout',
): Promise<void> {
  try {
    const client = createRestClient(context.env, accessToken);
    await client.rest('rpc/record_access_audit', {
      method: 'POST',
      profile: 'ops',
      body: {
        p_action: action,
        p_request_id: context.get('requestId') ?? null,
      },
    });
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'ops_access_audit_write_failed',
        action,
        message: cause instanceof Error ? cause.message : 'unknown',
        requestId: context.get('requestId'),
      }),
    );
  }
}


export const opsAuthRoutes = new Hono<ApiEnvironment>();

/**
 * 登录单独限流：5 次 / 5 分钟，键是「客户端地址 + 邮箱小写」。
 *
 * 为什么不能只靠全局的 60 次/分钟：那个上限是按 IP 的，而密码喷洒用的是一个
 * 密码撞很多账号、或很多 IP 撞一个账号，两种都不容易在单个 IP 上打到 60 次。
 * 键里带邮箱是为了让「换 IP 撞同一个账号」也被算进同一条窗口；带 IP 是为了让
 * 「一个 IP 撞很多账号」不至于把所有账号一起打满。
 *
 * 窗口按 isolate 计，与全局限流同一个局限：它挡住的是单个滥用者，不是分布式攻击。
 * 真正的分布式防护要在边缘做，不在这里假装做到。
 */
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 5 * 60_000;
const loginLimiter = createFixedWindowRateLimiter({
  limit: LOGIN_LIMIT,
  windowMs: LOGIN_WINDOW_MS,
});

function upstreamFor(context: { env: ApiEnvironment['Bindings'] }): OpsAuthUpstream {
  // 注入路径只对测试开放：生产环境不存在这个绑定，`wrangler.toml` 里也写不出来。
  return context.env.OPS_AUTH_UPSTREAM ?? createGoTrueUpstream(context.env);
}

/**
 * 契约只认两个原因，而能走到 403 的只剩两种状态。
 *
 * D-01 之后 `invited` 不再 403：它在同一个请求里被激活（见下面的登录流程），
 * 所以 `OPS_MEMBER_INACTIVE` 只剩「被停用」一种含义——这正是选 A 换来的收益。
 * `missing` 仍是 `OPS_MEMBER_MISSING`：那不是停用，是根本没有运营行。
 */
function memberReasonFor(state: 'disabled' | 'missing'): OpsMemberReason {
  return state === 'missing' ? 'OPS_MEMBER_MISSING' : 'OPS_MEMBER_INACTIVE';
}

/**
 * `POST /api/v1/ops/auth/login`
 *
 * 顺序固定：GoTrue 换令牌 → 成员判定 → 激活（仅 invited）→ 写 last_login →
 * 下发 cookie。先验密码是底线：反过来等于允许未验证身份的人探测运营名单。
 *
 * **失败策略不对称，这是刻意的**：
 *   - 激活失败 → 503，本次登录不成立。发出去的令牌会被 `get_current_ops_context()`
 *     的 `status = 'active'` 挡回 403，用户看到「登录成功但进不去」，且每次刷新
 *     重演一遍；不如在这里就失败一次，让他重试登录。
 *   - `last_login_at` 写失败 → 只记一条日志，登录照常成功。它是展示字段，
 *     不该成为登录可用性的单点：为了「最近登录时间」这个列，把一个能正常登录的
 *     人挡在门外，代价明显不成比例。
 *
 * 任何失败态都不得先下发 cookie：发了再回 403，前端会先进「已登录」再被打回。
 */
opsAuthRoutes.post(OPS_ROUTES.postOpsLogin.path, async (context) => {
  const body = await parseJson(context, opsLoginRequestSchema);
  const email = body.email.trim();

  const gate = loginLimiter.check(`${clientKey(context)}|${email.toLowerCase()}`);
  if (!gate.allowed) {
    context.header('Retry-After', String(gate.retryAfterSeconds));
    throw new ApiHttpError(429, ERROR_CODES.RATE_LIMITED, 'Too many sign-in attempts');
  }

  const upstream = upstreamFor(context);
  const grant = await upstream.signInWithPassword({ email, password: body.password });
  if (grant.kind === 'rejected') {
    // 契约要求不区分「邮箱不存在」与「密码错误」：说得越细，越方便有人把
    // 一份泄露的邮箱表变成一份「哪些是运营账号」的名单。
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Email or password is incorrect');
  }

  const state = await resolveMemberState(context.env, grant.accessToken);
  if (state === 'missing' || state === 'disabled') {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'An active operator account is required', {
      reason: memberReasonFor(state),
    });
  }

  if (state === 'invited') {
    const activation = await activateInvitedMember(context.env, grant.accessToken);
    if (activation !== 'activated') {
      // 走到这里只有两种可能，而它们的处置完全相反，所以必须再问一次真实状态，
      // 不能拿 `unchanged` 当「失败」一刀切：
      //   - 另一个并发的登录已经把同一行激活了（两次点击 / 两个标签页）。那是成功，
      //     回 503 会让人以为第二次点击出错了，而事实是账号刚被他自己的另一次登录
      //     激活——这次登录完全有效。
      //   - 判定与激活之间被管理员停用或删除了。那才是失败，令牌发出去下一次请求
      //     就会被 `status = 'active'` 挡回 403。
      const settled = await resolveMemberState(context.env, grant.accessToken);
      if (settled !== 'active') {
        console.error(
          JSON.stringify({
            event: 'ops_activation_not_applied',
            result: activation,
            state: settled,
            requestId: context.get('requestId'),
          }),
        );
        if (settled === 'disabled' || settled === 'missing') {
          throw new ApiHttpError(
            403,
            ERROR_CODES.FORBIDDEN,
            'An active operator account is required',
            { reason: memberReasonFor(settled) },
          );
        }
        // 还是 invited：激活函数没生效（迁移漂移或权限问题），不能装作成功。
        throw new ApiHttpError(
          503,
          ERROR_CODES.INTERNAL_ERROR,
          'The operator account could not be activated',
        );
      }
    }
  }

  try {
    await touchLastLogin(context.env, grant.accessToken);
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'ops_last_login_write_failed',
        message: cause instanceof Error ? cause.message : 'unknown',
        requestId: context.get('requestId'),
      }),
    );
  }

  // 访问审计：拿刚签发的令牌写，actor 就是本人（这一刻还拿不到别的可信身份）。
  // 写失败不影响登录——登录是主流程，审计是留痕；把留痕失败做成登录失败，
  // 等于让审计表的可用性绑架整个后台。
  await recordAccessAudit(context, grant.accessToken, 'auth.login');

  writeRefreshCookie(context, grant.refreshToken);
  const payload: OpsTokenResponse = { accessToken: grant.accessToken };
  return respond(context, 'postOpsLogin', payload);
});

/**
 * `POST /api/v1/ops/auth/refresh`
 *
 * 每次都轮换 cookie：GoTrue 的 refresh token 是一次性的，回同一个等于把旧的
 * 再存一遍，而下一次刷新会用它去换——成功与否取决于上游是否允许重用，不该赌。
 */
opsAuthRoutes.post(OPS_ROUTES.postOpsRefresh.path, async (context) => {
  const refreshToken = readRefreshToken(context);
  if (!refreshToken) {
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  }

  const grant = await upstreamFor(context).refresh(refreshToken);
  if (grant.kind === 'rejected') {
    // 过期的 cookie 留着，会让每次打开页面都先发一次注定失败的刷新请求；
    // 清掉它，浏览器就不会再带这个死令牌。
    clearRefreshCookie(context);
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  }

  writeRefreshCookie(context, grant.refreshToken);
  const payload: OpsTokenResponse = { accessToken: grant.accessToken };
  return respond(context, 'postOpsRefresh', payload);
});

/**
 * `POST /api/v1/ops/auth/logout`
 *
 * 有没有 cookie 都回 204：登出是幂等的，第二次调用不该报错——「已经不在了」
 * 与「刚删掉」对使用者是同一件事。
 */
opsAuthRoutes.post(OPS_ROUTES.postOpsLogout.path, async (context) => {
  const refreshToken = readRefreshToken(context);
  if (refreshToken) await upstreamFor(context).revoke(refreshToken);
  clearRefreshCookie(context);
  return respondNoContent(context);
});
