import type { RestClient } from './rest-client';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency-store';

/**
 * 落库的幂等存储（运营契约 §2.5）。
 *
 * 内存 store 的注释已经写明限制：一个 isolate 一份缓存，同一 Worker 的另一个
 * 实例收不到。对「创建一个客户」这是重放失效，对「登记一笔收款」就是重复记账——
 * 区别只在于谁来重试。所以钱款与开通类端点必须落库。
 *
 * 表只有 service_role 能读写：行里是别人的响应体，任何客户端令牌都不该看到。
 * 因此这里的 RestClient 必须是 `createServiceRestClient()` 造出来的那个。
 *
 * 已知范围限制（诚实记录，不当作已解决）：
 * 1. 不是「预留式」幂等。并发双请求可能都越过 get() 未命中、都执行一遍，
 *    最后插入时靠唯一约束让一条记录胜出（`resolution=ignore-duplicates`）。
 *    契约 §2.5 只定义了「命中即回放 / 不同指纹 409」，没有定义「执行中」的
 *    返回语义；要真正防住并发重复写，需要先插入 in_progress 行再执行、
 *    并把「执行中再次到达」映射成一个双方约定的状态码。T-08 收款端点开工前
 *    必须把这个语义定下来，否则收款的并发保护是空的。
 * 2. 过期行不主动清理。`expires_at` 上有索引，但没有任何进程去删它们；
 *    上线前需要一个定时任务（或写入时顺手删本 key 的过期行）。
 */

export interface OpsIdempotencyStoreOptions {
  client: RestClient;
  ttlMs?: number;
  now?: () => number;
}

interface RecordRow {
  response_status: number;
  response_body: unknown;
  request_hash: string;
  expires_at: string;
}

const TABLE = 'idempotency_records';

/** 24 小时：足够覆盖一次人工重试，又不至于把表撑成审计日志。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function createOpsIdempotencyStore(options: OpsIdempotencyStoreOptions): IdempotencyStore {
  const { client } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  return {
    async get(slot) {
      const rows = await client.rest<RecordRow[]>(
        `${TABLE}?scope=eq.${encodeURIComponent(slot.scope)}` +
          `&key=eq.${encodeURIComponent(slot.key)}` +
          `&expires_at=gt.${encodeURIComponent(new Date(now()).toISOString())}` +
          '&select=response_status,response_body,request_hash,expires_at',
        { profile: 'ops' },
      );
      const row = rows[0];
      if (!row) return null;
      const record: IdempotencyRecord = {
        status: row.response_status,
        body: row.response_body,
        requestHash: row.request_hash,
        expiresAt: new Date(row.expires_at).getTime(),
      };
      return record;
    },

    async set(slot, record) {
      await client.rest<void>(TABLE, {
        method: 'POST',
        profile: 'ops',
        // ignore-duplicates：并发下由主键 (scope, key) 决定谁留下，输的一方不报错。
        // 这一条请求已经回复给了调用方，此时再抛 409 会把一个成功的写入
        // 报成失败——比丢一条重放记录严重得多。
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: {
          scope: slot.scope,
          key: slot.key,
          request_hash: record.requestHash,
          response_status: record.status,
          response_body: record.body,
          // 验签失败时没有 sub，此列为空；它只是排障线索，不参与任何判定。
          actor_user_id: record.actorId ?? null,
          expires_at: new Date(now() + ttlMs).toISOString(),
        },
      });
    },
  };
}
