/**
 * 账款域金额处理（展示与输入校验专用）。
 *
 * 铁律（`Docs/ops-api-contract.md` §2.2）：
 * 1. 金额在服务端用 `numeric(14,2)` 存储，JSON 传输为 `number`（最多 2 位小数）；
 * 2. 前端**只格式化、不累加**：页面上的合计必须取服务端 `summary` 字段；
 * 3. 禁止 `parseFloat` 后计算再回写。本文件的一切比较/求和都走「整数分 + BigInt」，
 *    结果只用于**展示**与**提交前预校验**，服务端会再次复算并拒绝非法值；
 * 4. 提交给服务端的金额，是从用户输入的字符串**原样**转换出的 `number` 字面量，
 *    不存在"先算再写"的路径。
 *
 * 允许的例外只有一个：核销弹窗里的「本次核销合计 / 可分配余额」。
 * 前者是用户刚输入的明细行之和（契约要求分配总额 ≤ 收款可分配额，必须让用户先看到），
 * 后者在契约响应中没有直接字段，由 `amount - allocatedAmount` 精确推导。
 * 两者都只做提示，真正的判定在服务端事务里；差异见 journal 的契约推导待确认项。
 */

/** 金额小数位（契约固定 2 位）。 */
export const AMOUNT_SCALE = 2;

/** 单笔金额上限：`numeric(14,2)` 的 12 位整数部分（契约 §2.2）。 */
export const MAX_AMOUNT_CENTS = 99_999_999_999_999n;

/** 上限的十进制文本，用于校验提示。 */
export const MAX_AMOUNT_TEXT = '999999999999.99';

/**
 * 金额输入只接受非负、最多 2 位小数。
 * 整数位放宽到 15 位是为了给出「超过上限」而不是「格式错误」的准确提示，
 * 真正的上限由 `MAX_AMOUNT_CENTS` 判定。
 */
const AMOUNT_INPUT_PATTERN = /^(\d{1,15})(?:\.(\d{1,2}))?$/;

export const AMOUNT_EMPTY_TEXT = '—';

export type AmountParseError =
  | 'empty'
  | 'format'
  | 'negative'
  | 'too_large'
  | 'zero';

export type AmountParseResult =
  | { error: AmountParseError; ok: false }
  | { normalized: string; ok: true; value: number };

/** 校验提示文案。校验失败时不回显用户原值（契约 §2.4 校验失败约定）。 */
export const AMOUNT_ERROR_MESSAGE: Readonly<Record<AmountParseError, string>> =
  {
    empty: '请填写金额',
    format: '金额格式不正确，最多 12 位整数与 2 位小数',
    negative: '金额不能为负数',
    too_large: `金额不能超过 ${MAX_AMOUNT_TEXT}`,
    zero: '金额必须大于 0',
  };

function numberToCents(value: number): bigint {
  // 仅用于展示与预校验的定点化：契约保证入参已是 2 位小数，
  // 因此这里不存在"浮点累加"，只是把 double 还原成整数分。
  return BigInt(Math.round(value * 100));
}

function centsToAmountString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const integerPart = abs / 100n;
  const fractionPart = abs % 100n;
  return `${negative ? '-' : ''}${integerPart.toString()}.${fractionPart
    .toString()
    .padStart(2, '0')}`;
}

/**
 * 金额展示：千分位 + 固定 2 位小数。
 * `null` / `undefined` / 非有限数一律显示占位符，不隐式当成 0。
 */
export function formatAmount(
  value: null | number | undefined,
  placeholder: string = AMOUNT_EMPTY_TEXT,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return placeholder;
  }
  const cents = numberToCents(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const integerPart = (abs / 100n).toString();
  const fractionPart = (abs % 100n).toString().padStart(2, '0');
  const grouped = integerPart.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fractionPart}`;
}

/** 带币种的金额展示：CNY 用 ¥，其它 ISO-4217 用「代码 + 空格」。 */
export function formatMoney(
  value: null | number | undefined,
  currency?: null | string,
): string {
  const amount = formatAmount(value);
  if (amount === AMOUNT_EMPTY_TEXT) {
    return amount;
  }
  if (!currency) {
    return amount;
  }
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`;
}

const DECIMAL_TEXT_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * 已定型十进制字符串的展示（输入行合计、精确差值等）。
 * 只加千分位与补齐小数位，**不做任何数值换算**。
 */
export function formatAmountText(
  value: null | string | undefined,
  placeholder: string = AMOUNT_EMPTY_TEXT,
): string {
  if (!value || !DECIMAL_TEXT_PATTERN.test(value)) {
    return placeholder;
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '', fractionPart = ''] = unsigned.split('.');
  const grouped = integerPart.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fractionPart
    .padEnd(AMOUNT_SCALE, '0')
    .slice(0, AMOUNT_SCALE)}`;
}

/** 十进制字符串 + 币种。 */
export function formatMoneyText(
  value: null | string | undefined,
  currency?: null | string,
): string {
  const amount = formatAmountText(value);
  if (amount === AMOUNT_EMPTY_TEXT || !currency) {
    return amount;
  }
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`;
}

/**
 * 解析用户输入的金额字符串。
 *
 * 用字符串 + 正则校验，避免 `Number('1.005')` 这类浮点误差进入业务判断；
 * 通过后再做一次**单次字面量转换**（`Number('12.30')` → 12.3），交给请求体。
 */
export function parseAmountInput(raw: string): AmountParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { error: 'empty', ok: false };
  }
  if (trimmed.startsWith('-')) {
    return { error: 'negative', ok: false };
  }
  const match = AMOUNT_INPUT_PATTERN.exec(trimmed);
  if (!match) {
    return { error: 'format', ok: false };
  }
  const integerPart = match[1] ?? '';
  const fractionPart = (match[2] ?? '').padEnd(AMOUNT_SCALE, '0');
  const cents = BigInt(`${integerPart}${fractionPart}`);
  if (cents <= 0n) {
    return { error: 'zero', ok: false };
  }
  if (cents > MAX_AMOUNT_CENTS) {
    return { error: 'too_large', ok: false };
  }
  const normalized = centsToAmountString(cents);
  return { normalized, ok: true, value: Number(normalized) };
}

/** 金额字符串 → 整数分。输入非法时返回 `null`（调用方必须显式处理，不得当成 0）。 */
export function amountToCents(raw: string): bigint | null {
  const parsed = parseAmountInput(raw);
  if (!parsed.ok) {
    return null;
  }
  return BigInt(`${parsed.normalized.replace('.', '')}`);
}

/** 精确求和（整数分），用于展示「本次录入合计」，不用于生成请求体。 */
export function sumAmountStrings(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) {
    const cents = amountToCents(value);
    if (cents !== null) {
      total += cents;
    }
  }
  return centsToAmountString(total);
}

/** 服务端金额（number）精确求和，仅用于展示；权威合计必须取服务端字段。 */
export function sumAmounts(values: readonly number[]): string {
  let total = 0n;
  for (const value of values) {
    if (Number.isFinite(value)) {
      total += numberToCents(value);
    }
  }
  return centsToAmountString(total);
}

/** 服务端金额相减（`minuend - subtrahend`），返回 2 位小数字符串。 */
export function subtractAmounts(minuend: number, subtrahend: number): string {
  return centsToAmountString(
    numberToCents(minuend) - numberToCents(subtrahend),
  );
}

/** 比较两个金额字符串：`-1 | 0 | 1`；任一非法时返回 `null`。 */
export function compareAmountStrings(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  const leftCents = amountToCents(left);
  const rightCents = amountToCents(right);
  if (leftCents === null || rightCents === null) {
    return null;
  }
  if (leftCents === rightCents) {
    return 0;
  }
  return leftCents < rightCents ? -1 : 1;
}

/** 比较「用户输入金额」与「服务端金额」。返回 `null` 表示输入非法。 */
export function compareInputToAmount(
  input: string,
  amount: number,
): -1 | 0 | 1 | null {
  const inputCents = amountToCents(input);
  if (inputCents === null) {
    return null;
  }
  const amountCents = numberToCents(amount);
  if (inputCents === amountCents) {
    return 0;
  }
  return inputCents < amountCents ? -1 : 1;
}

/** 服务端金额转整数分（供规则模块做上限判断）。 */
export function amountToCentsFromNumber(value: number): bigint {
  return numberToCents(value);
}

/** 服务端金额是否为正数（用于「余额是否还有可核销空间」这类判断）。 */
export function isPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && numberToCents(value) > 0n;
}
