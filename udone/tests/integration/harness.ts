import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import {
  authorizationForRole,
  type AuthContext,
  type AuthRole,
  type Permission,
} from '@erp/contracts';
import app from '../../apps/api/src/index';
import type { ApiEnvironment } from '../../apps/api/src/middleware/auth';
import { idempotencyStorageKey, resolveCaller } from '../../apps/api/src/lib/idempotency-key';

/**
 * 让 API 真的打到 PostgREST 上。
 *
 * 被测的链路是 route → service → rest-client → PostgREST → 事务函数 / RLS。
 * 这里唯一被替换掉的是 Supabase Auth（GoTrue）：它需要一整套 OAuth 服务，
 * 而它自己的行为已经由 `supabase-auth-verifier.test.ts` 打桩覆盖。
 * 换句话说，**鉴权以后全是真的**：JWT 由 PostgREST 校验，租户与创建人由 RLS
 * 与库函数判定，权限由 `has_permission()` 查表决定。
 *
 * 这也是为什么这个文件不 stub 数据库层：那正是要验的东西。
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}：集成测试必须通过 \`pnpm db:local:http\` 启动，不要直接跑 vitest`,
    );
  }
  return value;
}

export const REST_URL = requiredEnv('UDONE_REST_URL');
const JWT_SECRET = requiredEnv('UDONE_LOCAL_JWT_SECRET');
export const ORG_ID = requiredEnv('UDONE_TEST_ORG_ID');

/**
 * 运营端固定账号（auth.users id），与夹具里的 ops.operators 行一一对应。
 * 它不在 `USERS` 里：那三个是租户成员，走 `AUTH_VERIFIER` 注入的租户身份；
 * 运营端点走的是「用户令牌 → PostgREST → ops 判定函数」，两条路径不共用。
 */
export const OPS_USER = requiredEnv('UDONE_TEST_OPS_USER_ID');

/**
 * 停用账号（`status = 'disabled'`）。
 *
 * 登录端点要区分「不是运营成员」与「成员被停用」，而这两种情况在
 * `get_current_ops_context()` 里都是零行。没有这个夹具，那条 403 分支就只能靠
 * 单测的替身证明；有了它，`ops.login_member_state()` 是**真跑**在真实 RLS 上的。
 */
export const OPS_DISABLED_USER = requiredEnv('UDONE_TEST_OPS_DISABLED_USER_ID');

/** 三个固定账号，与 scripts/db/local-db.mjs 的夹具一一对应。 */
export const USERS = {
  admin: requiredEnv('UDONE_TEST_ADMIN_ID'),
  operator: requiredEnv('UDONE_TEST_OPERATOR_ID'),
  finance: requiredEnv('UDONE_TEST_FINANCE_ID'),
} as const;

const ROLE_BY_USER: Record<string, AuthRole> = {
  [USERS.admin]: 'admin',
  [USERS.operator]: 'operator',
  [USERS.finance]: 'finance',
};

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * 签一个 PostgREST 认的 HS256 JWT。
 *
 * `role: 'authenticated'` 是关键：PostgREST 用它决定 `SET LOCAL ROLE`，
 * 少了它 RLS 会按 anon 走，所有断言都会以「读不到数据」的形式失败，
 * 而失败原因看起来会像业务逻辑坏了。
 */
export function signToken(userId: string, issuedAtOffsetSeconds = 0): string {
  return signJwt(
    { sub: userId, role: 'authenticated', aud: 'authenticated' },
    issuedAtOffsetSeconds,
  );
}

/**
 * 从中间件视角算出存储 key，用于断言「库里那条记录的 scope_key 与派生算法一致」。
 *
 * 走真实的 `resolveCaller`，所以「令牌刷新后 sub 不变」这件事也一并被验证到。
 */
export async function expectedScopeKey(input: {
  token: string;
  organizationId: string;
  method: string;
  path: string;
  key: string;
}): Promise<string> {
  const caller = await resolveCaller(`Bearer ${input.token}`, JWT_SECRET);
  return idempotencyStorageKey({
    caller: caller.storageKey,
    organizationId: input.organizationId,
    method: input.method,
    path: input.path,
    key: input.key,
  });
}

/**
 * service_role 令牌。只用来验证「基础设施表对客户端令牌不可见」这条边界，
 * 不能拿来跑业务用例——那会把 RLS 绕过去，测出来的全绿没有意义。
 */
export function signServiceToken(): string {
  return signJwt({ role: 'service_role', aud: 'authenticated' });
}

function signJwt(claims: Record<string, unknown>, issuedAtOffsetSeconds = 0): string {
  const issuedAt = Math.floor(Date.now() / 1000) + issuedAtOffsetSeconds;
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ ...claims, iat: issuedAt, exp: issuedAt + 3600 }));
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** 只取 sub，不校验签名——签名由 PostgREST 校验，这里只负责「谁在调用」。 */
function subjectOf(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    return typeof parsed.sub === 'string' ? parsed.sub : null;
  } catch {
    return null;
  }
}

function verifier() {
  return {
    async verify(token: string, organizationId?: string): Promise<AuthContext | null> {
      const userId = subjectOf(token);
      const role = userId ? ROLE_BY_USER[userId] : undefined;
      if (!userId || !role) return null;
      const authorization = authorizationForRole(role);
      return {
        userId,
        organizationId: organizationId ?? ORG_ID,
        role,
        sessionId: 'integration-session',
        permissions: authorization.permissions,
        dataScope: authorization.dataScope,
      };
    },
    async hasPermission(context: AuthContext, permission: Permission): Promise<boolean> {
      return context.permissions.includes(permission);
    },
  };
}

/** 把绑定齐的 env 交回调用方，测试里只需换 actor。 */
export function apiEnv(overrides: Partial<ApiEnvironment['Bindings']> = {}) {
  return {
    SUPABASE_URL: REST_URL,
    SUPABASE_PUBLISHABLE_KEY: 'integration-publishable-key',
    // 没有它，幂等中间件会退回内存 store，落库那条链路就永远不会被测到。
    SUPABASE_SERVICE_ROLE_KEY: signServiceToken(),
    // 没有它，幂等命名空间退回 sha256(Authorization)，令牌一刷新幂等就失效。
    SUPABASE_JWT_SECRET: JWT_SECRET,
    // 默认 60/分钟不够用：一个文件里几十次请求会自己把自己限流。
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_VERIFIER: verifier(),
    ...overrides,
  } satisfies ApiEnvironment['Bindings'];
}

export interface CallOptions {
  actor?: keyof typeof USERS;
  /**
   * 固定令牌。默认每次调用现签一个，而现签的令牌带 iat——跨秒的两次请求
   * 会得到不同令牌，幂等命名空间跟着变，重放就测不出来了。
   */
  token?: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  organizationId?: string;
  headers?: Record<string, string>;
  /**
   * 覆盖本次请求的绑定。
   *
   * 登录端点需要 GoTrue，而本地只有 PostgREST——所以替身是从这里进去的，
   * 走 `Env.OPS_AUTH_UPSTREAM` 这个只存在于测试类型的绑定，而不是模块级全局。
   */
  env?: Partial<ApiEnvironment['Bindings']>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * 直接调 Hono 的 `app.request`，不起 HTTP 服务器。
 *
 * 少的只是 Worker 运行时外壳（与真实行为无关），多的是一条**真实**的
 * PostgREST 请求——参数名、返回列名、SQLSTATE 到状态码的映射都在这一跳里。
 */
export async function call<T = unknown>(
  path: string,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const actor = options.actor ?? 'admin';
  const method = options.method ?? 'GET';
  const url = new URL(path, 'http://integration.local');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token ?? signToken(USERS[actor])}`,
    'X-Organization-ID': options.organizationId ?? ORG_ID,
    'Content-Type': 'application/json',
    ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
    ...options.headers,
  };

  const response = await app.request(
    url.toString(),
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    apiEnv(options.env),
  );

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应（网关 502、代理错误页等）也要能看见内容，
      // 直接抛解析错误会把真正的失败原因换成「Unexpected token」。
      body = { raw: text };
    }
  }
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
  };
}

/**
 * 断言状态码，并把响应体带进失败消息。
 *
 * 只报「expected 500 to be 201」等于让人重跑一遍去看日志；
 * 带上错误码与消息，失败的第一次输出就能定位。
 */
export function expectStatus(response: ApiResponse, expected: number): void {
  expect(
    response.status,
    `期望 HTTP ${expected}，实际 HTTP ${response.status}：${JSON.stringify(response.body)}`,
  ).toBe(expected);
}

export interface RestRequestOptions {
  method?: string;
  body?: unknown;
  /** `Accept-Profile` / `Content-Profile`，PostgREST 用它选 schema。 */
  profile?: string;
  /** 默认用管理员令牌；验边界时要显式传 anon 或 service_role。 */
  token?: string;
  prefer?: string;
}

/**
 * 直连 PostgREST，不经过 Hono。
 *
 * 用于验证「schema 是否真的暴露」这类基础设施问题：走 app.request 只能看到
 * 业务模块碰巧用到的那个 schema，看不出别的 schema 是被暴露了还是根本不存在。
 */
export async function restRequest<T = unknown>(
  path: string,
  options: RestRequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    apikey: 'integration-publishable-key',
    'Content-Type': 'application/json',
    ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
    ...(options.profile === undefined
      ? {}
      : { 'Accept-Profile': options.profile, 'Content-Profile': options.profile }),
    ...(options.prefer === undefined ? {} : { Prefer: options.prefer }),
  };

  const response = await fetch(`${REST_URL}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body: body as T, headers: response.headers };
}
