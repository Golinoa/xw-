/**
 * 私有授权 API（契约 §5.6 `GET|POST /licenses`、`GET /licenses/{id}`）。
 *
 * 两条与 SaaS 订阅不同的硬约束：
 * 1. `license_mode='perpetual'` ⇔ `valid_to IS NULL`（契约 §3.5 CHECK）；
 * 2. **永久授权 ≠ 永久更新**：维护期 `maintenanceUntil` 单独展示，绝不由授权方式推导
 *    （PRD §6.6 明文要求）。
 */
import type {
  CreateLicenseInput,
  CreateLicenseResult,
  EntitlementTransitionInput,
  EntitlementTransitionResult,
  LicenseDetail,
  LicenseListQuery,
  LicenseListResult,
} from './types';

import {
  buildEntitlementListParams,
  createIdempotencyKey,
  ENTITLEMENT_ENDPOINTS,
  LICENSE_FILTER_KEYS,
  requestClient,
  writeConfig,
} from './endpoints';

/** 授权列表（服务端分页/筛选）。 */
export async function fetchLicenses(
  query: LicenseListQuery = {},
): Promise<LicenseListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListLicenses } = await import('./dev-stub');
    return stubListLicenses(query);
  }
  return requestClient.get<LicenseListResult>(ENTITLEMENT_ENDPOINTS.licenses, {
    params: buildEntitlementListParams(query, LICENSE_FILTER_KEYS),
  });
}

/** 授权详情：当前快照、快照历史、变更申请、部署实例。 */
export async function fetchLicense(licenseId: string): Promise<LicenseDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetLicense } = await import('./dev-stub');
    return stubGetLicense(licenseId);
  }
  return requestClient.get<LicenseDetail>(
    ENTITLEMENT_ENDPOINTS.license(licenseId),
  );
}

/** 创建授权草稿（`entitlement.request`）。永久授权不填 `validTo`。 */
export async function createLicense(
  input: CreateLicenseInput,
): Promise<CreateLicenseResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateLicense } = await import('./dev-stub');
    return stubCreateLicense(input);
  }
  return requestClient.post<CreateLicenseResult>(
    ENTITLEMENT_ENDPOINTS.licenses,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 草稿期状态流转（`submit`/`approve`/`reject`）；生效后只能走变更申请。 */
export async function transitionLicense(
  licenseId: string,
  input: EntitlementTransitionInput,
): Promise<EntitlementTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionLicense } = await import('./dev-stub');
    return stubTransitionLicense(licenseId, input);
  }
  return requestClient.post<EntitlementTransitionResult>(
    ENTITLEMENT_ENDPOINTS.licenseTransition(licenseId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
