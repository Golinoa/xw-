import { Hono } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsLoginRequestSchema,
  type OpsMemberReason,
  type OpsTokenResponse,
} from '@erp/contracts';
import { parseJson, respond, respondNoContent } from '../../../lib/contract';
import { createFixedWindowRateLimiter } from '../../../lib/rate-limit-store';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { resolveMemberState, type OpsMemberState } from '../../../middleware/ops-auth';
import { clientKey } from '../../../middleware/rate-limit';
import { clearRefreshCookie, readRefreshToken, writeRefreshCookie } from './cookie';
import { createGoTrueUpstream, type OpsAuthUpstream } from './upstream';

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
 * 契约只认两个原因。
 *
 * `invited` 与 `disabled` 都归到 `OPS_MEMBER_INACTIVE`：对使用者来说都是「这个
 * 账号现在不能用」，而「你还没接受邀请」与「你被停用」的区分若要做，只能靠
 * 更多信息换取，那不是未登录时该给的东西。具体状态由 `/operators` 列表负责说清。
 */
function memberReasonFor(state: OpsMemberState): OpsMemberReason {
  return state === 'missing' ? 'OPS_MEMBER_MISSING' : 'OPS_MEMBER_INACTIVE';
}

/**
 * `POST /api/v1/ops/auth/login`
 *
 * 三步，顺序不能换：先用 GoTrue 换令牌，再用那个令牌问 PostgREST「这个账号是
 * 不是有效运营成员」，最后才下发 cookie。反过来（先查成员再验密码）等于允许
 * 未验证身份的人探测运营名单。
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
  if (state !== 'active') {
    // 不下发 cookie。发了再回 403 的话，前端会先进入「已登录」状态再被 403 打回，
    // 于是每一次刷新都会重演一遍这个来回，而真正的事实是「没登录」。
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'An active operator account is required', {
      reason: memberReasonFor(state),
    });
  }

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
