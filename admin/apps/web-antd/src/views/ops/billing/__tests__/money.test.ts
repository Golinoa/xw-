import { describe, expect, it } from 'vitest';

import {
  compareAmountStrings,
  compareInputToAmount,
  formatAmount,
  formatAmountText,
  formatMoney,
  formatMoneyText,
  parseAmountInput,
  subtractAmounts,
  sumAmounts,
  sumAmountStrings,
} from '#/api/ops/billing/money';

/**
 * 金额精度与格式化（金融页面第一优先）。
 * 断言值全部是"服务端会返回的那种" 2 位小数 number，或用户输入的字符串。
 */
describe('金额格式化', () => {
  it('千分位 + 固定 2 位小数', () => {
    expect(formatAmount(1_234_567.89)).toBe('1,234,567.89');
    expect(formatAmount(1000)).toBe('1,000.00');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(0.5)).toBe('0.50');
  });

  it('负数保留符号且不影响千分位', () => {
    expect(formatAmount(-1234.5)).toBe('-1,234.50');
    expect(formatAmount(-0.01)).toBe('-0.01');
  });

  it('缺失值不隐式当 0', () => {
    expect(formatAmount(null)).toBe('—');
    expect(formatAmount(undefined)).toBe('—');
    expect(formatAmount(Number.NaN)).toBe('—');
  });

  it('币种前缀：CNY 用 ¥，其它用 ISO 代码', () => {
    expect(formatMoney(5000, 'CNY')).toBe('¥5,000.00');
    expect(formatMoney(5000, 'USD')).toBe('USD 5,000.00');
    expect(formatMoney(null, 'CNY')).toBe('—');
  });

  it('已定型字符串只补位不换算', () => {
    expect(formatAmountText('1234.5')).toBe('1,234.50');
    expect(formatAmountText('-1234.5')).toBe('-1,234.50');
    expect(formatAmountText('abc')).toBe('—');
    expect(formatMoneyText('1234.5', 'CNY')).toBe('¥1,234.50');
  });
});

describe('金额输入校验（字符串 / 定点）', () => {
  it('合法输入同时给出一致的归一化结果', () => {
    expect(parseAmountInput('1200.5')).toEqual({
      normalized: '1200.50',
      ok: true,
      value: 1200.5,
    });
    expect(parseAmountInput(' 86,000 ')).toMatchObject({ ok: false });
    expect(parseAmountInput('86000')).toMatchObject({
      normalized: '86000.00',
      ok: true,
      value: 86_000,
    });
  });

  it('负数、零、空、超 2 位小数、超上限都被拒绝', () => {
    expect(parseAmountInput('-1')).toMatchObject({
      error: 'negative',
      ok: false,
    });
    expect(parseAmountInput('0')).toMatchObject({ error: 'zero', ok: false });
    expect(parseAmountInput('')).toMatchObject({ error: 'empty', ok: false });
    expect(parseAmountInput('1.005')).toMatchObject({
      error: 'format',
      ok: false,
    });
    expect(parseAmountInput('1e5')).toMatchObject({
      error: 'format',
      ok: false,
    });
    expect(parseAmountInput('1000000000000')).toMatchObject({
      error: 'too_large',
      ok: false,
    });
    expect(parseAmountInput('999999999999.99')).toMatchObject({ ok: true });
  });
});

describe('精确分运算只用于展示与预校验', () => {
  it('0.1 + 0.2 不会变成 0.30000000000000004', () => {
    expect(sumAmountStrings(['0.1', '0.2'])).toBe('0.30');
    expect(sumAmountStrings(['0.1', '0.2', '0.3'])).toBe('0.60');
    expect(sumAmounts([0.1, 0.2])).toBe('0.30');
  });

  it('非法输入不参与求和（显式忽略而不是当成 0 参与业务判断）', () => {
    expect(sumAmountStrings(['100.00', 'abc'])).toBe('100.00');
  });

  it('差值按整数分计算', () => {
    expect(subtractAmounts(120_000, 40_000)).toBe('80000.00');
    expect(subtractAmounts(0.3, 0.1)).toBe('0.20');
    expect(subtractAmounts(1, 3)).toBe('-2.00');
  });

  it('比较不受字符串形态影响', () => {
    expect(compareAmountStrings('0.3', '0.30')).toBe(0);
    expect(compareAmountStrings('0.29', '0.30')).toBe(-1);
    expect(compareAmountStrings('abc', '0.30')).toBeNull();
    expect(compareInputToAmount('120000.00', 120_000)).toBe(0);
    expect(compareInputToAmount('120000.01', 120_000)).toBe(1);
  });
});
