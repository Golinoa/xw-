/**
 * requestId 生成与透传。
 *
 * 规则（设计文档 §2.1.4）：
 * - 每次请求生成 UUID v4 写入 `X-Request-Id`；
 * - 调用方显式传入时复用（重放/重试必须保持同一 ID，便于与后端日志对账）；
 * - 响应侧 `X-Request-Id` 与错误体 `requestId` 双通道取值，落到统一错误对象。
 */
import { readRequestMeta, writeRequestMeta } from './request-meta';

export const REQUEST_ID_HEADER = 'X-Request-Id';

interface HeaderBag {
  [key: string]: unknown;
  get?: (name: string) => unknown;
  set?: (name: string, value: string) => unknown;
}

export function readHeader(headers: unknown, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') {
    return undefined;
  }
  const bag = headers as HeaderBag;
  if (typeof bag.get === 'function') {
    const value = bag.get(name);
    return value === null || value === undefined ? undefined : String(value);
  }
  const raw = bag[name] ?? bag[name.toLowerCase()];
  return raw === null || raw === undefined ? undefined : String(raw);
}

export function writeHeader(
  headers: unknown,
  name: string,
  value: string,
): void {
  if (headers === null || typeof headers !== 'object') {
    return;
  }
  const bag = headers as HeaderBag;
  if (typeof bag.set === 'function') {
    bag.set(name, value);
    return;
  }
  bag[name] = value;
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRequestId(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/** 生成 RFC 4122 v4 UUID。`crypto.randomUUID` 不可用时退化为 getRandomValues。 */
export function createRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoObject?.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // 版本号与变体位，保证符合 v4 格式
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * 为请求头补齐 requestId，并写入请求元数据供错误映射与日志使用。
 * 调用方已提供合法 requestId 时原样复用（重放保持同一 ID）。
 */
export function resolveRequestId(config: { headers?: unknown }): string {
  const existing = readHeader(config.headers, REQUEST_ID_HEADER);
  const meta = readRequestMeta(config);
  const requestId =
    existing && isRequestId(existing)
      ? existing
      : (meta.requestId ?? createRequestId());
  writeHeader(config.headers, REQUEST_ID_HEADER, requestId);
  writeRequestMeta(config, { requestId });
  return requestId;
}
