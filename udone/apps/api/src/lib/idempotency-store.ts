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

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: IdempotencyWrite): Promise<void>;
}

export interface IdempotencyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
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
    async get(key) {
      const record = entries.get(key);
      if (!record) return null;
      if (record.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return record;
    },

    async set(key, record) {
      dropExpired();
      // Re-inserting keeps Map order meaningful: the oldest write is evicted first.
      entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      // actorId 只对落库有意义，内存里没有排障价值，显式丢弃而不是靠展开带进来。
      entries.set(key, {
        status: record.status,
        body: record.body,
        requestHash: record.requestHash,
        expiresAt: now() + ttlMs,
      });
    },
  };
}
