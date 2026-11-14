/**
 * 售后工单域端点清单与请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.8 后半（`/api/v1/ops/tickets*`）。
 * 路径只在这里出现一次：契约前缀调整（v1 → v2）时不必满仓库搜字符串。
 *
 * 契约推导（登记 journal U-07/U-08）：
 * - `GET /tickets` 的 `createdFrom`/`createdTo`/`unassigned` —— §5.8 只列了
 *   `customerId`/`status[]`/`priority[]`/`assigneeOperatorId`/`productId`/`updatedFrom`/
 *   `overdueOnly`；任务书要求「创建时间区间」与「未分派」筛选，按 customer/contract 域
 *   同构参数补齐，后端确认前可能被忽略（页面不做客户端兜底过滤）。
 * - `isOverdue`/`assignableOperators` 同属推导字段，缺失即降级，不自行推断。
 */
import type { RequestClientConfig } from '@vben/request';

import type { TicketListQuery } from './types';

import { getOpsEnv } from '#/api/adapter/env';
import { createRequestId } from '#/api/adapter/request-id';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

/** 端点清单：所有工单路径只从这里取。 */
export const TICKET_ENDPOINTS = {
  assign: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}/assign`,
  events: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}/events`,
  references: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}/references`,
  ticket: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}`,
  tickets: `${OPS_API_PREFIX}/tickets`,
  timeline: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}/timeline`,
  transition: (ticketId: string) =>
    `${OPS_API_PREFIX}/tickets/${encodeURIComponent(ticketId)}/transition`,
} as const;

/** 幂等键：写操作必填（契约 §2.5），格式 `[A-Za-z0-9_-]{8,128}`。 */
export function createIdempotencyKey(): string {
  return createRequestId();
}

/** 写请求配置：统一注入 `Idempotency-Key`。 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/** 列表查询公共白名单（分页/排序，契约 §2.4）。 */
const COMMON_PARAM_KEYS = ['page', 'pageSize', 'sort', 'order'] as const;

/** `pageSize` 白名单（契约 §2.4 `listQuerySchema`）。 */
export const OPS_PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50, 100] as const;

/** 默认分页大小（契约 §2.4：默认 15，PRD §10.1 要求默认 ≤ 50 行）。 */
export const OPS_DEFAULT_PAGE_SIZE = 15;

/** 工单列表透传的筛选字段（契约 §5.8 + 推导项，见文件头）。 */
export const TICKET_FILTER_KEYS = [
  'customerId',
  'assigneeOperatorId',
  'productId',
  'updatedFrom',
  'overdueOnly',
  'unassigned',
  'createdFrom',
  'createdTo',
] as const;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * 组装工单列表查询参数。
 *
 * 只透传白名单字段：查询对象里混入的其它键不会被悄悄发给后端
 * （分页与筛选一律走服务端，禁止全量拉取后在浏览器过滤）。
 * 多值筛选按契约字面量发送 `status[]` / `priority[]`，不额外支持 `a,b` 拼串。
 */
export function buildTicketListParams(
  query: TicketListQuery,
): Record<string, unknown> {
  const source = query as unknown as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of [...COMMON_PARAM_KEYS, ...TICKET_FILTER_KEYS]) {
    const value = source[key];
    if (isEmpty(value)) {
      continue;
    }
    // `overdueOnly=false` / `unassigned=false` 表示「不筛选」，不发请求参数。
    if (typeof value === 'boolean' && !value) {
      continue;
    }
    params[key] = value;
  }
  if (query.status && query.status.length > 0) {
    params['status[]'] = [...query.status];
  }
  if (query.priority && query.priority.length > 0) {
    params['priority[]'] = [...query.priority];
  }
  return params;
}

export { requestClient } from '#/api/request';
