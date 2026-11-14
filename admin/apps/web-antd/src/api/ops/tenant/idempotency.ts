/**
 * 命令幂等键生成（无环境依赖，可被单测直接引入）。
 *
 * 契约 §2.5：`Idempotency-Key` 为 8–128 字符 `[A-Za-z0-9_-]`，UUID v4 天然满足。
 * **生成时机由表单决定**（`useCommandSubmission.openForm` 生成一次），提交、失败重试、
 * 双击都复用同一个键——这里只提供生成器，绝不在提交时隐式调用，否则「同一表单多次
 * 点击」会变成多条命令。
 */
import { createRequestId } from '#/api/adapter/request-id';

export function createCommandIdempotencyKey(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  // 极老运行时兜底：仍是 UUID v4，格式符合契约，且与后端校验一致。
  return createRequestId();
}
