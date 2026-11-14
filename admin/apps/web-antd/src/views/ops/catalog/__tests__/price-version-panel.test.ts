import type { PackagePriceVersion } from '#/api/ops/catalog';

import { mount } from '@vue/test-utils';

import { describe, expect, it } from 'vitest';

import PriceVersionPanel from '../components/price-version-panel.vue';
import { formatMoney, isValidAmount, priceVersionLabel } from '../format';

const VERSIONS: PackagePriceVersion[] = [
  {
    createdAt: '2026-06-18T03:10:00Z',
    createdBy: '示例商务甲',
    currency: 'CNY',
    effectiveFrom: '2026-07-01',
    id: 'pv-0001-2',
    price: 128_000,
    termMonths: 12,
    versionNo: 2,
  },
  {
    createdAt: '2025-12-20T02:00:00Z',
    createdBy: '示例商务甲',
    currency: 'CNY',
    effectiveFrom: '2026-01-01',
    id: 'pv-0001-1',
    price: 118_000,
    termMonths: 12,
    versionNo: 1,
  },
];

describe('金额格式化（只格式化不换算）', () => {
  it('两位小数与千分位', () => {
    expect(formatMoney(128_000, 'CNY')).toContain('128,000.00');
    expect(formatMoney(0, 'CNY')).toContain('0.00');
    expect(formatMoney(118_000.5, 'CNY')).toContain('118,000.50');
  });

  it('币种只影响符号，不做换算', () => {
    expect(formatMoney(128_000, 'USD')).toContain('128,000.00');
    expect(formatMoney(128_000, 'USD')).not.toContain('¥');
  });

  it('非法值降级为占位符而不是 0', () => {
    expect(formatMoney(Number.NaN, 'CNY')).toBe('—');
  });

  it('金额值域与精度校验（契约 §2.2 numeric(14,2)）', () => {
    expect(isValidAmount(0)).toBe(true);
    expect(isValidAmount(128_000.55)).toBe(true);
    expect(isValidAmount(-1)).toBe(false);
    expect(isValidAmount(1_000_000_000_000)).toBe(false);
    expect(isValidAmount(10.005)).toBe(false);
    expect(isValidAmount(undefined)).toBe(false);
  });
});

describe('price-version-panel 快照版本展示', () => {
  it('明确标出当前版本与历史快照，并显示版本价格', () => {
    const wrapper = mount(PriceVersionPanel, {
      props: {
        currency: 'CNY',
        currentPrice: 128_000,
        currentVersionNo: 2,
        versions: VERSIONS,
      },
    });

    const text = wrapper.text();
    expect(text).toContain('价格版本 v2');
    expect(text).toContain('当前生效价格');
    expect(text).toContain('128,000.00');
    expect(text).toContain('118,000.00');
    expect(text).toContain('历史快照');
    expect(text).toContain('价格版本只增不改');
  });

  it('无写权限时没有「新增价格版本」入口，历史版本也不提供编辑/删除', () => {
    const wrapper = mount(PriceVersionPanel, {
      props: { canWrite: false, currentVersionNo: 2, versions: VERSIONS },
    });

    expect(wrapper.find('[data-testid="create-price-version"]').exists()).toBe(
      false,
    );
    expect(wrapper.text()).not.toContain('编辑');
    expect(wrapper.text()).not.toContain('删除');
  });

  it('有写权限时只提供「新增价格版本」入口（改价必须新增版本）', async () => {
    const wrapper = mount(PriceVersionPanel, {
      props: { canWrite: true, currentVersionNo: 2, versions: VERSIONS },
    });

    const button = wrapper.find('[data-testid="create-price-version"]');
    expect(button.exists()).toBe(true);
    await button.trigger('click');
    expect(wrapper.emitted('create')).toHaveLength(1);
  });

  it('版本号缺失时降级文案不空白', () => {
    expect(priceVersionLabel(null)).toBe('无价格版本');
    expect(priceVersionLabel(7)).toBe('价格版本 v7');
  });
});
