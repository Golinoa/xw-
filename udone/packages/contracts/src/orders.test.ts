import { describe, expect, it } from 'vitest';
import { createOrderRequestSchema, updateOrderRequestSchema } from './orders';

/**
 * 更新请求的金额行带 id 是这一版契约的关键变化：
 * 没有 id，服务端只能把旧行删掉重建，行上的 `confirmed_amount` 会归零。
 */
const base = {
  customerId: 'cust-1',
  orderType: 'active' as const,
  adultCount: 2,
  childCount: 0,
  receivables: [],
  payables: [],
  version: 1,
};

describe('updateOrderRequestSchema line identity', () => {
  it('keeps the id of an existing line', () => {
    const parsed = updateOrderRequestSchema.safeParse({
      ...base,
      receivables: [{ id: 'rec-1', name: '团费', amount: 7500 }],
      payables: [{ id: 'pay-1', name: '地接', amount: 4800, supplierId: 'sup-1' }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.receivables[0]?.id).toBe('rec-1');
    expect(parsed.data.payables[0]?.id).toBe('pay-1');
  });

  it('accepts a line without an id, meaning it is a new line', () => {
    const parsed = updateOrderRequestSchema.safeParse({
      ...base,
      receivables: [{ name: '新增自费项目', amount: 300 }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.receivables[0]?.id).toBeUndefined();
  });

  it('rejects the same receivable id twice', () => {
    const parsed = updateOrderRequestSchema.safeParse({
      ...base,
      receivables: [
        { id: 'rec-1', name: '团费', amount: 7500 },
        { id: 'rec-1', name: '团费重复', amount: 100 },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects the same payable id twice', () => {
    const parsed = updateOrderRequestSchema.safeParse({
      ...base,
      payables: [
        { id: 'pay-1', name: '地接', amount: 4800, supplierId: 'sup-1' },
        { id: 'pay-1', name: '地接重复', amount: 1, supplierId: 'sup-1' },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('still enforces two-decimal money on updated lines', () => {
    const parsed = updateOrderRequestSchema.safeParse({
      ...base,
      receivables: [{ id: 'rec-1', name: '团费', amount: 0.001 }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('createOrderRequestSchema', () => {
  it('does not carry line ids into a create request', () => {
    const parsed = createOrderRequestSchema.safeParse({
      ...base,
      receivables: [{ id: 'rec-1', name: '团费', amount: 7500 }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // 新建时行还不存在，id 只能是误传；把它留下来会让调用方以为自己指定了行号。
    expect(parsed.data.receivables[0]).not.toHaveProperty('id');
  });
});
