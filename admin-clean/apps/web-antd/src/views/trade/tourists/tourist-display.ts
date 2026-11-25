import type { TouristDocumentType, TouristGender, TouristPersonType } from '@erp/contracts';

/** 枚举值 → i18n 文案键。库里存稳定英文码，中文只出现在界面与 CSV。 */
export const TOURIST_DOCUMENT_TYPE_LABEL_KEYS: Record<TouristDocumentType, string> = {
  id_card: 'shell.tourists.docIdCard',
  passport: 'shell.tourists.docPassport',
  hk_macau_permit: 'shell.tourists.docHkMacau',
  taiwan_permit: 'shell.tourists.docTaiwan',
};

export const TOURIST_PERSON_TYPE_LABEL_KEYS: Record<TouristPersonType, string> = {
  adult: 'shell.tourists.personAdult',
  child: 'shell.tourists.personChild',
};

export const TOURIST_GENDER_LABEL_KEYS: Record<TouristGender, string> = {
  male: 'shell.tourists.genderMale',
  female: 'shell.tourists.genderFemale',
  unknown: 'shell.tourists.genderUnknown',
};

export const TOURIST_DOCUMENT_TYPES = Object.keys(TOURIST_DOCUMENT_TYPE_LABEL_KEYS) as TouristDocumentType[];
export const TOURIST_PERSON_TYPES = Object.keys(TOURIST_PERSON_TYPE_LABEL_KEYS) as TouristPersonType[];
export const TOURIST_GENDERS = Object.keys(TOURIST_GENDER_LABEL_KEYS) as TouristGender[];

/**
 * 名单与申报人数的差额。
 *
 * 需求是「只警告、不阻止保存」，所以这两个数字只用于提示，不参与任何校验——
 * 校验会让「人数还没定就先录几个名字」变成不能存的状态。
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

export function hasDelta(delta: { adult: number; child: number }): boolean {
  return delta.adult !== 0 || delta.child !== 0;
}

/** 差额的绝对人数，方向由组件用 i18n 词拼（多/少不能塞进数字插值）。 */
export function deltaParts(delta: { adult: number; child: number }): {
  adultCount: number;
  adultMore: boolean;
  childCount: number;
  childMore: boolean;
} {
  return {
    adultCount: Math.abs(delta.adult),
    adultMore: delta.adult > 0,
    childCount: Math.abs(delta.child),
    childMore: delta.child > 0,
  };
}

/** 表格 record 是 any，vue-tsc 下不可直接索引词表；未知码原样返回，不掩盖词表落后。 */
export function labelKeyOf<K extends string>(keys: Record<K, string>, value: unknown): string {
  if (typeof value !== 'string') return '';
  return (keys as Record<string, string>)[value] ?? value;
}
