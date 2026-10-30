import { z } from 'zod';

/**
 * 运营登录三端点（契约 §5.1）。
 *
 * 令牌分工是这份契约里最容易被实现走样的一条，所以把两个名字和一个路径写成
 * 常量：access token 只经响应体下发（前端驻内存），refresh token 只经
 * `Set-Cookie` 下发。cookie 名一旦在 API 与前端各写一份，改名时就会一半生效
 * 一半不生效，而症状是「登录成功但立刻 401」。
 */
export const OPS_REFRESH_COOKIE = 'ops_refresh';

/**
 * cookie 的作用路径必须是认证端点本身。
 *
 * 写成 `/` 的话，这个 HttpOnly cookie 会随每次业务请求一起发送——它不会因此
 * 变得可读（HttpOnly 仍然挡着脚本），但会把长期凭证的暴露面从三个端点扩大到
 * 全部端点，而且任何一处日志记录请求头时都会带上它。
 */
export const OPS_AUTH_COOKIE_PATH = '/api/v1/ops/auth';

/**
 * cookie 的有效期是一周**策略**，不是 GoTrue 的 refresh token 有效期。
 *
 * 两者不可能对齐：GoTrue 的响应里不含 refresh token 的过期时间，猜一个值会让
 * 两端出现两个「真实」有效期。取短是安全的——cookie 先过期，服务端即使还认
 * 这个 refresh token，也不会再被送到认证端点；取长则相反。
 */
export const OPS_REFRESH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export const opsLoginRequestSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});

export type OpsLoginRequest = z.infer<typeof opsLoginRequestSchema>;

/**
 * 登录与刷新共用同一个响应形状：只有 access token。
 *
 * 不返回 operator 信息：前端拿到 token 后的第一次调用固定是 `/session`，
 * 在那里取身份只有一条路径；如果登录也返回一份，两份身份在权限刚变更时
 * 会短暂不一致，而前端没法判断哪份新。
 */
export const opsTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
});

export type OpsTokenResponse = z.infer<typeof opsTokenResponseSchema>;

/** 登出只有 204：清 cookie 这件事没有可返回的内容。 */
export const opsLogoutResponseSchema = z.void();
