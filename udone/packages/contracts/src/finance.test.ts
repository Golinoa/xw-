import { describe, expect, it } from 'vitest';
import { summarizeAmountLines, summarizeOrderFinance } from './finance';

const baseOrder = {
  orderId: 'order-1',
  orderNumber: 'SO-20261029-000001',
  status: 'active' as const,
  personCount: 3,
};

describe('summarizeAmountLines', () => {
  it('adds up each bucket and derives outstanding and applicable', () => {
    const summary = summarizeAmountLines([
      { amount: 5000, confirmedAmount: 2000, pendingAmount: 1000 },
      { amount: 2500.5, confirmedAmount: 0, pendingAmount: 500.5 },
    ]);

    expect(summary).toEqual({
      total: 7500.5,
      confirmed: 2000,
      pending: 1500.5,
      // 未收含在途：待审申请还没到账，不能算已收。
      outstanding: 5500.5,
      // 可申请余额扣掉在途，否则同一笔钱会被申请两次。
      applicable: 4000,
    });
  });

  it('returns zeros for an order without lines', () => {
    expect(summarizeAmountLines([])).toEqual({
      total: 0,
      confirmed: 0,
      pending: 0,
      outstanding: 0,
      applicable: 0,
    });
  });

  it('keeps cent precision across many rows', () => {
    const lines = Array.from({ length: 100 }, () => ({
      amount: 0.07,
      confirmedAmount: 0,
      pendingAmount: 0,
    }));

    // 0.07 在二进制浮点下不可精确表示，累加 100 次会得到 7.000000000000001，
    // 这里必须收敛回 7，否则前端显示的合计会带一串小数尾巴。
    expect(summarizeAmountLines(lines).total).toBe(7);
  });
});

describe('summarizeOrderFinance', () => {
  /**
   * 唯一真源第 21 节的验收数据：2 成人 1 儿童、应收 7,500、应付 4,800，
   * 一笔收款 3,000、一笔付款 4,800。
   */
  const acceptance = {
    ...baseOrder,
    receivables: [{ amount: 7500, confirmedAmount: 3000, pendingAmount: 0 }],
    payables: [{ amount: 4800, confirmedAmount: 4800, pendingAmount: 0 }],
  };

  it('reproduces the acceptance figures', () => {
    expect(summarizeOrderFinance(acceptance)).toMatchObject({
      receivableTotal: 7500,
      confirmedReceivable: 3000,
      uncollectedAmount: 4500,
      applicableReceivable: 4500,
      payableTotal: 4800,
      confirmedPayable: 4800,
      unpaidAmount: 0,
      profit: 2700,
      grossMargin: 0.36,
      revenuePerPerson: 2500,
      collectionProgress: 0.4,
      paymentProgress: 1,
      netCashflow: -1800,
    });
  });

  it('reports null instead of zero when a ratio has no denominator', () => {
    const summary = summarizeOrderFinance({
      ...baseOrder,
      personCount: 0,
      receivables: [],
      payables: [],
    });

    // 0 会被读成「毛利率为零」，而实际含义是「还没有应收，算不出来」。
    expect(summary.grossMargin).toBeNull();
    expect(summary.revenuePerPerson).toBeNull();
    expect(summary.collectionProgress).toBeNull();
    expect(summary.paymentProgress).toBeNull();
    expect(summary.profit).toBe(0);
    expect(summary.netCashflow).toBe(0);
  });

  it('keeps a negative margin when payables exceed receivables', () => {
    const summary = summarizeOrderFinance({
      ...baseOrder,
      receivables: [{ amount: 4000, confirmedAmount: 0, pendingAmount: 0 }],
      payables: [{ amount: 5000, confirmedAmount: 0, pendingAmount: 0 }],
    });

    expect(summary.profit).toBe(-1000);
    expect(summary.grossMargin).toBe(-0.25);
  });

  it('treats pending applications as not yet collected', () => {
    const summary = summarizeOrderFinance({
      ...baseOrder,
      receivables: [{ amount: 7500, confirmedAmount: 2000, pendingAmount: 500 }],
      payables: [],
    });

    expect(summary.confirmedReceivable).toBe(2000);
    expect(summary.pendingReceivable).toBe(500);
    expect(summary.uncollectedAmount).toBe(5500);
    expect(summary.applicableReceivable).toBe(5000);
    // 进度只看已确认到账的部分，在途不计入。
    expect(summary.collectionProgress).toBe(0.2667);
  });

  it('rounds ratios to four decimals and money to cents', () => {
    const summary = summarizeOrderFinance({
      ...baseOrder,
      personCount: 7,
      receivables: [{ amount: 10000, confirmedAmount: 0, pendingAmount: 0 }],
      payables: [{ amount: 3333.33, confirmedAmount: 0, pendingAmount: 0 }],
    });

    expect(summary.profit).toBe(6666.67);
    expect(summary.grossMargin).toBe(0.6667);
    // 10000 / 7 = 1428.5714...，金额按分四舍五入。
    expect(summary.revenuePerPerson).toBe(1428.57);
  });
});
