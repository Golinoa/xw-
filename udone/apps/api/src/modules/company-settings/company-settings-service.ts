import type { CompanySettings, CompanySettingsData } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

/** 公司配置仓储：读走 RPC，写只走 RPC，应用不直接碰表。 */
export interface CompanySettingsRepository {
  get(organizationId: string): Promise<CompanySettings>;
  update(
    organizationId: string,
    data: CompanySettingsData,
    expectedVersion: number,
  ): Promise<{ settings?: CompanySettings; error?: 'VERSION_CONFLICT' | 'INVALID_DATA' }>;
}

type SettingsRow = {
  organizationId: string;
  data: CompanySettingsData;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export function companySettingsRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): CompanySettingsRepository {
  const client = createRestClient(environment, token);

  return {
    async get(organizationId) {
      // 这个函数返回单个 jsonb，PostgREST 给的是对象而不是数组。
      const payload = await client.rest<SettingsRow | SettingsRow[]>('rpc/get_company_settings', {
        method: 'POST',
        organizationId,
      });
      const row = Array.isArray(payload) ? payload[0] : payload;
      return (
        row ?? {
          organizationId,
          data: {},
          version: 0,
          updatedAt: null,
          updatedBy: null,
        }
      );
    },

    async update(organizationId, data, expectedVersion) {
      const rows = await client.rest<
        Array<{ result: SettingsRow | null; error_code: string | null }>
      >('rpc/update_company_settings', {
        method: 'POST',
        organizationId,
        body: {
          requested_data: data,
          requested_expected_version: expectedVersion,
        },
      });
      const row = rows[0];
      if (row?.error_code === 'VERSION_CONFLICT') return { error: 'VERSION_CONFLICT' };
      if (row?.error_code === 'INVALID_DATA' || !row?.result) return { error: 'INVALID_DATA' };
      return { settings: row.result };
    },
  };
}
