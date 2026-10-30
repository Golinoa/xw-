/**
 * 系统设置（契约 §5.9 `GET|PATCH /settings`）。
 *
 * `PATCH` 的幂等键与其它写操作一样由调用方在**打开编辑态时**生成一次并持有。
 * 设置项 `key` 白名单见契约 §3.9：`overview.expiryWindowDays` / `ticket.dueHours` /
 * `retention.exportDays`——前端不得提交白名单之外的键。
 */
import type {
  OpsSettings,
  OpsSettingsResponse,
  UpdateSettingsPayload,
} from './types';

import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS, writeConfig } from './endpoints';

/** 读取设置（需 `settings.manage`）。 */
export async function fetchSettings(): Promise<OpsSettingsResponse> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetSettings } = await import('./dev-stub');
    return stubGetSettings();
  }
  return requestClient.get<OpsSettingsResponse>(OPS_ENDPOINTS.settings);
}

/**
 * 修改设置（需 `settings.manage`，幂等必填）。
 *
 * 只发送被改动的项——全量覆盖会让「两个人各改一项」时后提交的人悄悄回滚前一项。
 */
export async function updateSettings(
  payload: UpdateSettingsPayload,
  idempotencyKey: string,
): Promise<{ settings: OpsSettings }> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateSettings } = await import('./dev-stub');
    return stubUpdateSettings(payload);
  }
  return requestClient.request<{ settings: OpsSettings }>(
    OPS_ENDPOINTS.settings,
    {
      data: payload,
      headers: writeConfig(idempotencyKey).headers,
      method: 'PATCH',
    },
  );
}
