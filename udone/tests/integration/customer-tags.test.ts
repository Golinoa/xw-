import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

/**
 * 标签管理的 HTTP 集成：route → service → PostgREST → RLS / 外键。
 *
 * 这里要验的是单测证明不了的三件事：
 * 1. 外键从 CASCADE 收紧成 RESTRICT 之后，删除被引用标签**真的**以 23503 回来；
 * 2. `Prefer: resolution=ignore-duplicates` + `on_conflict` 在真实 PostgREST 上是幂等的
 *    —— 这条假设写错只会在线上 400，pgTAP 与单测都覆盖不到；
 * 3. 批量打标在「有一个客户读不到」时**一行都不写**，而不是部分成功。
 */

interface TagEnvelope {
  tag: { id: string; name: string; color?: string };
}

interface CustomerEnvelope {
  customer: {
    id: string;
    name: string;
    version: number;
    tags: Array<{ id: string; name: string }>;
  };
}

interface TagListEnvelope {
  tags: Array<{ id: string; name: string }>;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createTag(name: string): Promise<string> {
  const response = await call<TagEnvelope>('/api/customer-tags', {
    method: 'POST',
    body: { name, color: '#1b2a4a' },
  });
  expectStatus(response, 201);
  return response.body.tag.id;
}

async function createCustomer(name: string, tagIds: string[]): Promise<string> {
  const response = await call<CustomerEnvelope>('/api/customers', {
    method: 'POST',
    body: { name, tagIds },
  });
  expectStatus(response, 201);
  return response.body.customer.id;
}

async function readTags(customerId: string): Promise<string[]> {
  const response = await call<CustomerEnvelope>(`/api/customers/${customerId}`);
  expectStatus(response, 200);
  return response.body.customer.tags.map((tag) => tag.name);
}

async function readVersion(customerId: string): Promise<number> {
  const response = await call<CustomerEnvelope>(`/api/customers/${customerId}`);
  expectStatus(response, 200);
  return response.body.customer.version;
}

describe('customer tags over HTTP', () => {
  it('renames a tag and reflects the new name on the customers that carry it', async () => {
    const original = uniqueName('标签');
    const renamed = uniqueName('改名后');
    const tagId = await createTag(original);
    const customerId = await createCustomer(uniqueName('客户'), [tagId]);

    await expect(readTags(customerId)).resolves.toEqual([original]);

    const renamedResponse = await call<TagEnvelope>(`/api/customer-tags/${tagId}`, {
      method: 'PATCH',
      body: { name: renamed },
    });
    expectStatus(renamedResponse, 200);
    expect(renamedResponse.body.tag.name).toBe(renamed);

    await expect(readTags(customerId)).resolves.toEqual([renamed]);
    const list = await call<TagListEnvelope>('/api/customer-tags');
    expectStatus(list, 200);
    expect(list.body.tags.map((tag) => tag.name)).toContain(renamed);
  });

  it('refuses to delete a tag that a customer still carries, with OBJECT_REFERENCED', async () => {
    const tagId = await createTag(uniqueName('被引用'));
    const customerId = await createCustomer(uniqueName('客户'), [tagId]);

    const blocked = await call(`/api/customer-tags/${tagId}`, { method: 'DELETE' });
    expectStatus(blocked, 409);
    expect((blocked.body as { code?: string }).code).toBe('OBJECT_REFERENCED');

    // 打标记录必须还在：CASCADE 会把它一起删掉，而这里连报错都不会有。
    await expect(readTags(customerId)).resolves.toHaveLength(1);

    // 解除引用后才删得掉。
    const cleared = await call(`/api/customers/${customerId}`, {
      method: 'PATCH',
      body: { tagIds: [], version: await readVersion(customerId) },
    });
    expectStatus(cleared, 200);

    const deleted = await call(`/api/customer-tags/${tagId}`, { method: 'DELETE' });
    expectStatus(deleted, 200);
    expect((deleted.body as { deletedTagId: string }).deletedTagId).toBe(tagId);
  });

  it('applies a batch tag idempotently, so a retried request does not conflict', async () => {
    const tagId = await createTag(uniqueName('批量'));
    const first = await createCustomer(uniqueName('客户甲'), []);
    const second = await createCustomer(uniqueName('客户乙'), []);

    const body = { customerIds: [first, second], addTagIds: [tagId] };
    const applied = await call<{ updatedCustomerIds: string[] }>('/api/customers/batch-tags', {
      method: 'POST',
      body,
    });
    expectStatus(applied, 200);
    expect(applied.body.updatedCustomerIds.sort()).toEqual([first, second].sort());

    // 同一批再来一次：主键冲突必须被 ignore-duplicates 吃掉，而不是 409。
    const retried = await call('/api/customers/batch-tags', { method: 'POST', body });
    expectStatus(retried, 200);

    await expect(readTags(first)).resolves.toHaveLength(1);
    await expect(readTags(second)).resolves.toHaveLength(1);

    // 移除同样可重复执行。
    const removed = await call('/api/customers/batch-tags', {
      method: 'POST',
      body: { customerIds: [first, second], removeTagIds: [tagId] },
    });
    expectStatus(removed, 200);
    await expect(readTags(first)).resolves.toEqual([]);
    await expect(readTags(second)).resolves.toEqual([]);
  });

  it('writes nothing when one customer in the batch is not readable', async () => {
    const tagId = await createTag(uniqueName('整批回滚'));
    const customerId = await createCustomer(uniqueName('客户'), []);

    // 运营端里不存在的 UUID：读不到 → 整批拒绝。
    const response = await call('/api/customers/batch-tags', {
      method: 'POST',
      body: {
        customerIds: [customerId, '00000000-0000-4000-8000-000000000000'],
        addTagIds: [tagId],
      },
    });
    expectStatus(response, 404);

    await expect(readTags(customerId)).resolves.toEqual([]);
  });

  it('denies tag management to a finance reader', async () => {
    const tagId = await createTag(uniqueName('只读'));
    const response = await call(`/api/customer-tags/${tagId}`, {
      method: 'PATCH',
      actor: 'finance',
      body: { name: uniqueName('财务改名') },
    });
    expectStatus(response, 403);
  });
});
