import { describe, expect, it } from 'vitest';
import {
  TOURIST_CSV_TEMPLATE,
  findBatchDuplicates,
  normalizeDocumentNumber,
  parseTouristCsv,
} from './tourist-csv';

const HEADER = '姓名,手机,证件类型,证件号,成人/儿童,年龄,性别,备注';

/** 八列一行。用数组拼而不是手写逗号：少一个逗号会变成另一种错误，测试就白测了。 */
function line(
  name: string,
  phone = '',
  documentType = '',
  documentNumber = '',
  personType = '',
  age = '',
  gender = '',
  remark = '',
): string {
  return [name, phone, documentType, documentNumber, personType, age, gender, remark].join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('tourist CSV parsing', () => {
  it('ships a template that parses to a header with no data rows', () => {
    const parsed = parseTouristCsv(TOURIST_CSV_TEMPLATE);

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.totalRows).toBe(0);
    expect(parsed.errors[0]?.message).toContain('没有数据行');
  });

  it('maps the Chinese labels onto the stored codes', () => {
    const parsed = parseTouristCsv(
      csv(
        line('张一', '13800000101', '身份证', '110101199001011234', '成人', '36', '男', '备注一'),
      ),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      line: 2,
      name: '张一',
      phone: '13800000101',
      documentType: 'id_card',
      documentNumber: '110101199001011234',
      personType: 'adult',
      age: 36,
      gender: 'male',
      remark: '备注一',
    });
  });

  it('keeps a quoted remark with commas and escaped quotes intact', () => {
    const parsed = parseTouristCsv(
      csv(line('李二', '', '护照', 'E1', '儿童', '', '', '"他说""你好""，还带,逗号"')),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      name: '李二',
      gender: 'unknown',
      remark: '他说"你好"，还带,逗号',
    });
  });

  it('reports the physical line of a row that follows a multi-line quoted field', () => {
    const parsed = parseTouristCsv(
      csv(
        line('甲', '', '护照', 'E1', '成人', '30', '男', '"第一行\n第二行"'),
        line('乙', '', '', '', '成人', '40', '女'),
      ),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 4]);
  });

  it('rejects an unknown document type instead of guessing', () => {
    const parsed = parseTouristCsv(csv(line('张一', '', '驾照', 'E1', '成人', '36', '男')));

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('证件类型');
  });

  it('requires a document type whenever a number is present', () => {
    const parsed = parseTouristCsv(csv(line('张一', '', '', 'E1', '成人', '36', '男')));

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('必须填证件类型');
  });

  it('rejects a non-integer or out-of-range age', () => {
    const parsed = parseTouristCsv(
      csv(
        line('甲', '', '', '', '成人', '三十六', '男'),
        line('乙', '', '', '', '成人', '151', '男'),
      ),
    );

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors.map((error) => error.line)).toEqual([2, 3]);
  });

  it('rejects a row with the wrong number of columns', () => {
    const parsed = parseTouristCsv(csv('甲,,护照,E1,成人,30'));

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('6 列');
  });

  it('rejects the whole file when the header does not match', () => {
    const parsed = parseTouristCsv('姓名,电话,证件类型,证件号,成人/儿童,年龄,性别,备注\n张三');

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.line).toBe(1);
    expect(parsed.errors[0]?.message).toContain('第 2 列');
  });

  it('rejects a file that was decoded with replacement characters', () => {
    const parsed = parseTouristCsv(`${HEADER}\n张\uFFFD,13800000101,身份证,1,成人,1,男,`);

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('UTF-8');
  });

  it('requires the adult/child column instead of defaulting it', () => {
    const parsed = parseTouristCsv(csv(line('甲', '', '', '', '', '30', '男')));

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('成人/儿童');
  });

  it('skips fully empty rows without counting them', () => {
    const parsed = parseTouristCsv(csv(line('甲', '', '', '', '成人', '30', '男'), ',,,,,,,'));

    expect(parsed.totalRows).toBe(1);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('tourist document normalization', () => {
  it('strips spaces and hyphens and upper-cases the result', () => {
    expect(normalizeDocumentNumber(' 110101-19900101-1234 ')).toBe('110101199001011234');
    expect(normalizeDocumentNumber('e1234 5678')).toBe('E12345678');
  });

  it('treats a blank document number as absent', () => {
    expect(normalizeDocumentNumber('   ')).toBeNull();
    expect(normalizeDocumentNumber(undefined)).toBeNull();
  });

  it('flags two rows that only differ by formatting', () => {
    const parsed = parseTouristCsv(
      csv(
        line('甲', '', '身份证', '110101199001011234', '成人', '30', '男'),
        line('乙', '', '身份证', '110101-19900101-1234', '成人', '30', '男'),
      ),
    );
    const duplicates = findBatchDuplicates(parsed.rows);

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.line).toBe(3);
  });

  it('does not merge rows without a document number', () => {
    const parsed = parseTouristCsv(
      csv(line('甲', '', '', '', '成人', '30', '男'), line('乙', '', '', '', '成人', '30', '男')),
    );

    expect(findBatchDuplicates(parsed.rows)).toEqual([]);
  });
});
