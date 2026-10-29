/**
 * 权益域端点清单与请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.6。路径只在这里出现一次，命名空间变更
 * （v1 → v2）时不必满仓库搜索字符串。
 *
 * 契约推导（已登记 journal U-05/U-06）：
 * - `POST /subscriptions/{id}/transition`、`POST /licenses/{id}/transition`
 *   —— §3.5 状态机列出了 `submit`/`approve`/`reject` 三个动作与对应权限，但 §5.6
 *   只给了创建与详情端点；按 customer/contract 域同一形态补 `transition` 类端点。
 * - `GET /entitlement-snapshots` —— §5.6 只给了「按 id 查单条」，快照历史列表按
 *   §3.5「快照仅 INSERT、只能新增变更记录」推导而来。
 */
import type { RequestClientConfig } from '@vben/request';

import type { EntitlementListQuery } from './types';

import { getOpsEnv } from '#/api/adapter/env';
import { createRequestId } from '#/api/adapter/request-id';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

export const ENTITLEMENT_ENDPOINTS = {
  changeRequest: (changeRequestId: string) =>
    `${OPS_API_PREFIX}/entitlement-change-requests/${encodeURIComponent(changeRequestId)}`,
  changeRequestTransition: (changeRequestId: string) =>
    `${OPS_API_PREFIX}/entitlement-change-requests/${encodeURIComponent(changeRequestId)}/transition`,
  changeRequests: `${OPS_API_PREFIX}/entitlement-change-requests`,
  license: (licenseId: string) =>
    `${OPS_API_PREFIX}/licenses/${encodeURIComponent(licenseId)}`,
  licenseChangeRequests: (licenseId: string) =>
    `${OPS_API_PREFIX}/licenses/${encodeURIComponent(licenseId)}/change-requests`,
  licenseTransition: (licenseId: string) =>
    `${OPS_API_PREFIX}/licenses/${encodeURIComponent(licenseId)}/transition`,
  licenses: `${OPS_API_PREFIX}/licenses`,
  snapshot: (snapshotId: string) =>
    `${OPS_API_PREFIX}/entitlement-snapshots/${encodeURIComponent(snapshotId)}`,
  snapshots: `${OPS_API_PREFIX}/entitlement-snapshots`,
  subscription: (subscriptionId: string) =>
    `${OPS_API_PREFIX}/subscriptions/${encodeURIComponent(subscriptionId)}`,
  subscriptionChangeRequests: (subscriptionId: string) =>
    `${OPS_API_PREFIX}/subscriptions/${encodeURIComponent(subscriptionId)}/change-requests`,
  subscriptionTransition: (subscriptionId: string) =>
    `${OPS_API_PREFIX}/subscriptions/${encodeURIComponent(subscriptionId)}/transition`,
  subscriptions: `${OPS_API_PREFIX}/subscriptions`,
} as const;

/** 幂等键：写操作必填（契约 §2.5），格式 `[A-Za-z0-9_-]{8,128}`。 */
export function createIdempotencyKey(): string {
  return createRequestId();
}

/** 写请求配置：统一注入 `Idempotency-Key`。 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/** 列表查询的公共白名单（分页/排序，契约 §2.4）。 */
const COMMON_PARAM_KEYS = ['page', 'pageSize', 'sort', 'order'] as const;

/**
 * 组装列表查询参数。
 *
 * 契约把多值筛选写成 `status[]`（§5.6），这里按字面量发送 `status[]`，避免后端
 * 同时支持 `status=a,b` 与 `status=a&status=b` 两种形态。只透传白名单字段：
 * 查询对象里混入的其它键不会被悄悄发给后端（分页筛选一律走服务端，不做客户端过滤）。
 */
export function buildEntitlementListParams(
  query: EntitlementListQuery & { status?: string[] },
  extraKeys: readonly string[],
): Record<string, unknown> {
  const source = query as unknown as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of [...COMMON_PARAM_KEYS, ...extraKeys]) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params[key] = value;
  }
  if (query.status && query.status.length > 0) {
    params['status[]'] = [...query.status];
  }
  return params;
}

/** 订阅列表透传字段（`billingCycle`/`endsFrom`/`endsTo` 为契约推导，见 journal）。 */
export const SUBSCRIPTION_FILTER_KEYS = [
  'customerId',
  'productId',
  'billingCycle',
  'endsFrom',
  'endsTo',
  'expiringInDays',
] as const;

/** 授权列表透传字段。 */
export const LICENSE_FILTER_KEYS = [
  'customerId',
  'deploymentInstanceId',
  'licenseMode',
  'endsFrom',
  'endsTo',
  'expiringInDays',
] as const;

/** 变更申请列表透传字段。 */
export const CHANGE_REQUEST_FILTER_KEYS = [
  'subjectType',
  'customerId',
  'requestedBy',
  'changeType',
] as const;

export { requestClient } from '#/api/request';
