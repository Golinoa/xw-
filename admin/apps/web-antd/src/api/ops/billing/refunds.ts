/**
 * 退款 API（契约 §5.5、§11 U-03）。
 *
 * 首期**不调用**银行/支付渠道发起退款，只登记线下退款事实并关联原收款；
 * 退款以独立记录呈现，不修改原收款金额。
 */
import type {
  CreateRefundInput,
  CreateRefundResult,
  RefundListQuery,
  RefundListResult,
  RefundTransitionInput,
  RefundTransitionResult,
} from './types';

import {
  BILLING_ENDPOINTS,
  buildListParams,
  createIdempotencyKey,
  requestClient,
  writeConfig,
} from './endpoints';

/** 退款列表（服务端分页/筛选）。 */
export async function fetchRefunds(
  query: RefundListQuery = {},
): Promise<RefundListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListRefunds } = await import('./dev-stub');
    return stubListRefunds(query);
  }
  return requestClient.get<RefundListResult>(BILLING_ENDPOINTS.refunds, {
    params: buildListParams(query),
  });
}

/** 登记退款（关联原收款；超过可退款净额时服务端返回 409 `REFUND_EXCEEDED`）。 */
export async function createRefund(
  input: CreateRefundInput,
): Promise<CreateRefundResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateRefund } = await import('./dev-stub');
    return stubCreateRefund(input);
  }
  return requestClient.post<CreateRefundResult>(
    BILLING_ENDPOINTS.refunds,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 退款审核/取消。高风险动作：必须 `reason`。 */
export async function transitionRefund(
  refundId: string,
  input: RefundTransitionInput,
): Promise<RefundTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionRefund } = await import('./dev-stub');
    return stubTransitionRefund(refundId, input);
  }
  return requestClient.post<RefundTransitionResult>(
    BILLING_ENDPOINTS.refundTransition(refundId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
