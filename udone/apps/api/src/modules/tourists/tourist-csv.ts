import type {
  TouristDocumentType,
  TouristGender,
  TouristImportError,
  TouristPersonType,
} from '@erp/contracts';

/**
 * 游客 CSV 的解析与校验（需求 §21.2）。
 *
 * 这一层是纯函数：不碰数据库、不碰 HTTP。理由是「预览」与「提交」必须由同一段
 * 代码决定结果——前端提交的仍然是那份原始 CSV，服务端每次都重新解析。如果预览
 * 走一条路、提交走另一条路，用户就会看到「预览全绿、提交报错」。
 *
 * 四条硬规则来自需求，写在这里以免被当成可选项：
 *   1. 列头固定八列，顺序固定。少一列或多一列都整批拒绝，不做「按名字猜位置」。
 *   2. 任何一行有问题就整批拒绝，返回逐行错误，不产生部分写入。
 *   3. 证件号为空不参与去重（去重键在库里，这里是同一套语义的预演）。
 *   4. 编码错误整批拒绝：`\uFFFD` 说明前端读文件时已经替换过非法字节，
 *      再解析下去就是把乱码写进数据库。
 */

/** 列头。顺序即契约，模板与解析共用这一份。 */
export const TOURIST_CSV_COLUMNS = [
  '姓名',
  '手机',
  '证件类型',
  '证件号',
  '成人/儿童',
  '年龄',
  '性别',
  '备注',
] as const;

/** 单次导入的行数上限：再多就该拆文件，而不是让一次请求占着 Worker。 */
export const TOURIST_IMPORT_MAX_ROWS = 2000;

/**
 * 模板只有列头，没有示例行。
 *
 * 示例行看起来更友好，但它会被老实导入成一个叫「张三」的游客——线上没人会
 * 先把示例删掉。取值说明改在导入弹窗里展示，模板本身保持「填什么就导什么」。
 */
export const TOURIST_CSV_TEMPLATE = `\uFEFF${TOURIST_CSV_COLUMNS.join(',')}\r\n`;

const DOCUMENT_TYPE_BY_LABEL: Record<string, TouristDocumentType> = {
  身份证: 'id_card',
  id_card: 'id_card',
  护照: 'passport',
  passport: 'passport',
  港澳通行证: 'hk_macau_permit',
  hk_macau_permit: 'hk_macau_permit',
  台胞证: 'taiwan_permit',
  taiwan_permit: 'taiwan_permit',
};

const PERSON_TYPE_BY_LABEL: Record<string, TouristPersonType> = {
  成人: 'adult',
  adult: 'adult',
  儿童: 'child',
  child: 'child',
};

const GENDER_BY_LABEL: Record<string, TouristGender> = {
  男: 'male',
  male: 'male',
  女: 'female',
  female: 'female',
  未知: 'unknown',
  unknown: 'unknown',
};

export interface ParsedTouristRow {
  line: number;
  name: string;
  phone?: string;
  documentType?: TouristDocumentType;
  documentNumber?: string;
  personType: TouristPersonType;
  age?: number;
  gender: TouristGender;
  remark?: string;
}

export interface ParsedTouristCsv {
  /** 有效行（已通过逐行校验）。 */
  rows: ParsedTouristRow[];
  /** 逐行错误。行号与源文件一致，第 1 行是列头。 */
  errors: TouristImportError[];
  /** 数据行总数（不含列头与全空行）。 */
  totalRows: number;
}

/**
 * 证件号规范化：去空白、去连字符、统一大写。
 *
 * **与数据库生成列 `tourists.normalized_document_number` 是同一套规则的两份实现**，
 * 这是刻意接受的重复：预检要知道「这一行会不会撞上已有的人」，而唯一真源在库里。
 * 两份规则由两侧的测试各自钉住（`tourist-csv.test.ts` 与 `tourist_roster.sql`），
 * 任何一侧改了，另一侧的断言会立刻发现不一致。
 */
export function normalizeDocumentNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  return normalized === '' ? null : normalized;
}

interface CsvRecord {
  /** 这条记录在源文件里的物理起始行号。引号内换行会让记录号与行号分叉。 */
  line: number;
  cells: string[];
}

function parseRecords(input: string): { records: CsvRecord[]; error: string | null } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  const endField = () => {
    cells.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push({ line: recordLine, cells });
    cells = [];
    recordLine = line;
  };

  while (i < input.length) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (char === '\n') line += 1;
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field.trim() === '') {
      // 只有字段开头的引号才是引用符：`, "abc"` 里的引号当内容，
      // 免得一个手写的备注把整行解析成另一回事。
      field = '';
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += input[i + 1] === '\n' ? 2 : 1;
      line += 1;
      endRecord();
      continue;
    }
    if (char === '\n') {
      i += 1;
      line += 1;
      endRecord();
      continue;
    }
    field += char;
    i += 1;
  }

  if (inQuotes) return { records, error: '文件中存在没有闭合的引号' };
  // 最后一行没有换行符时也要收尾；全空尾巴（文件以换行结尾）不算一行。
  if (field !== '' || cells.length > 0) endRecord();
  return { records, error: null };
}

function blank(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * 解析整份 CSV。
 *
 * 返回的 `rows` **只包含通过逐行校验的数据**；只要有 `errors`，调用方就应拒绝整批。
 * 库层面的重复检查（同一订单已有的证件号）不在这里做——那需要读数据库，
 * 由服务层补上并合并进同一份 `errors`。
 */
export function parseTouristCsv(csv: string): ParsedTouristCsv {
  const errors: TouristImportError[] = [];
  const rows: ParsedTouristRow[] = [];
  const source = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;

  if (source.includes('\uFFFD') || source.includes('\u0000')) {
    return {
      rows: [],
      totalRows: 0,
      errors: [
        { line: 1, message: '文件不是有效的 UTF-8 文本，请用 Excel「另存为 CSV UTF-8」后重试' },
      ],
    };
  }
  if (source.trim() === '') {
    return { rows: [], totalRows: 0, errors: [{ line: 1, message: '文件是空的' }] };
  }

  const { records, error } = parseRecords(source);
  if (error) return { rows: [], totalRows: 0, errors: [{ line: 1, message: error }] };

  const header = records[0];
  if (!header) return { rows: [], totalRows: 0, errors: [{ line: 1, message: '文件是空的' }] };

  const headerCells = header.cells.map((cell) => blank(cell));
  if (headerCells.length !== TOURIST_CSV_COLUMNS.length) {
    return {
      rows: [],
      totalRows: 0,
      errors: [
        {
          line: 1,
          message: `列头应为 ${TOURIST_CSV_COLUMNS.length} 列（${TOURIST_CSV_COLUMNS.join(',')}），实际 ${headerCells.length} 列`,
        },
      ],
    };
  }
  for (const [index, expected] of TOURIST_CSV_COLUMNS.entries()) {
    if (headerCells[index] !== expected) {
      return {
        rows: [],
        totalRows: 0,
        errors: [
          {
            line: 1,
            message: `第 ${index + 1} 列应为「${expected}」，实际是「${headerCells[index] ?? ''}」`,
          },
        ],
      };
    }
  }

  const dataRecords = records.slice(1);
  let totalRows = 0;

  for (const record of dataRecords) {
    const cells = record.cells.map((cell) => cell.trim());
    if (cells.every((cell) => cell === '')) continue;
    totalRows += 1;

    if (totalRows > TOURIST_IMPORT_MAX_ROWS) {
      return {
        rows: [],
        totalRows,
        errors: [
          {
            line: record.line,
            message: `单次最多导入 ${TOURIST_IMPORT_MAX_ROWS} 行，请拆分成多个文件`,
          },
        ],
      };
    }

    if (cells.length !== TOURIST_CSV_COLUMNS.length) {
      errors.push({
        line: record.line,
        message: `该行有 ${cells.length} 列，应为 ${TOURIST_CSV_COLUMNS.length} 列`,
      });
      continue;
    }

    const [
      name,
      phone,
      documentTypeLabel,
      documentNumber,
      personTypeLabel,
      ageText,
      genderLabel,
      remark,
    ] = cells as [string, string, string, string, string, string, string, string];

    const rowErrors: string[] = [];
    if (!name) rowErrors.push('姓名不能为空');
    if (name.length > 50) rowErrors.push('姓名不能超过 50 个字');
    if (phone.length > 20) rowErrors.push('手机不能超过 20 个字符');
    if (remark.length > 500) rowErrors.push('备注不能超过 500 个字');

    let documentType: TouristDocumentType | undefined;
    if (documentTypeLabel) {
      const mapped = DOCUMENT_TYPE_BY_LABEL[documentTypeLabel];
      if (mapped) documentType = mapped;
      else
        rowErrors.push(
          `证件类型「${documentTypeLabel}」无法识别，只能是：身份证/护照/港澳通行证/台胞证`,
        );
    }
    if (documentNumber.length > 40) rowErrors.push('证件号不能超过 40 个字符');
    if (documentNumber && !documentType) {
      rowErrors.push('填了证件号就必须填证件类型');
    }

    let personType: TouristPersonType | undefined;
    if (!personTypeLabel) rowErrors.push('成人/儿童 不能为空');
    else {
      const mapped = PERSON_TYPE_BY_LABEL[personTypeLabel];
      if (mapped) personType = mapped;
      else rowErrors.push(`成人/儿童「${personTypeLabel}」无法识别，只能填：成人/儿童`);
    }

    let age: number | undefined;
    if (ageText) {
      if (!/^\d{1,3}$/.test(ageText)) rowErrors.push(`年龄「${ageText}」不是整数`);
      else {
        const parsed = Number.parseInt(ageText, 10);
        if (parsed > 150) rowErrors.push(`年龄「${ageText}」超出 0–150`);
        else age = parsed;
      }
    }

    let gender: TouristGender = 'unknown';
    if (genderLabel) {
      const mapped = GENDER_BY_LABEL[genderLabel];
      if (mapped) gender = mapped;
      else rowErrors.push(`性别「${genderLabel}」无法识别，只能填：男/女/未知`);
    }

    if (rowErrors.length > 0 || !personType) {
      errors.push({ line: record.line, message: rowErrors.join('；') });
      continue;
    }

    rows.push({
      line: record.line,
      name,
      ...(phone ? { phone } : {}),
      ...(documentType ? { documentType } : {}),
      ...(documentNumber ? { documentNumber } : {}),
      personType,
      ...(age === undefined ? {} : { age }),
      gender,
      ...(remark ? { remark } : {}),
    });
  }

  if (totalRows === 0) {
    errors.push({ line: 1, message: '文件里没有数据行，只有列头' });
  }

  return { rows, errors, totalRows };
}

/**
 * 批内重复：同一份文件里两行指向同一个人。
 *
 * 报在后出现的那一行上，并指出第一次出现在第几行——用户改文件时只需要改一处，
 * 提示里必须告诉他改哪一处。
 */
export function findBatchDuplicates(rows: readonly ParsedTouristRow[]): TouristImportError[] {
  const seen = new Map<string, number>();
  const errors: TouristImportError[] = [];
  for (const row of rows) {
    const normalized = normalizeDocumentNumber(row.documentNumber);
    if (!normalized || !row.documentType) continue;
    const key = `${row.documentType}:${normalized}`;
    const firstLine = seen.get(key);
    if (firstLine === undefined) {
      seen.set(key, row.line);
      continue;
    }
    errors.push({
      line: row.line,
      message: `与第 ${firstLine} 行是同一个证件（证件类型与证件号都相同）`,
    });
  }
  return errors;
}
