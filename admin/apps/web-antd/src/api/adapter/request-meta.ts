/**
 * 请求级元数据（requestId / 重试计数 / 流程标记）。
 *
 * 为什么不直接往 config 上加字段：`apps/web-antd` 不直接依赖 axios，
 * 无法用模块增强给 `AxiosRequestConfig` 加属性。这里统一挂在 `__opsMeta` 上，
 * 由纯函数读写；axios 合并配置时对未知键走 `mergeDeepProperties`，
 * 因此元数据在「刷新后重放 / 重试」中会保留（这也是模板 `__isRetryRequest` 能生效的原因）。
 */
import type { RequestClientConfig } from '@vben/request';

export const OPS_META_KEY = '__opsMeta';

export interface OpsRequestMeta {
  /** 本次请求的 X-Request-Id，用于与后端日志对账。 */
  requestId?: string;
  /** 5xx/网络失败已重试次数。 */
  retryCount?: number;
  /** 401 后已重放过一次，避免无限刷新。 */
  isRetryRequest?: boolean;
  /** 登录/刷新/登出端点自身不参与 401 刷新。 */
  skipAuthRefresh?: boolean;
  /** 明确不参与 5xx 自动重试。 */
  skipRetry?: boolean;
  /** 调用方自行呈现错误时抑制全局提示。 */
  suppressErrorNotice?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readRequestMeta(config: unknown): OpsRequestMeta {
  if (config === null || typeof config !== 'object') {
    return {};
  }
  const holder = config as Record<string, unknown>;
  const meta = holder[OPS_META_KEY];
  return isRecord(meta) ? (meta as OpsRequestMeta) : {};
}

export function writeRequestMeta(
  config: unknown,
  patch: Partial<OpsRequestMeta>,
): OpsRequestMeta {
  if (config === null || typeof config !== 'object') {
    return { ...patch };
  }
  const holder = config as Record<string, unknown>;
  const meta: OpsRequestMeta = { ...readRequestMeta(config), ...patch };
  holder[OPS_META_KEY] = meta;
  return meta;
}

/** 构造带元数据的请求配置（用于登录等需要显式标记 skipAuthRefresh 的调用）。 */
export function withRequestMeta(
  config: RequestClientConfig,
  meta: Partial<OpsRequestMeta>,
): RequestClientConfig {
  return Object.assign(config, { [OPS_META_KEY]: { ...meta } });
}
