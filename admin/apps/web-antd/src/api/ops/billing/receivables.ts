/**
 * 应收计划 API（契约 §5.5）。
 *
 * 本层只做「参数 → 端点 → 类型化响应」，不处理错误、不弹提示、不跳转；
 * 错误统一由 `#/api/request` 映射成 `OpsApiError`，页面再用 `describeBillingError` 呈现。
 */
import type {
  CreateReceivablePlanInput,
  CreateReceivablePlanResult,
  ExtendReceivableInput,
  ExtendReceivableResult,
  ReceivableDetail,
  ReceivableListQuery,
  ReceivableListResult,
} from './types';

import {
  BILLING_ENDPOINTS,
  buildListParams,
  createIdempotencyKey,
  requestClient,
  writeConfig,
} from './endpoints';

/** 应收列表（服务端分页/筛选，`summary` 为服务端口径合计）。 */
export async function fetchReceivables(
  query: ReceivableListQuery = {},
): Promise<ReceivableListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListReceivables } = await import('./dev-stub');
    return stubListReceivables(query);
  }
  return requestClient.get<ReceivableListResult>(
    BILLING_ENDPOINTS.receivables,
    {
      params: buildListParams(query),
    },
  );
}

/** 应收详情：含核销分配、展期记录、冲正流水（只追加，不覆盖）。 */
export async function fetchReceivable(
  receivableId: string,
): Promise<ReceivableDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetReceivable } = await import('./dev-stub');
    return stubGetReceivable(receivableId);
  }
  return requestClient.get<ReceivableDetail>(
    BILLING_ENDPOINTS.receivable(receivableId),
  );
}

/** 生成应收计划：只提交明细行，合计由服务端与合同金额复算（契约 §2.2）。 */
export async function createReceivablePlan(
  input: CreateReceivablePlanInput,
): Promise<CreateReceivablePlanResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateReceivablePlan } = await import('./dev-stub');
    return stubCreateReceivablePlan(input);
  }
  return requestClient.post<CreateReceivablePlanResult>(
    BILLING_ENDPOINTS.receivables,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 展期：仅未结清应收可展期；追加展期记录并保留原到期日，必须填原因。
 * 不额外增加审批（Task 5 负责人默认规则），但需要 `receivable.write` 且写审计。
 */
export async function extendReceivable(
  receivableId: string,
  input: ExtendReceivableInput,
): Promise<ExtendReceivableResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubExtendReceivable } = await import('./dev-stub');
    return stubExtendReceivable(receivableId, input);
  }
  return requestClient.post<ExtendReceivableResult>(
    BILLING_ENDPOINTS.receivableExtensions(receivableId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
