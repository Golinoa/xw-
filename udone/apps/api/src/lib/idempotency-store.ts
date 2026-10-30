/** 读回的记录。回放只需要状态码、响应体与指纹。 */
export interface IdempotencyRecord {
  status: number;
  body: unknown;
  requestHash: string;
  expiresAt: number;
}

/** 写入载荷。`expiresAt` 由具体 store 决定，调用方不该知道 TTL 策略。 */
export interface IdempotencyWrite {
  status: number;
  body: unknown;
  /** 原始请求体的指纹。同一个 key 换了内容必须拒绝，不能回放旧结果。 */
  requestHash: string;
  /**
   * 验签通过时的 auth.users.id，只落库供排障查「这次重放是谁写的」。
   * 它不参与命名空间派生——派生的分量已经以 `user:<sub>` 的形式在 key 里了。
   * 可选，因为验签失败时确实没有它；那种情况下整条记录也退化为哈希命名空间。
   */
  actorId?: string;
}

/**
 * 一格缓存槽：命名空间 + 客户端 key，与 `ops.idempotency_records` 的
 * `PK(scope, key)` 同构。
 *
 * 两列而不是一列拼接字符串：拼起来之后「按命名空间扫这个调用者用过的键」只能
 * 靠前缀匹配，而分开存就是主键前缀扫描；排障时也不必反解分隔符。
 */
export interface IdempotencySlot {
  scope: string;
  key: string;
}

export interface IdempotencyStore {
  get(slot: IdempotencySlot): Promise<IdempotencyRecord | null>;
  set(slot: IdempotencySlot, record: IdempotencyWrite): Promise<void>;
}

export interface IdempotencyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * 内存 Map 的键。用 NUL 连接：scope 里本来就有冒号（`user:<sub>:<org>:GET:/path`），
 * 再用冒号拼会与它自己的分隔符混淆，而 NUL 在 HTTP header 里根本不可能出现。
 */
function slotMapKey(slot: IdempotencySlot): string {
  return `${slot.scope}\u0000${slot.key}`;
}

/**
 * In-memory idempotency cache.
 *
 * Scope: one Worker isolate. Cloudflare may run several isolates for the same
 * Worker, so a retry landing on a different isolate is not deduplicated. This is
 * an honest P0 limit — replace with KV or a Durable Object before relying on it
 * for money-moving endpoints.
 */
export function createMemoryIdempotencyStore(
  options: IdempotencyStoreOptions = {},
): IdempotencyStore {
  const ttlMs = options.ttlMs ?? 600_000;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;
  const entries = new Map<string, IdempotencyRecord>();

  function dropExpired() {
    const current = now();
    for (const [key, record] of entries) {
      if (record.expiresAt <= current) entries.delete(key);
    }
  }

  return {
    async get(slot) {
      const mapKey = slotMapKey(slot);
      const record = entries.get(mapKey);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        entries.delete(mapKey);
        return null;
      }
      return record;
    },

    async set(slot, record) {
      const mapKey = slotMapKey(slot);
      dropExpired();
      // Re-inserting keeps Map order meaningful: the oldest write is evicted first.
      entries.delete(mapKey);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      // actorId 只对落库有意义，内存里没有排障价值，显式丢弃而不是靠展开带进来。
      entries.set(mapKey, {
        status: record.status,
        body: record.body,
        requestHash: record.requestHash,
        expiresAt: now() + ttlMs,
      });
    },
  };
}
