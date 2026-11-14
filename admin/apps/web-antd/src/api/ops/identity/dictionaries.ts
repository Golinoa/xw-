/**
 * 字典配置（契约 §5.9 `/dictionaries*`）。
 *
 * 字典是「内部配置的可选项」（收款方式、问题类型等，PRD §5.10 / §6.5 / §6.9）：
 * 停用（`isActive=false`）而不是删除，历史单据上的旧值仍要能显示出来。
 * 因此本文件**没有删除端点**，只有停用。
 */
import type {
  CreateDictionaryItemPayload,
  OpsDictionaryItem,
  OpsDictionaryList,
  UpdateDictionaryItemPayload,
} from './types';

import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS, writeConfig } from './endpoints';

/** 字典及其条目（任意已认证运营成员可读）。 */
export async function fetchDictionaries(): Promise<OpsDictionaryList> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListDictionaries } = await import('./dev-stub');
    return stubListDictionaries();
  }
  return requestClient.get<OpsDictionaryList>(OPS_ENDPOINTS.dictionaries);
}

/** 新增字典项（需 `settings.manage`，幂等必填）。同字典内 `value` 重复 → 409 `CONFLICT`。 */
export async function createDictionaryItem(
  dictionaryCode: string,
  payload: CreateDictionaryItemPayload,
  idempotencyKey: string,
): Promise<{ item: OpsDictionaryItem }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateDictionaryItem } = await import('./dev-stub');
    return stubCreateDictionaryItem(dictionaryCode, payload);
  }
  return requestClient.post<{ item: OpsDictionaryItem }>(
    OPS_ENDPOINTS.dictionaryItems(dictionaryCode),
    payload,
    writeConfig(idempotencyKey),
  );
}

/** 修改字典项（需 `settings.manage`，契约标为幂等可选——这里仍要求传键，规则统一）。 */
export async function updateDictionaryItem(
  itemId: string,
  payload: UpdateDictionaryItemPayload,
  idempotencyKey: string,
): Promise<{ item: OpsDictionaryItem }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateDictionaryItem } = await import('./dev-stub');
    return stubUpdateDictionaryItem(itemId, payload);
  }
  return requestClient.request<{ item: OpsDictionaryItem }>(
    OPS_ENDPOINTS.dictionaryItem(itemId),
    {
      data: payload,
      headers: writeConfig(idempotencyKey).headers,
      method: 'PATCH',
    },
  );
}
