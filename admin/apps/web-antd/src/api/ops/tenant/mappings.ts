/**
 * 租户映射 API（契约 §5.7）。
 *
 * 映射是跨系统引用的**唯一**记录：一个 `udone_organization_id` 只能指向一个
 * 商业客户（`UNIQUE(udone_organization_id)`）。冲突由服务端 409 拒绝，
 * 前端**不提供**自动改绑。
 */
import type {
  CreateTenantMappingInput,
  CreateTenantMappingResult,
  TenantMappingDetail,
  TenantMappingListQuery,
  TenantMappingListResult,
  UpdateTenantMappingInput,
  UpdateTenantMappingResult,
} from './types';

import {
  buildMappingListParams,
  requestClient,
  TENANT_ENDPOINTS,
  writeConfig,
} from './endpoints';
/** 映射列表（服务端分页 / 状态 / 客户 / 同步版本筛选）。 */
export async function fetchMappings(
  query: TenantMappingListQuery = {},
): Promise<TenantMappingListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListMappings } = await import('./dev-stub');
    return stubListMappings(query);
  }
  return requestClient.get<TenantMappingListResult>(TENANT_ENDPOINTS.mappings, {
    params: buildMappingListParams(query),
  });
}

/** 映射详情：含最近 20 条命令（契约 §5.7）。 */
export async function fetchMapping(
  mappingId: string,
): Promise<TenantMappingDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetMapping } = await import('./dev-stub');
    return stubGetMapping(mappingId);
  }
  return requestClient.get<TenantMappingDetail>(
    TENANT_ENDPOINTS.mapping(mappingId),
  );
}

/**
 * 创建映射并发起开通。
 *
 * `idempotencyKey` 由调用方（表单打开时）生成并持有：同一表单重复点击、
 * 失败后重试都必须复用，否则会重复建映射。
 */
export async function createMapping(
  input: CreateTenantMappingInput,
  idempotencyKey: string,
): Promise<CreateTenantMappingResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateMapping } = await import('./dev-stub');
    return stubCreateMapping(input, idempotencyKey);
  }
  return requestClient.post<CreateTenantMappingResult>(
    TENANT_ENDPOINTS.mappings,
    input,
    writeConfig(idempotencyKey),
  );
}

/** 修改映射（仅 `pending` 允许改外部租户 ID；`version` 为乐观锁）。 */
export async function updateMapping(
  mappingId: string,
  input: UpdateTenantMappingInput,
  idempotencyKey: string,
): Promise<UpdateTenantMappingResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubUpdateMapping } = await import('./dev-stub');
    return stubUpdateMapping(mappingId, input);
  }
  return requestClient.request<UpdateTenantMappingResult>(
    TENANT_ENDPOINTS.mapping(mappingId),
    {
      data: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      method: 'PATCH',
    },
  );
}
