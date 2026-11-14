/**
 * 系统设置的取值范围与「只提交改动项」规则。
 *
 * 范围来源：契约 §5.9 `PATCH /settings` —「窗口 1–365 天、工单时限 1–720 小时」[推导]。
 * `retention.exportDays`（导出产物保留天数）契约**没有给范围**，因此这里只校验
 * 「正整数」，越界由服务端 400 拒绝。前端不编一个上限出来——编了就会在真实上限更大时
 * 拦住合法配置，编小了是误导，编大了等于没校验。
 *
 * 前端校验只为减少一次往返与给出即时提示，**不是**授权或数据合法性依据；
 * 服务端会再次校验。
 */
import type { OpsSettings, UpdateSettingsPayload } from './types';

export interface SettingsFieldLimit {
  /** 字段中文名，用于提示文案。 */
  label: string;
  /** 上限；`null` 表示契约未定义，前端不做上限校验。 */
  max: null | number;
  min: number;
  unit: string;
}

export const SETTINGS_LIMITS: Readonly<
  Record<keyof OpsSettings, SettingsFieldLimit>
> = {
  exportRetentionDays: {
    label: '导出产物保留',
    max: null,
    min: 1,
    unit: '天',
  },
  overviewExpiryWindowDays: {
    label: '临期权益窗口',
    max: 365,
    min: 1,
    unit: '天',
  },
  ticketDueHours: {
    label: '工单内部时限',
    max: 720,
    min: 1,
    unit: '小时',
  },
};

/** 系统设置字段顺序（界面渲染顺序与提示顺序都以此为准）。 */
export const SETTINGS_FIELD_ORDER: readonly (keyof OpsSettings)[] = [
  'overviewExpiryWindowDays',
  'ticketDueHours',
  'exportRetentionDays',
];

export const SETTINGS_RANGE_NOTE =
  '窗口与时限范围取自契约 §5.9（1–365 天、1–720 小时）；导出保留天数契约未定义上限，越界由服务端拒绝。';

export type SettingsValidation =
  | { message: string; ok: false }
  | { ok: true; value: number };

/**
 * 校验单个设置项。
 *
 * 只接受非负整数：小数（如 1.5 天）在服务端是无效值，若前端放过去，
 * 用户会在提交后才看到 400，且不知道该改成什么。
 */
export function validateSettingsValue(
  key: keyof OpsSettings,
  raw: number | string,
): SettingsValidation {
  const limit = SETTINGS_LIMITS[key];
  const text = String(raw).trim();
  if (text === '') {
    return { message: `请填写${limit.label}`, ok: false };
  }
  if (!/^\d+$/.test(text)) {
    return {
      message: `${limit.label}必须是整数（单位：${limit.unit}）`,
      ok: false,
    };
  }
  const value = Number(text);
  if (value < limit.min) {
    return {
      message: `${limit.label}不能小于 ${limit.min} ${limit.unit}`,
      ok: false,
    };
  }
  if (limit.max !== null && value > limit.max) {
    return {
      message: `${limit.label}不能大于 ${limit.max} ${limit.unit}`,
      ok: false,
    };
  }
  return { ok: true, value };
}

/** 只保留发生变化的字段（`PATCH` 语义：不发的字段视为不改）。 */
export function diffSettings(
  original: OpsSettings,
  draft: OpsSettings,
): Partial<OpsSettings> {
  const changed: Partial<OpsSettings> = {};
  for (const key of SETTINGS_FIELD_ORDER) {
    if (original[key] !== draft[key]) {
      changed[key] = draft[key];
    }
  }
  return changed;
}

export type SettingsPatchResult =
  | { changed: (keyof OpsSettings)[]; ok: true; payload: UpdateSettingsPayload }
  | { issues: Partial<Record<keyof OpsSettings, string>>; ok: false };

/**
 * 生成 `PATCH /settings` 请求体。
 *
 * 三件事一次做完，避免页面各写一遍：
 * 1. 逐项范围校验（返回按字段聚合的提示，便于表单就地标红）；
 * 2. 只保留改动项——全量提交会让「两人各改一项」时后提交者回滚前一项；
 * 3. 附带 `reason`（设置变更属敏感操作，写审计）。
 *
 * 没有任何改动时返回成功但 `changed` 为空，由调用方禁用提交（不发空请求）。
 */
export function buildSettingsPatch(
  original: OpsSettings,
  draft: OpsSettings,
  reason: string,
): SettingsPatchResult {
  const issues: Partial<Record<keyof OpsSettings, string>> = {};
  const normalized: OpsSettings = { ...original };
  for (const key of SETTINGS_FIELD_ORDER) {
    const result = validateSettingsValue(key, draft[key]);
    if (result.ok) {
      normalized[key] = result.value;
    } else {
      issues[key] = result.message;
    }
  }
  if (Object.keys(issues).length > 0) {
    return { issues, ok: false };
  }
  const changed = diffSettings(original, normalized);
  return {
    changed: Object.keys(changed) as (keyof OpsSettings)[],
    ok: true,
    payload: { ...changed, reason: reason.trim() },
  };
}
