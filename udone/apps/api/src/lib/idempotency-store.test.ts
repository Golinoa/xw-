import { describe, expect, it } from 'vitest';
import { createMemoryIdempotencyStore } from './idempotency-store';

/** 同一个命名空间下的槽；`scope` 与客户端 key 是两列，所以测试里也分开写。 */
function slot(key: string, scope = 'user:test-org:POST:/api/customers') {
  return { scope, key };
}

function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('createMemoryIdempotencyStore', () => {
  it('returns the stored response for a known key', async () => {
    const store = createMemoryIdempotencyStore();

    await store.set(slot('key-one'), {
      status: 201,
      body: { id: 'invitation-one' },
      requestHash: 'h1',
    });

    await expect(store.get(slot('key-one'))).resolves.toMatchObject({
      status: 201,
      body: { id: 'invitation-one' },
    });
  });

  it('returns null for an unknown key', async () => {
    const store = createMemoryIdempotencyStore();

    await expect(store.get(slot('never-seen'))).resolves.toBeNull();
  });

  it('expires an entry once the ttl has elapsed', async () => {
    const time = clock();
    const store = createMemoryIdempotencyStore({ ttlMs: 1_000, now: time.now });

    await store.set(slot('key-one'), { status: 200, body: { ok: true }, requestHash: 'h1' });
    time.advance(999);
    await expect(store.get(slot('key-one'))).resolves.not.toBeNull();

    time.advance(2);
    await expect(store.get(slot('key-one'))).resolves.toBeNull();
  });

  it('evicts the oldest entry when the store is full', async () => {
    const store = createMemoryIdempotencyStore({ maxEntries: 2 });

    await store.set(slot('first'), { status: 200, body: 1, requestHash: 'h1' });
    await store.set(slot('second'), { status: 200, body: 2, requestHash: 'h2' });
    await store.set(slot('third'), { status: 200, body: 3, requestHash: 'h3' });

    await expect(store.get(slot('first'))).resolves.toBeNull();
    await expect(store.get(slot('second'))).resolves.not.toBeNull();
    await expect(store.get(slot('third'))).resolves.not.toBeNull();
  });

  it('overwrites rather than duplicating on a repeated key', async () => {
    const store = createMemoryIdempotencyStore({ maxEntries: 2 });

    await store.set(slot('key-one'), { status: 200, body: 1, requestHash: 'h1' });
    await store.set(slot('key-one'), { status: 200, body: 2, requestHash: 'h2' });

    await expect(store.get(slot('key-one'))).resolves.toMatchObject({ body: 2 });
  });

  /**
   * 同一个客户端 key 落在不同命名空间时不能命中同一格。
   *
   * 这条是 `o-t02b` 的目的本身：幂等键由客户端生成，两个运营成员之间没有任何
   * 协调，撞同一个值是常态。命名空间若不参与，后到者会读到前一个人的响应体——
   * 看起来像「建成功了」，实际是别人的那条记录。
   */
  it('keeps the same client key in different scopes apart', async () => {
    const store = createMemoryIdempotencyStore();
    const key = 'shared-client-key';

    await store.set(slot(key, 'user:a:org:POST:/api/customers'), {
      status: 201,
      body: { id: 'first-operator' },
      requestHash: 'h1',
    });

    await expect(store.get(slot(key, 'user:b:org:POST:/api/customers'))).resolves.toBeNull();
    await expect(store.get(slot(key, 'user:a:org:POST:/api/customers'))).resolves.toMatchObject({
      body: { id: 'first-operator' },
    });
  });
});
