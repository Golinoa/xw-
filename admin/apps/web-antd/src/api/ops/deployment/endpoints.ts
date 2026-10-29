/**
 * 部署域端点清单与请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.8 前半（`/deployments*`），数据模型 §3.7。
 * 路径只在这里出现一次，命名空间变更（v1 → v2）时不必满仓库搜索字符串。
 *
 * 契约推导（已登记 journal 待确认项）：
 * - `POST /deployments/{id}/transition` —— §3.7 状态机列出 `go_live` /
 *   `start_maintenance` / `end_maintenance` / `retire` 四个动作与 `deployment.write`，
 *   但 §5.8 只给了两个 `PATCH` 入口且未定义改 `status` 的写法；按 customer/contract
 *   域同一形态补 `transition` 端点，禁止用 `PATCH` 直写状态（契约 §3.0 软删除/状态机约定）。
 * - 列表筛选 `deploymentType` / `productId` —— §5.8 只列 `customerId`/`status[]`/
 *   `currentVersion`/`maintenanceUntilBefore`，PRD §6.8 要求「按客户、版本、状态、
 *   维护期限筛选」，任务另要求环境类型与产品；环境类型是实例自有列，产品需经授权关联，
 *   两者均按白名单透传，后端未支持时不应静默改变语义（见 README）。
 */
import type { RequestClientConfig } from '@vben/request';

import type { DeploymentListQuery } from './types';

import { getOpsEnv } from '#/api/adapter/env';
import { createRequestId } from '#/api/adapter/request-id';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

export const DEPLOYMENT_ENDPOINTS = {
  deployments: `${OPS_API_PREFIX}/deployments`,
  detail: (deploymentId: string) =>
    `${OPS_API_PREFIX}/deployments/${encodeURIComponent(deploymentId)}`,
  transition: (deploymentId: string) =>
    `${OPS_API_PREFIX}/deployments/${encodeURIComponent(deploymentId)}/transition`,
  versionRecords: (deploymentId: string) =>
    `${OPS_API_PREFIX}/deployments/${encodeURIComponent(deploymentId)}/version-records`,
} as const;

/** 幂等键：部署写操作必填（契约 §2.5「部署升级记录」在必填范围内）。 */
export function createIdempotencyKey(): string {
  return createRequestId();
}

/** 写请求配置：统一注入 `Idempotency-Key`。 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/** 列表查询的公共白名单（分页/排序，契约 §2.4）。 */
const COMMON_PARAM_KEYS = ['page', 'pageSize', 'sort', 'order'] as const;

/** 部署列表透传字段（前四个为契约字段，后两个为推导项，见文件头注释）。 */
export const DEPLOYMENT_FILTER_KEYS = [
  'customerId',
  'currentVersion',
  'maintenanceUntilBefore',
  'deploymentType',
  'productId',
] as const;

/**
 * 组装列表查询参数。
 *
 * 契约把多值筛选写成 `status[]`（§5.8 → §5 通用约定），这里按字面量发送 `status[]`，
 * 避免后端同时支持 `status=a,b` 与 `status=a&status=b` 两种形态。只透传白名单字段：
 * 查询对象里混入的其它键不会被悄悄发给后端（分页筛选一律走服务端，不做客户端过滤）。
 */
export function buildDeploymentListParams(
  query: DeploymentListQuery,
): Record<string, unknown> {
  const source = query as unknown as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of [...COMMON_PARAM_KEYS, ...DEPLOYMENT_FILTER_KEYS]) {
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

export { requestClient } from '#/api/request';
