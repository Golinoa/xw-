import { describe, expect, it } from 'vitest';
import type { RestClient, RestInit } from './rest-client';
import { createOpsIdempotencyStore } from './ops-idempotency-store';

/**
 * 落库 store 的查询形状。
 *
 * 这里断言的是「发了什么请求」而不是「数据库里有什么」——后者由
 * `tests/integration/idempotency.test.ts` 用真实 PostgREST 覆盖。
 * 两边分工的理由：查询形状错了（少了 profile 头、少看了 expires_at、
 * 列名写错）在集成测试里会表现为 404 或「重放永不命中」，很难一眼看出是这个文件。
 */

interface RecordedCall {
  path: string;
  init: RestInit | undefined;
}

function fakeClient(rows: unknown[] = []) {
  const calls: RecordedCall[] = [];
  const client: RestClient = {
    rest<T>(path: string, init?: RestInit): Promise<T> {
      calls.push({ path, init });
      return Promise.resolve(rows as T);
    },
    restPage<T>(): Promise<{ rows: T[]; total: number }> {
      throw new Error('restPage is not used by the idempotency store');
    },
    auth(): Promise<Response> {
      throw new Error('auth is not used by the idempotency store');
    },
  };
  return { client, calls };
}

const NOW = Date.parse('2026-10-30T00:00:00.000Z');

describe('createOpsIdempotencyStore', () => {
  it('looks up by scope key, skips expired rows and reads through the ops profile', async () => {
    const { client, calls } = fakeClient([]);

    await createOpsIdempotencyStore({ client, now: () => NOW }).get('scope-key-1');

    const call = calls[0]!;
    expect(call.path).toContain('idempotency_records?');
    expect(call.path).toContain('scope_key=eq.scope-key-1');
    // 过期行不能被当成命中，否则回放会越过 TTL 无限延长。
    expect(call.path).toContain(`expires_at=gt.${encodeURIComponent('2026-10-30T00:00:00.000Z')}`);
    expect(call.path).toContain('select=response_status,response_body,request_hash,expires_at');
    expect(call.init?.profile).toBe('ops');
  });

  it('maps the database column names back to the store record', async () => {
    const { client } = fakeClient([
      {
        response_status: 201,
        response_body: { id: 'created' },
        request_hash: 'abc',
        expires_at: '2026-10-31T00:00:00.000Z',
      },
    ]);

    const record = await createOpsIdempotencyStore({ client, now: () => NOW }).get('scope-key-1');

    // request_hash 是列名、requestHash 是契约名；抄错一个不会报错，
    // 只会让「同 key 不同 body」永远判成冲突或永远放过。
    expect(record).toEqual({
      status: 201,
      body: { id: 'created' },
      requestHash: 'abc',
      expiresAt: Date.parse('2026-10-31T00:00:00.000Z'),
    });
  });

  it('returns null when nothing matches', async () => {
    const { client } = fakeClient([]);

    await expect(
      createOpsIdempotencyStore({ client, now: () => NOW }).get('missing'),
    ).resolves.toBeNull();
  });

  it('writes once and lets the unique constraint settle concurrent inserts', async () => {
    const { client, calls } = fakeClient();

    await createOpsIdempotencyStore({ client, now: () => NOW, ttlMs: 60_000 }).set('scope-key-1', {
      status: 200,
      body: { ok: true },
      requestHash: 'abc',
    });

    const call = calls[0]!;
    expect(call.init?.method).toBe('POST');
    expect(call.init?.profile).toBe('ops');
    // 并发时由唯一约束决定谁留下；输的一方不能报错——它已经回复过调用方了。
    expect(new Headers(call.init?.headers).get('Prefer')).toBe(
      'return=minimal,resolution=ignore-duplicates',
    );
    expect(call.init?.body).toEqual({
      scope_key: 'scope-key-1',
      request_hash: 'abc',
      response_status: 200,
      response_body: { ok: true },
      // 验签失败时没有 sub；这一列只是排障线索，缺失即写 null。
      actor_id: null,
      expires_at: '2026-10-30T00:01:00.000Z',
    });
  });

  it('records the actor when the caller identity is known', async () => {
    const { client, calls } = fakeClient();

    await createOpsIdempotencyStore({ client, now: () => NOW }).set('scope-key-1', {
      status: 201,
      body: { id: 'created' },
      requestHash: 'abc',
      actorId: '9f1c2a7e-0000-4000-8000-000000000001',
    });

    expect((calls[0]!.init?.body as Record<string, unknown>).actor_id).toBe(
      '9f1c2a7e-0000-4000-8000-000000000001',
    );
  });
});
