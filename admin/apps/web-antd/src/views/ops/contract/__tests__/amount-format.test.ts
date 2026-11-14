import { describe, expect, it } from 'vitest';

import {
  CONTRACT_ACTION_DATE_FIELD,
  CONTRACT_APPROVE_ACTIONS,
  CONTRACT_STATUS_LABEL,
  enumLabel,
  formatBytes,
  formatMoney,
  priceVersionLabel,
} from '../format';

describe('合同金额与快照展示', () => {
  it('金额按两位小数格式化，且不做币种换算', () => {
    expect(formatMoney(396_000, 'CNY')).toContain('396,000.00');
    expect(formatMoney(396_000, 'USD')).toContain('396,000.00');
    expect(formatMoney(396_000, 'USD')).not.toContain('¥');
    expect(formatMoney(Number.NaN, 'CNY')).toBe('—');
  });

  it('价格版本标签能指出「按哪一版价格签约」', () => {
    expect(priceVersionLabel(2)).toBe('价格版本 v2');
    expect(priceVersionLabel(null)).toBe('无价格版本');
  });

  it('未知状态降级显示而不是留白（契约 §2.6）', () => {
    expect(enumLabel(CONTRACT_STATUS_LABEL, 'active')).toBe('生效中');
    expect(enumLabel(CONTRACT_STATUS_LABEL, 'archived_v2')).toBe(
      '未知(archived_v2)',
    );
  });

  it('附件大小展示带单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(65_536)).toBe('64.0 KB');
    expect(formatBytes(1_048_576)).toBe('1.00 MB');
  });

  it('高风险动作集合与日期必填动作与契约一致', () => {
    expect([...CONTRACT_APPROVE_ACTIONS].toSorted()).toEqual([
      'activate',
      'expire',
      'sign',
      'terminate',
    ]);
    expect(CONTRACT_ACTION_DATE_FIELD.sign).toBe('signedOn');
    expect(CONTRACT_ACTION_DATE_FIELD.activate).toBe('effectiveOn');
    expect(CONTRACT_ACTION_DATE_FIELD.submit).toBeUndefined();
  });
});
