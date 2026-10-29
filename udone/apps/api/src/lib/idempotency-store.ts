export interface IdempotencyRecord {
  status: number;
  body: unknown;
  expiresAt: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: Omit<IdempotencyRecord, 'expiresAt'>): Promise<void>;
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
      entries.set(key, { ...record, expiresAt: now() + ttlMs });
    },
  };
}
