/**
 * identity 域端点清单与写请求辅助。
 *
 * 契约：`Docs/ops-api-contract.md` §5.1。路径只在这里出现一次，命名空间变更
 * （v1 → v2）时不用满仓库搜索字符串。
 *
 * 本文件从 `session.ts` 抽出：此前 `OPS_ENDPOINTS` 与「会话客户端」混在一处，
 * 加 operators/roles/audit-events 后会继续膨胀，而端点表是全域共用的。
 * `session.ts` 仍 re-export 它，`api/core/auth.ts` 等既有导入不受影响。
 */
import type { RequestClientConfig } from '@vben/request';

import { getOpsEnv } from '#/api/adapter/env';
import { createRequestId } from '#/api/adapter/request-id';

const OPS_API_PREFIX = getOpsEnv().opsApiPrefix;

export const OPS_ENDPOINTS = {
  // ---- 认证与会话（契约 §5.1，2026-10-30 起为正式端点，不再是「推导」）----
  login: `${OPS_API_PREFIX}/auth/login`,
  logout: `${OPS_API_PREFIX}/auth/logout`,
  refresh: `${OPS_API_PREFIX}/auth/refresh`,
  session: `${OPS_API_PREFIX}/session`,
  meta: `${OPS_API_PREFIX}/meta`,
  permissions: `${OPS_API_PREFIX}/permissions`,

  // ---- 运营成员 ----
  operators: `${OPS_API_PREFIX}/operators`,
  operatorInvitations: `${OPS_API_PREFIX}/operators/invitations`,
  operator: (operatorId: string) =>
    `${OPS_API_PREFIX}/operators/${encodeURIComponent(operatorId)}`,

  // ---- 角色 ----
  roles: `${OPS_API_PREFIX}/roles`,
  role: (roleId: string) =>
    `${OPS_API_PREFIX}/roles/${encodeURIComponent(roleId)}`,

  // ---- 审计 ----
  auditEvents: `${OPS_API_PREFIX}/audit-events`,

  // ---- 运营总览（契约 §5.9）----
  overview: `${OPS_API_PREFIX}/overview`,

  // ---- 系统设置与字典 ----
  settings: `${OPS_API_PREFIX}/settings`,
  dictionaries: `${OPS_API_PREFIX}/dictionaries`,
  dictionaryItems: (code: string) =>
    `${OPS_API_PREFIX}/dictionaries/${encodeURIComponent(code)}/items`,
  dictionaryItem: (itemId: string) =>
    `${OPS_API_PREFIX}/dictionary-items/${encodeURIComponent(itemId)}`,

  // ---- 导出任务 ----
  exportTasks: `${OPS_API_PREFIX}/exports`,
  exportTask: (exportId: string) =>
    `${OPS_API_PREFIX}/exports/${encodeURIComponent(exportId)}`,
} as const;

/** 幂等键：写操作必填（契约 §2.5），格式 `[A-Za-z0-9_-]{8,128}`。 */
export function createIdempotencyKey(): string {
  return createRequestId();
}

/**
 * 写请求配置：统一注入 `Idempotency-Key`。
 *
 * 同一个 key 必须存活到「用户这次提交结束」：请求内核的 5xx 重试会复用同一份
 * config，因此服务端能识别为重放而不是重复登记。调用方要在**打开表单时**生成一次，
 * 不要在每次点击时重新生成——否则连点两次会变成两条独立记录。
 */
export function writeConfig(idempotencyKey: string): RequestClientConfig {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

/**
 * 剔除空值后再作为查询参数发送。
 *
 * 后端把筛选参数视为「出现即生效」，发 `status=` 空串会被当成「筛状态为空」，
 * 结果为空列表而不是不过滤。`undefined`/`null`/`''` 一律不发送。
 */
export function compactParams(
  query: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    ),
  );
}

/** 分页默认值与白名单（契约 §2.4：`pageSize` 白名单 `10/15/20/30/50/100`，默认 15）。 */
export const OPS_DEFAULT_PAGE_SIZE = 15;

export const OPS_PAGE_SIZE_OPTIONS = [10, 15, 20, 30, 50, 100] as const;
