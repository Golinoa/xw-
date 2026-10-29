import { describe, expect, it } from 'vitest';
import {
  createFinanceApplicationRequestSchema,
  decideFinanceApplicationRequestSchema,
  financeApplicationListQuerySchema,
  financeApplicationReasonRequestSchema,
} from './finance-applications';

/**
 * 这些断言守的不是「schema 能跑」，而是几条会真的造成资金差的边界：
 * 0 元或三位小数的金额、驳回不写意见、撤回不写原因。
 * 每一条在数据库层也有对应的守卫，这里管的是「别让用户点完按钮才看到错误」。
 */

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'receipt',
    orderId: 'order-1',
    lineId: 'rec-1',
    amount: 3000,
    method: 'bank',
    occurredOn: '2026-10-29',
    ...overrides,
  };
}

describe('finance application create contract', () => {
  it('accepts a receipt against a receivable line', () => {
    const parsed = createFinanceApplicationRequestSchema.parse(createRequest());
    expect(parsed.amount).toBe(3000);
    expect(parsed.kind).toBe('receipt');
  });

  it('accepts a payment against a payable line', () => {
    const parsed = createFinanceApplicationRequestSchema.parse(
      createRequest({ kind: 'payment', lineId: 'pay-1', method: 'cash' }),
    );
    expect(parsed.kind).toBe('payment');
  });

  it('rejects a zero amount', () => {
    // 库上是 CHECK (amount > 0)；放过去只会换来一次 AMOUNT_INVALID 往返。
    const result = createFinanceApplicationRequestSchema.safeParse(createRequest({ amount: 0 }));
    expect(result.success).toBe(false);
  });

  it('rejects a negative amount', () => {
    const result = createFinanceApplicationRequestSchema.safeParse(createRequest({ amount: -1 }));
    expect(result.success).toBe(false);
  });

  it('rejects amounts with more than two decimals', () => {
    const result = createFinanceApplicationRequestSchema.safeParse(
      createRequest({ amount: 3000.005 }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown payment method', () => {
    const result = createFinanceApplicationRequestSchema.safeParse(
      createRequest({ method: 'cheque' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non ISO occurred date', () => {
    const result = createFinanceApplicationRequestSchema.safeParse(
      createRequest({ occurredOn: '2026/10/29' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a reference number longer than the column allows', () => {
    const result = createFinanceApplicationRequestSchema.safeParse(
      createRequest({ referenceNo: 'x'.repeat(65) }),
    );
    expect(result.success).toBe(false);
  });

  it('treats an empty reference number as invalid rather than as absent', () => {
    // 空串会被库原样存下，列表上出现一列「流水号：」后面什么都没有。
    const result = createFinanceApplicationRequestSchema.safeParse(
      createRequest({ referenceNo: '   ' }),
    );
    expect(result.success).toBe(false);
  });

  it('keeps the line kind explicit instead of inferring it from amount sign', () => {
    // 付款金额同样是正数：正负号从来不是收付的区分依据。
    const parsed = createFinanceApplicationRequestSchema.parse(
      createRequest({ kind: 'payment', lineId: 'pay-1' }),
    );
    expect(parsed.amount).toBeGreaterThan(0);
    expect(parsed.kind).toBe('payment');
  });
});

describe('finance application decision contract', () => {
  it('accepts an approval without an opinion', () => {
    const parsed = decideFinanceApplicationRequestSchema.parse({
      action: 'approve',
      version: 1,
    });
    expect(parsed.action).toBe('approve');
  });

  it('rejects a rejection without an opinion', () => {
    const result = decideFinanceApplicationRequestSchema.safeParse({
      action: 'reject',
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a rejection with a blank opinion', () => {
    const result = decideFinanceApplicationRequestSchema.safeParse({
      action: 'reject',
      opinion: '   ',
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a rejection with an opinion', () => {
    const parsed = decideFinanceApplicationRequestSchema.parse({
      action: 'reject',
      opinion: '金额与合同不一致',
      version: 3,
    });
    expect(parsed.opinion).toBe('金额与合同不一致');
  });

  it('refuses actions that the decide endpoint does not own', () => {
    // 撤回与撤销走各自的端点：它们要校验创建人与管理员，混进同一个 action 枚举
    // 会让「谁能做什么」变成一处 if 判断。
    for (const action of ['withdraw', 'undo']) {
      const result = decideFinanceApplicationRequestSchema.safeParse({ action, version: 1 });
      expect(result.success).toBe(false);
    }
  });

  it('requires a version for the optimistic lock', () => {
    const result = decideFinanceApplicationRequestSchema.safeParse({ action: 'approve' });
    expect(result.success).toBe(false);
  });
});

describe('finance application reason contract', () => {
  it('requires a non blank reason', () => {
    for (const reason of [undefined, '', '  ']) {
      const result = financeApplicationReasonRequestSchema.safeParse({ reason, version: 1 });
      expect(result.success).toBe(false);
    }
  });

  it('accepts a reason with a version', () => {
    const parsed = financeApplicationReasonRequestSchema.parse({
      reason: '客户临时取消',
      version: 2,
    });
    expect(parsed.reason).toBe('客户临时取消');
  });
});

describe('finance application list query', () => {
  it('defaults to newest first with the shared page size', () => {
    const parsed = financeApplicationListQuerySchema.parse({});
    expect(parsed).toMatchObject({ page: 1, pageSize: 15, sort: 'createdAt', order: 'desc' });
  });

  it('accepts the pending filter that the review queue uses', () => {
    const parsed = financeApplicationListQuerySchema.parse({ status: 'pending' });
    expect(parsed.status).toBe('pending');
  });

  it('rejects an unknown status value', () => {
    const result = financeApplicationListQuerySchema.safeParse({ status: 'waiting' });
    expect(result.success).toBe(false);
  });

  it('rejects a sort field outside the whitelist', () => {
    // PostgREST 的 order 参数在标识符位置，不能参数化绑定，只能白名单。
    const result = financeApplicationListQuerySchema.safeParse({ sort: 'status' });
    expect(result.success).toBe(false);
  });
});
