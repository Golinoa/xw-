/**
 * SaaS 订阅 API（契约 §5.6 `GET|POST /subscriptions`、`GET /subscriptions/{id}`）。
 *
 * 状态机提醒（契约 §3.5）：
 * `— create_draft → draft --submit--> pending_approval --approve--> active`
 * `pending_approval --reject--> draft`；`active/suspended` 之后的状态推进**只能**
 * 通过变更申请（暂停/恢复/撤销/到期），本文件不提供「直接改状态」的函数。
 */
import type {
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  EntitlementTransitionInput,
  EntitlementTransitionResult,
  SubscriptionDetail,
  SubscriptionListQuery,
  SubscriptionListResult,
} from './types';

import {
  buildEntitlementListParams,
  createIdempotencyKey,
  ENTITLEMENT_ENDPOINTS,
  requestClient,
  SUBSCRIPTION_FILTER_KEYS,
  writeConfig,
} from './endpoints';

/** 订阅列表（服务端分页/筛选；不做客户端全量过滤）。 */
export async function fetchSubscriptions(
  query: SubscriptionListQuery = {},
): Promise<SubscriptionListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListSubscriptions } = await import('./dev-stub');
    return stubListSubscriptions(query);
  }
  return requestClient.get<SubscriptionListResult>(
    ENTITLEMENT_ENDPOINTS.subscriptions,
    { params: buildEntitlementListParams(query, SUBSCRIPTION_FILTER_KEYS) },
  );
}

/** 订阅详情：当前快照、快照历史、变更申请列表、租户映射。 */
export async function fetchSubscription(
  subscriptionId: string,
): Promise<SubscriptionDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetSubscription } = await import('./dev-stub');
    return stubGetSubscription(subscriptionId);
  }
  return requestClient.get<SubscriptionDetail>(
    ENTITLEMENT_ENDPOINTS.subscription(subscriptionId),
  );
}

/**
 * 创建订阅草稿（`entitlement.request`）。
 * 409 `STATE_CONFLICT` = 来源合同未生效/条目不属于该合同；
 * 409 `CONFLICT` = 同一条目重复开通（`UNIQUE` 防重复发放）。
 */
export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateSubscription } = await import('./dev-stub');
    return stubCreateSubscription(input);
  }
  return requestClient.post<CreateSubscriptionResult>(
    ENTITLEMENT_ENDPOINTS.subscriptions,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 草稿期状态流转（`submit` / `approve` / `reject`）。
 *
 * 只覆盖契约 §3.5 订阅/授权状态机的前三行；`active` 之后的暂停、撤销、到期
 * **必须**走变更申请（`createChangeRequest` + 审批 + 执行），界面不得直写终态。
 */
export async function transitionSubscription(
  subscriptionId: string,
  input: EntitlementTransitionInput,
): Promise<EntitlementTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionSubscription } = await import('./dev-stub');
    return stubTransitionSubscription(subscriptionId, input);
  }
  return requestClient.post<EntitlementTransitionResult>(
    ENTITLEMENT_ENDPOINTS.subscriptionTransition(subscriptionId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
