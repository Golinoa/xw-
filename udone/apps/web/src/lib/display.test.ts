import { describe, expect, it } from 'vitest';
import { lookup } from './display';

/**
 * 这几条断言保护的是「表格不会渲染出诡异东西」，不是格式偏好：
 * 一个 `toString` 被当成标签输出，或者一片空白单元格，都比抛错更难定位。
 */

const LABELS: Record<'pending' | 'approved', string> = {
  pending: '待审批',
  approved: '已通过',
};

describe('lookup', () => {
  it('known keys map to their label', () => {
    expect(lookup(LABELS, 'pending')).toBe('待审批');
    expect(lookup(LABELS, 'approved')).toBe('已通过');
  });

  it('unknown enum values fall back instead of rendering undefined', () => {
    // 服务端新增枚举值、前端还没跟上时的样子。
    expect(lookup(LABELS, 'cancelled')).toBe('—');
    expect(lookup(LABELS, 'cancelled', '未知')).toBe('未知');
  });

  it('does not resolve inherited properties', () => {
    // `'toString' in LABELS` 为真，用 in 判断会把函数当标签吐出去。
    expect(lookup(LABELS, 'toString')).toBe('—');
    expect(lookup(LABELS, 'constructor')).toBe('—');
  });

  it('non-string values fall back', () => {
    expect(lookup(LABELS, undefined)).toBe('—');
    expect(lookup(LABELS, null)).toBe('—');
    expect(lookup(LABELS, 3)).toBe('—');
  });
});
