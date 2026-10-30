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
