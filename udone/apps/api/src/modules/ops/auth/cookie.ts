import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  OPS_AUTH_COOKIE_PATH,
  OPS_REFRESH_COOKIE,
  OPS_REFRESH_COOKIE_MAX_AGE_SECONDS,
} from '@erp/contracts';
import type { ApiEnvironment } from '../../../middleware/auth';

type ApiContext = Context<ApiEnvironment>;

/**
 * refresh token 的载体。四个属性各有理由，缺一个都会以「能用但不安全」的形式存在：
 *
 * - `HttpOnly`：脚本读不到它，XSS 拿不到长期凭证。
 * - `Secure`：只在 HTTPS 上发送。`http://localhost` 是浏览器的安全上下文，
 *   所以本地开发不受影响——但这也意味着「本地能登录」不能证明生产能登录，
 *   两者的差别只在浏览器是否接受这条 Set-Cookie。
 * - `SameSite=Strict`：只在同源请求里发送。跨源部署（前端与 Worker 不同域）必须
 *   改成 `None; Secure` 并同时开 CORS 凭证，否则浏览器静默丢弃 cookie，表现是
 *   「登录成功但下一次请求立刻 401」。契约 §5.1 因此要求开发与生产都走同源代理。
 * - `Path=/api/v1/ops/auth`：见契约里 `OPS_AUTH_COOKIE_PATH` 的说明。
 */
const COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: OPS_AUTH_COOKIE_PATH,
} as const;

export function readRefreshToken(context: ApiContext): string | null {
  const value = getCookie(context, OPS_REFRESH_COOKIE);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function writeRefreshCookie(context: ApiContext, refreshToken: string): void {
  setCookie(context, OPS_REFRESH_COOKIE, refreshToken, {
    ...COOKIE_ATTRIBUTES,
    maxAge: OPS_REFRESH_COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * 清 cookie 时属性必须与写入时一致，尤其是 `Path`：浏览器按 (名字, 域, 路径)
 * 三者匹配删除，路径不同的 `Max-Age=0` 会新增一条同名空 cookie 而不是删掉旧的，
 * 结果是「登出后刷新一次又登回来了」。
 */
export function clearRefreshCookie(context: ApiContext): void {
  deleteCookie(context, OPS_REFRESH_COOKIE, COOKIE_ATTRIBUTES);
}
