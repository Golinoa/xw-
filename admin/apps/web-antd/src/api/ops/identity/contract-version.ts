/**
 * 契约版本兼容判定（契约 §2.1、§8「不匹配即不渲染业务页」）。
 *
 * ## 为什么需要它
 *
 * 契约 §2.1 把「禁止静默回退 mock」写成决策，§8 把「`contractVersion` 不匹配
 * 拒绝渲染」写成验收项。但此前前端只把 `/meta` 用来取服务器日期，没有任何
 * 比对代码——注释声称做了校验、实际没做，比缺失更难发现。
 *
 * ## 兼容规则（与契约 §2.1 同步维护）
 *
 * 版本形态 `MAJOR.MINOR.PATCH`（缺省段按 0 补齐，允许 `-rc1` / `-stub` 等后缀）：
 * - **MAJOR 不等 → 不兼容**。破坏性变更，前端字段可能与后端对不上，
 *   继续渲染只会产生「字段莫名 undefined」这类更难排查的问题。
 * - **MINOR / PATCH 不等 → 兼容**。契约按加法演进，后端多返字段不影响前端；
 *   前端要多用字段必须先升 MINOR 并同步后端，因此不需要在此拦截。
 * - **格式非法 → 不兼容**。解析失败时不能假设兼容，否则一个返回 `''` 的
 *   半成品 `/meta` 会让整站看起来正常，属于静默降级。
 *
 * 注意：这里只做「前端 → 后端」的方向判定。后端若严格校验前端版本，应在
 * `/session` 或请求头里自行拒绝，前端不承担该方向。
 */

/**
 * 前端编译期锁定的契约版本。
 *
 * 必须与 `Docs/ops-api-contract.md` 的版本号手工对齐——两者不一致时以契约为准。
 * 后端 T-01 落地后由 `/meta` 返回真实版本，此处不再需要「等后端给版本号」的
 * 占位说明（见 `api/ops/README.md` 已同步更正）。
 */
export const OPS_CONTRACT_VERSION = '1.0.0';

export interface ContractVersion {
  major: number;
  minor: number;
  patch: number;
}

/** 不兼容的原因，供界面给出不同文案。 */
export type ContractMismatchReason = 'MAJOR_MISMATCH' | 'MALFORMED';

export type ContractCompatibility =
  | {
      actual: string;
      compatible: false;
      expected: string;
      reason: ContractMismatchReason;
    }
  | { actual: string; compatible: true; expected: string };

const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 解析 `MAJOR.MINOR[.PATCH][-prerelease][+build]`。
 *
 * 按 semver 接受预发布与构建元数据后缀（`1.0.0-rc1`、`1.0.0-stub`）：兼容判定
 * 只看 MAJOR，后缀不影响结论。开发态桩刻意用 `1.0.0-stub` 标明「不是真后端」，
 * 若这里拒绝后缀，桩与真实 API 就会走出两套判定路径。
 *
 * 仍拒绝 `v1.0.0`、`^1.0.0` 这类非标准形态：版本由后端自述，替它猜测前缀语义
 * 只会在出问题时更难定位。
 */
export function parseContractVersion(raw: unknown): ContractVersion | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const matched = VERSION_PATTERN.exec(raw.trim());
  if (!matched) {
    return null;
  }
  const [, major, minor, patch] = matched;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch ?? '0'),
  };
}

/**
 * 判定后端自述版本是否可被当前前端接受。
 *
 * 返回判定对象而非抛异常：调用方既要「阻断渲染」，也要把
 * `actual` / `expected` 原样展示给运维，抛异常会丢掉这些信息。
 */
export function checkContractCompatibility(
  actual: unknown,
  expected: string = OPS_CONTRACT_VERSION,
): ContractCompatibility {
  const actualText = typeof actual === 'string' ? actual : String(actual ?? '');

  const parsedActual = parseContractVersion(actual);
  const parsedExpected = parseContractVersion(expected);

  // 期望值写错属于构建期缺陷，但在运行期也只能按不兼容处理：
  // 宁可阻断并暴露问题，也不能让一个写错的常量悄悄放行所有版本。
  if (!parsedExpected || !parsedActual) {
    return {
      actual: actualText,
      compatible: false,
      expected,
      reason: 'MALFORMED',
    };
  }

  if (parsedActual.major !== parsedExpected.major) {
    return {
      actual: actualText,
      compatible: false,
      expected,
      reason: 'MAJOR_MISMATCH',
    };
  }

  return { actual: actualText, compatible: true, expected };
}
