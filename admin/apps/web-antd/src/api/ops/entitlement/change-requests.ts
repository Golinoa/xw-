/**
 * 权益变更申请 API（契约 §5.6）。
 *
 * 状态机（契约 §3.5「变更申请状态机（推导）」，登记 U-04）：
 * `draft --submit--> pending_approval --approve--> approved --execute--> executing → executed`
 * `pending_approval --reject--> rejected`；`approved/executing --fail--> failed --retry--> executing`
 * `draft/pending_approval/approved --cancel--> cancelled`
 *
 * 关键约束：
 * - `approve`/`reject` 需 `entitlement.approve`，`execute`/`retry`/`cancel` 需
 *   `entitlement.execute`（`retry` 另需 `tenant.retry`）；
 * - 未审批即执行 → 409 `STATE_CONFLICT` + `details.reason='APPROVAL_REQUIRED'`；
 * - `approved_by <> requested_by`（数据库 CHECK），申请人不能自批；
 * - `execute` 返回 202 + `command{id,status}`，是**异步命令**，不能当同步结果用。
 */
import type {
  ChangeRequestDetail,
  ChangeRequestListQuery,
  ChangeRequestListResult,
  ChangeRequestTransitionInput,
  ChangeRequestTransitionResult,
  CreateChangeRequestInput,
  CreateChangeRequestResult,
} from './types';

import {
  buildEntitlementListParams,
  CHANGE_REQUEST_FILTER_KEYS,
  createIdempotencyKey,
  ENTITLEMENT_ENDPOINTS,
  requestClient,
  writeConfig,
} from './endpoints';

/** 变更申请列表（服务端分页/筛选）。 */
export async function fetchChangeRequests(
  query: ChangeRequestListQuery = {},
): Promise<ChangeRequestListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListChangeRequests } = await import('./dev-stub');
    return stubListChangeRequests(query);
  }
  return requestClient.get<ChangeRequestListResult>(
    ENTITLEMENT_ENDPOINTS.changeRequests,
    { params: buildEntitlementListParams(query, CHANGE_REQUEST_FILTER_KEYS) },
  );
}

/** 变更申请详情：含 `diff{before,after}` 与关联命令。 */
export async function fetchChangeRequest(
  changeRequestId: string,
): Promise<ChangeRequestDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetChangeRequest } = await import('./dev-stub');
    return stubGetChangeRequest(changeRequestId);
  }
  return requestClient.get<ChangeRequestDetail>(
    ENTITLEMENT_ENDPOINTS.changeRequest(changeRequestId),
  );
}

/** 订阅变更申请：409 `STATE_CONFLICT` = 订阅不在 `active`/`suspended`。 */
export async function createSubscriptionChangeRequest(
  subscriptionId: string,
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateSubscriptionChangeRequest } = await import('./dev-stub');
    return stubCreateSubscriptionChangeRequest(subscriptionId, input);
  }
  return requestClient.post<CreateChangeRequestResult>(
    ENTITLEMENT_ENDPOINTS.subscriptionChangeRequests(subscriptionId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 授权变更申请（与订阅同构）。 */
export async function createLicenseChangeRequest(
  licenseId: string,
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateLicenseChangeRequest } = await import('./dev-stub');
    return stubCreateLicenseChangeRequest(licenseId, input);
  }
  return requestClient.post<CreateChangeRequestResult>(
    ENTITLEMENT_ENDPOINTS.licenseChangeRequests(licenseId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 变更申请状态流转（`approve`/`reject`/`execute`/`retry`/`cancel`）。
 *
 * 不接受「直接设置 status」：动作名与目标态由服务端状态机决定，前端只提交动作 + 原因 + 版本。
 */
export async function transitionChangeRequest(
  changeRequestId: string,
  input: ChangeRequestTransitionInput,
): Promise<ChangeRequestTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionChangeRequest } = await import('./dev-stub');
    return stubTransitionChangeRequest(changeRequestId, input);
  }
  return requestClient.post<ChangeRequestTransitionResult>(
    ENTITLEMENT_ENDPOINTS.changeRequestTransition(changeRequestId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
