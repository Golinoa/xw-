import type { TouristDocumentType, TouristGender, TouristPersonType } from '@erp/contracts';

/**
 * 名单的展示词表。
 *
 * 数据库存的是稳定的英文码（`id_card` / `adult` / `male`），中文只出现在界面与
 * CSV 里。国标证件类型以后可能会加（比如外国人永久居留证），加的时候改这里
 * 与契约的枚举，历史数据不用动。
 */
export const TOURIST_DOCUMENT_TYPE_LABELS: Record<TouristDocumentType, string> = {
  id_card: '身份证',
  passport: '护照',
  hk_macau_permit: '港澳通行证',
  taiwan_permit: '台胞证',
};

export const TOURIST_PERSON_TYPE_LABELS: Record<TouristPersonType, string> = {
  adult: '成人',
  child: '儿童',
};

export const TOURIST_GENDER_LABELS: Record<TouristGender, string> = {
  male: '男',
  female: '女',
  unknown: '未知',
};

export const TOURIST_DOCUMENT_TYPE_OPTIONS = (
  Object.keys(TOURIST_DOCUMENT_TYPE_LABELS) as TouristDocumentType[]
).map((value) => ({ value, label: TOURIST_DOCUMENT_TYPE_LABELS[value] }));

export const TOURIST_PERSON_TYPE_OPTIONS = (
  Object.keys(TOURIST_PERSON_TYPE_LABELS) as TouristPersonType[]
).map((value) => ({ value, label: TOURIST_PERSON_TYPE_LABELS[value] }));

export const TOURIST_GENDER_OPTIONS = (Object.keys(TOURIST_GENDER_LABELS) as TouristGender[]).map(
  (value) => ({ value, label: TOURIST_GENDER_LABELS[value] }),
);

/**
 * 名单与申报人数的差额。
 *
 * 需求定的是「只警告，不阻止保存」，所以这两个数字只用于提示文案，
 * 不参与任何校验——校验会让「人数还没定就先录几个名字」变成不能存的状态。
 */
export function rosterDelta(roster: {
  adultCount: number;
  childCount: number;
  declaredAdultCount: number;
  declaredChildCount: number;
}): { adult: number; child: number } {
  return {
    adult: roster.adultCount - roster.declaredAdultCount,
    child: roster.childCount - roster.declaredChildCount,
  };
}

export function describeRosterDelta(delta: { adult: number; child: number }): string {
  const parts: string[] = [];
  if (delta.adult !== 0) {
    parts.push(`成人${delta.adult > 0 ? '多' : '少'} ${Math.abs(delta.adult)} 人`);
  }
  if (delta.child !== 0) {
    parts.push(`儿童${delta.child > 0 ? '多' : '少'} ${Math.abs(delta.child)} 人`);
  }
  return parts.join('、');
}

/**
 * 表格插槽里的 `record` 是 `any`，直接拿它索引词表在 `vue-tsc` 下不合法。
 * 这三个函数是唯一的入口：遇到未知码原样返回，而不是显示成空白——
 * 「码还在、词表落后了」应该被看见，不该被掩盖。
 */
function labelOf<K extends string>(labels: Record<K, string>, value: unknown): string {
  if (typeof value !== 'string') return '';
  return (labels as Record<string, string>)[value] ?? value;
}

export function documentTypeLabel(value: unknown): string {
  return labelOf(TOURIST_DOCUMENT_TYPE_LABELS, value);
}

export function personTypeLabel(value: unknown): string {
  return labelOf(TOURIST_PERSON_TYPE_LABELS, value);
}

export function genderLabel(value: unknown): string {
  return labelOf(TOURIST_GENDER_LABELS, value);
}
