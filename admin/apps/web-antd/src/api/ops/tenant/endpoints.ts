/**
 * 租户集成交付域端点清单与请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.7。路径只在这里出现一次，
 * 命名空间变更（v1 → v2）时不用满仓库搜索字符串。
 */
import type { RequestClientConfig } from '@vben/request';

import type { TenantCommandListQuery, TenantMappingListQuery } from './types';

import { getOpsEnv } from '#/api/adapter/env';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

export const TENANT_ENDPOINTS = {
  command: (commandId: string) =>
    `${OPS_API_PREFIX}/tenant-commands/${encodeURIComponent(commandId)}`,
  commandAttempts: (commandId: string) =>
    `${OPS_API_PREFIX}/tenant-commands/${encodeURIComponent(commandId)}/attempts`,
  commandCancel: (commandId: string) =>
    `${OPS_API_PREFIX}/tenant-commands/${encodeURIComponent(commandId)}/cancel`,
  commandRetry: (commandId: string) =>
    `${OPS_API_PREFIX}/tenant-commands/${encodeURIComponent(commandId)}/retry`,
  commands: `${OPS_API_PREFIX}/tenant-commands`,
  mapping: (mappingId: string) =>
    `${OPS_API_PREFIX}/tenant-mappings/${encodeURIComponent(mappingId)}`,
  mappingCommands: (mappingId: string) =>
    `${OPS_API_PREFIX}/tenant-mappings/${encodeURIComponent(mappingId)}/commands`,
  mappings: `${OPS_API_PREFIX}/tenant-mappings`,
} as const;

/**
 * 写请求配置：统一注入 `Idempotency-Key`。
 *
 * 键的生成见 `idempotency.ts`（由表单在打开时生成一次并持有）。
 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/**
 * 列表查询参数白名单（只发已知字段，避免把页面状态泄漏进 query）。
 *
 * 契约把命令状态筛选写成 `status[]`（§5.7），按字面量发送；序列化口径列入
 * journal 待确认项（后端可能接受 `status=a&status=b`）。
 */
const MAPPING_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'sort',
  'order',
  'customerId',
  'productId',
  'mappingStatus',
  'syncVersion',
] as const;

const COMMAND_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'sort',
  'order',
  'mappingId',
  'commandType',
  'createdFrom',
  'createdTo',
] as const;

function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params[key] = value;
  }
  return params;
}

export function buildMappingListParams(
  query: TenantMappingListQuery,
): Record<string, unknown> {
  return pick(
    query as unknown as Record<string, unknown>,
    MAPPING_LIST_PARAM_KEYS,
  );
}

export function buildCommandListParams(
  query: TenantCommandListQuery,
): Record<string, unknown> {
  const params = pick(
    query as unknown as Record<string, unknown>,
    COMMAND_LIST_PARAM_KEYS,
  );
  if (query.status && query.status.length > 0) {
    params['status[]'] = [...query.status];
  }
  return params;
}

export { requestClient } from '#/api/request';
