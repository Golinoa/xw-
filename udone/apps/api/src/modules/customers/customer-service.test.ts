import { describe, expect, it } from 'vitest';
import { maskEmail, maskIdNumber, maskPhone, sanitizeKeyword } from './customer-service';

describe('customer masking', () => {
  it('keeps only the first three and last four digits of a phone number', () => {
    expect(maskPhone('138 0013 8000')).toBe('138****8000');
    expect(maskPhone('+86 138-0013-8000')).toBe('861****8000');
  });

  it('fully masks a phone number that is too short to split safely', () => {
    expect(maskPhone('12345')).toBe('*****');
    expect(maskPhone('')).toBe('');
  });

  it('masks the local part of an email but keeps the domain readable', () => {
    expect(maskEmail('zhangsan@example.com')).toBe('zh***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('keeps the first and last two characters of an identifier', () => {
    expect(maskIdNumber('110101199001011234')).toBe('11**************34');
    expect(maskIdNumber('1234')).toBe('****');
  });

  it('strips characters that would change the PostgREST filter grammar', () => {
    // 逗号和括号在 or=(...) 里是分隔符，星号是 ilike 通配符，必须清洗成空格。
    expect(sanitizeKeyword('张三,李四(测试)*')).toBe('张三 李四 测试');
    expect(sanitizeKeyword('  空格   折叠  ')).toBe('空格 折叠');
  });
});
