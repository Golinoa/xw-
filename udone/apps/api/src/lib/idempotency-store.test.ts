import { describe, expect, it } from 'vitest';
import { createMemoryIdempotencyStore } from './idempotency-store';

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

    await store.set('key-one', { status: 201, body: { id: 'invitation-one' }, requestHash: 'h1' });

    await expect(store.get('key-one')).resolves.toMatchObject({
      status: 201,
      body: { id: 'invitation-one' },
    });
  });

  it('returns null for an unknown key', async () => {
    const store = createMemoryIdempotencyStore();

    await expect(store.get('never-seen')).resolves.toBeNull();
  });

  it('expires an entry once the ttl has elapsed', async () => {
    const time = clock();
    const store = createMemoryIdempotencyStore({ ttlMs: 1_000, now: time.now });

    await store.set('key-one', { status: 200, body: { ok: true }, requestHash: 'h1' });
    time.advance(999);
    await expect(store.get('key-one')).resolves.not.toBeNull();

    time.advance(2);
    await expect(store.get('key-one')).resolves.toBeNull();
  });

  it('evicts the oldest entry when the store is full', async () => {
    const store = createMemoryIdempotencyStore({ maxEntries: 2 });

    await store.set('first', { status: 200, body: 1, requestHash: 'h1' });
    await store.set('second', { status: 200, body: 2, requestHash: 'h2' });
    await store.set('third', { status: 200, body: 3, requestHash: 'h3' });

    await expect(store.get('first')).resolves.toBeNull();
    await expect(store.get('second')).resolves.not.toBeNull();
    await expect(store.get('third')).resolves.not.toBeNull();
  });

  it('overwrites rather than duplicating on a repeated key', async () => {
    const store = createMemoryIdempotencyStore({ maxEntries: 2 });

    await store.set('key-one', { status: 200, body: 1, requestHash: 'h1' });
    await store.set('key-one', { status: 200, body: 2, requestHash: 'h2' });

    await expect(store.get('key-one')).resolves.toMatchObject({ body: 2 });
  });
});
