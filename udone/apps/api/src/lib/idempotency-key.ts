/**
 * 幂等键的存储命名空间与请求内容指纹。
 *
 * 它修过两个真实缺陷：
 * 1. 最初直接拿 `Idempotency-Key` 头当缓存 key，于是同一个 key 在不同端点上
 *    命中同一格缓存——把 A 端点的响应体当成 B 端点的结果返回。
 * 2. 随后加进命名空间的「调用者」用的是 `sha256(Authorization)`。在没有登录
 *    体系时这是唯一稳定标识；但一旦 access token 会过期并刷新，两次重试之间
 *    的哈希就会变，重试落到新命名空间，幂等在最该生效的时刻失效。收款登记
 *    重复两次就是这么来的。
 *
 * 所以调用者分量取自验签后的 `sub`（跨 refresh 不变），验签失败才退化为
 * 令牌哈希——那条路径只可能被伪造者走到，退化后最多是自己的重试失效，
 * 不会跨用户串号。
 */

import { verifyAccessToken } from './jwt';

export interface IdempotencyScope {
  /** 已验证的调用者分量，由 `resolveCaller()` 产出。 */
  caller: string;
  organizationId: string | undefined;
  method: string;
  path: string;
  key: string;
}

export interface CallerIdentity {
  /** 存储用的命名空间分量。 */
  storageKey: string;
  /** 验签通过时的 auth.users.id，写入 actor_id 列供排障。 */
  subject: string | undefined;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析调用者。
 *
 * 三级退化，每一级都在缩小安全边界而不是扩大：
 * - 验签通过 → `user:<sub>`。跨令牌刷新稳定，这是唯一正确的形态。
 * - 有令牌但验不过（伪造、过期、未配密钥）→ `token:<sha256>`。命名空间仍在
 *   调用者之间隔离，只是同一个人的下一次刷新会换一格。
 * - 无令牌 → `anonymous`。这类请求到不了任何业务写端点（`requireAuth` 先拒）。
 *
 * 未配置 `SUPABASE_JWT_SECRET` 时永远停在第二级；这是刻意的，本模块不猜密钥。
 */
export async function resolveCaller(
  authorization: string | undefined,
  jwtSecret: string | undefined,
  now: () => number = Date.now,
): Promise<CallerIdentity> {
  if (!authorization) return { storageKey: 'anonymous', subject: undefined };

  if (jwtSecret) {
    const bearer = authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (bearer) {
      const claims = await verifyAccessToken(bearer, jwtSecret, now);
      if (claims) return { storageKey: `user:${claims.subject}`, subject: claims.subject };
    }
  }

  return { storageKey: `token:${await sha256Hex(authorization)}`, subject: undefined };
}

/**
 * 存储 key。组织维度也要进来：同一个用户在切换组织后，两边的收付款申请可能
 * 内容完全相同，只有组织不同。
 *
 * 查询串刻意不参与：写请求的语义由路径与方法决定，把查询串算进去会让
 * 「同一次重试但客户端多带了一个无关参数」变成缓存未命中，反而重复执行。
 */
export function idempotencyStorageKey(scope: IdempotencyScope): string {
  return [
    scope.caller,
    scope.organizationId ?? '-',
    scope.method.toUpperCase(),
    scope.path,
    scope.key,
  ].join(':');
}

/**
 * 请求内容指纹，用于区分「同一次重试」与「复用同一个 key 干了另一件事」。
 *
 * 只对原始文本做哈希，不解析 JSON：两个字段顺序不同的语义相同请求会被判成
 * 冲突——这是故意的，宁可让客户端换 key，也不要在服务端猜「这两个 body
 * 应该算同一个」。
 */
export async function requestFingerprint(body: string): Promise<string> {
  return sha256Hex(body);
}
