/**
 * 幂等键的存储命名空间与请求内容指纹。
 *
 * 原来的实现直接拿 `Idempotency-Key` 头当缓存 key，于是同一个 key 在
 * 不同端点上会命中同一格缓存——把 A 端点的响应体当成 B 端点的结果返回。
 * 两个用户撞了同一个 key 更糟：B 拿到 A 的响应。key 由客户端生成，
 * 客户端之间没有任何协调，碰撞只是时间问题。
 *
 * 所以存储 key 必须至少包含「谁、对哪个端点、用什么 key」三件事。
 */

export interface IdempotencyScope {
  /** 原始 Authorization 头。中间件跑在鉴权之前，此时读不到 userId，但头已经可读。 */
  authorization: string | undefined;
  organizationId: string | undefined;
  method: string;
  path: string;
  key: string;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 调用方身份。用令牌的哈希而不是令牌本身：内存 store 的 key 会进堆快照与日志，
 * 而 Authorization 头就是凭证。
 *
 * 没有 Authorization 时退化为 `anonymous`——此时所有匿名写请求共享一格命名空间，
 * 但匿名请求本来就到不了任何业务写端点（`requireAuth` 先拒），所以这不是泄漏面。
 */
async function principalOf(authorization: string | undefined): Promise<string> {
  return authorization ? sha256Hex(authorization) : 'anonymous';
}

/**
 * 存储 key。组织维度也要进来：同一个用户在一个令牌内切换组织时，
 * 两边的收付款申请可能内容完全相同，只有组织不同。
 *
 * 查询串刻意不参与：写请求的语义由路径与方法决定，把查询串算进去会让
 * 「同一次重试但客户端多带了一个无关参数」变成缓存未命中，反而重复执行。
 */
export async function idempotencyStorageKey(scope: IdempotencyScope): Promise<string> {
  const principal = await principalOf(scope.authorization);
  return [
    principal,
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
 * 冲突——这是故意的，宁可让客户端换 key，也不要在服务端猜「这两个 body 应该
 * 算同一个」。
 */
export async function requestFingerprint(body: string): Promise<string> {
  return sha256Hex(body);
}
