/**
 * HS256 访问令牌的验签与 claim 提取。
 *
 * 为什么需要它：幂等命名空间要一个「跨令牌刷新稳定」的调用者标识。原来用
 * `sha256(Authorization)`，在还没有登录体系时是唯一可得的稳定标识；一旦接上
 * 刷新机制，access token 会在两次重试之间过期并轮换，哈希跟着变，重试就落到
 * 新的命名空间——幂等失效，而这恰恰是「重试不重复执行」最需要成立的那一步。
 *
 * 所以调用者标识必须来自 claim（`sub`），它跨 refresh 不变。
 *
 * 为什么自己验签而不是只解 payload：中间件跑在 `requireAuth` 之前（它要先查
 * 缓存才能决定要不要执行处理函数），此时拿不到已认证的身份。若只解不验，
 * 任何人都能伪造 `sub` 去污染别人的幂等槽——让别人重试时收到一个不属于自己的
 * 成功响应。验签一次 HMAC 的代价远低于一次数据库往返，且不需要把中间件挪到
 * 鉴权之后（那会改动全部 31 个端点的挂载方式）。
 *
 * 失败一律返回 null，由调用方决定退化策略；这里不抛错。
 */

export interface AccessTokenClaims {
  /** auth.users.id。运营端与租户成员都在这一列上，是同一个身份空间。 */
  subject: string;
  sessionId: string | undefined;
  expiresAt: number | undefined;
}

/**
 * `Uint8Array<ArrayBuffer>` 是显式标注的：在 TS 5.7+ 的泛型化 TypedArray 下，
 * 裸 `Uint8Array` 的 buffer 类型是 `ArrayBufferLike`，包含了 `SharedArrayBuffer`，
 * 因而不能直接交给 `crypto.subtle` 的 `BufferSource`。
 */
function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment)));
}

/**
 * 校验签名与过期时间，返回可用 claim；任何一步不成立都返回 null。
 *
 * `now` 可注入，只为一件事：让「过期令牌被拒」这条断言不依赖真实等待。
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<AccessTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  let decodedHeader: unknown;
  let decodedPayload: unknown;
  try {
    decodedHeader = decodeJsonSegment(header);
    decodedPayload = decodeJsonSegment(payload);
  } catch {
    return null;
  }

  // 只接受 HS256。允许调用方指定算法是本类实现最经典的漏洞来源。
  if (
    typeof decodedHeader !== 'object' ||
    decodedHeader === null ||
    (decodedHeader as { alg?: unknown }).alg !== 'HS256'
  ) {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlToBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!verified) return null;

  const claims = decodedPayload as { sub?: unknown; session_id?: unknown; exp?: unknown };
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) return null;

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= now()) return null;

  return {
    subject: claims.sub,
    sessionId: typeof claims.session_id === 'string' ? claims.session_id : undefined,
    expiresAt,
  };
}

export interface SignAccessTokenOptions {
  /** auth.users.id。 */
  subject: string;
  secret: string;
  sessionId?: string;
  /** 默认一小时，与 Supabase 的 access token 保持一致。 */
  ttlSeconds?: number;
  now?: () => number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJsonSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * 签发一个与 `verifyAccessToken` 同格式的 HS256 令牌。
 *
 * 存在的理由只有一个：本地没有 GoTrue，而 `/meta` 与 `/session` 的验收要求
 * 真实 HTTP 请求带真实令牌。用一个「测试专用的签发函数」比在测试里手写 JWT
 * 好，因为手写的那份会与验签实现各自演化，等到不一致时，失败会表现为
 * 「所有请求 401」，看起来像鉴权坏了。
 *
 * 它**不是**给生产用的。生产令牌只由 GoTrue 签发，本函数不会被请求路径调用；
 * 是否允许本地自签由 `localJwtAuthEnabled()` 那个独立开关管。
 */
export async function signAccessToken(options: SignAccessTokenOptions): Promise<string> {
  const issuedAt = Math.floor((options.now ?? Date.now)() / 1000);
  const header = encodeJsonSegment({ alg: 'HS256', typ: 'JWT' });
  const payload = encodeJsonSegment({
    sub: options.subject,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    role: 'authenticated',
    aud: 'authenticated',
    iat: issuedAt,
    exp: issuedAt + (options.ttlSeconds ?? 3600),
  });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * 本地自签通道的总开关，只认严格的字符串 `'true'`。
 *
 * 为什么不能拿「配了 `SUPABASE_JWT_SECRET`」当条件：生产也配它——验签幂等
 * 命名空间要用。用它当开关等于在生产上常开自签通道，任何人拿到 secret 就能
 * 造出任意身份的令牌，而这恰恰是本文件存在的理由（验签）所要防的事。
 *
 * 为什么不是 `Boolean(value)`：`'false'`、`'0'`、`'no'` 都是真值。开关这种东西
 * 一旦接受「差不多」，就会出现「配了 false 却是开着」的现场，而排查方向会先
 * 落到别处。`check:deploy` 另外断言生产配置里不出现这个变量。
 */
export function localJwtAuthEnabled(environment: { ALLOW_LOCAL_JWT_AUTH?: string }): boolean {
  return environment.ALLOW_LOCAL_JWT_AUTH === 'true';
}
