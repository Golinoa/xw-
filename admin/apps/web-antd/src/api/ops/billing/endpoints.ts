/**
 * 账款域端点清单与请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.5。路径只在这里出现一次，
 * 命名空间变更（v1 → v2）时不用满仓库搜索字符串。
 */
import type { RequestClientConfig } from '@vben/request';

import type { OpsListQuery } from './types';

import { getOpsEnv } from '#/api/adapter/env';
import { createRequestId } from '#/api/adapter/request-id';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

export const BILLING_ENDPOINTS = {
  allocationReverse: (allocationId: string) =>
    `${OPS_API_PREFIX}/receipt-allocations/${encodeURIComponent(allocationId)}/reverse`,
  receivable: (receivableId: string) =>
    `${OPS_API_PREFIX}/receivables/${encodeURIComponent(receivableId)}`,
  receivableExtensions: (receivableId: string) =>
    `${OPS_API_PREFIX}/receivables/${encodeURIComponent(receivableId)}/extensions`,
  receivables: `${OPS_API_PREFIX}/receivables`,
  receipt: (receiptId: string) =>
    `${OPS_API_PREFIX}/receipts/${encodeURIComponent(receiptId)}`,
  receiptAllocations: (receiptId: string) =>
    `${OPS_API_PREFIX}/receipts/${encodeURIComponent(receiptId)}/allocations`,
  receiptReverse: (receiptId: string) =>
    `${OPS_API_PREFIX}/receipts/${encodeURIComponent(receiptId)}/reverse`,
  receipts: `${OPS_API_PREFIX}/receipts`,
  receiptTransition: (receiptId: string) =>
    `${OPS_API_PREFIX}/receipts/${encodeURIComponent(receiptId)}/transition`,
  refundTransition: (refundId: string) =>
    `${OPS_API_PREFIX}/refunds/${encodeURIComponent(refundId)}/transition`,
  refunds: `${OPS_API_PREFIX}/refunds`,
} as const;

/** 幂等键：写操作必填（契约 §2.5），格式 `[A-Za-z0-9_-]{8,128}`。 */
export function createIdempotencyKey(): string {
  return createRequestId();
}

/**
 * 写请求配置：统一注入 `Idempotency-Key`。
 *
 * 同一个 key 必须存活到「用户这次提交结束」：请求内核的 5xx 重试会复用同一份 config，
 * 因此服务端能识别为重放而不是重复登记。
 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/**
 * 列表查询参数。
 *
 * 契约把多值筛选写成 `status[]`（§5.5），这里按字面量发送，避免后端
 * 收到 `status=a,b` 与 `status=a&status=b` 两种形态。序列化口径列入 journal 待确认项。
 *
 * 只透传白名单字段：查询对象里混入的其它键不会被悄悄发给后端。
 */
const LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'sort',
  'order',
  'customerId',
  'contractId',
  'methodCode',
  'dateFrom',
  'dateTo',
  'dueFrom',
  'dueTo',
  'overdueOnly',
] as const;

export function buildListParams<T extends OpsListQuery & { status?: string[] }>(
  query: T,
): Record<string, unknown> {
  // 白名单按键取值需要索引访问；键集合由 LIST_PARAM_KEYS 固定，不会越界。
  const source = query as unknown as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const key of LIST_PARAM_KEYS) {
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
