import type { Context } from 'hono';
import { ERROR_CODES } from '@erp/contracts';
import type { ApiEnvironment } from './auth';
import { ApiHttpError } from './error-handler';

/**
 * 动作码判定。只读 `requireOpsAuth` 已取回的上下文，不再回库一次。
 *
 * 为什么这一层不能省（数据库里 `require_permission` 已经判过一次）：
 * 库里的判定失败是 42501 → PostgREST 403，Worker 把它翻译成 403 只是复述；
 * 而**判定失败的形状**不同。库里抛错时拿不到「缺哪个动作码」，前端只能显示
 * 「没权限」；这里带上 `details.required`，拒绝页才能说清「需要 operator.read」。
 *
 * 两处判定不是冗余：一处挡住正常请求，一处挡住绕过中间件的请求（比如某个
 * 端点忘了挂 requireOpsAuth）。它们的一致性由契约保证——同一串动作码字面量
 * 在这两个地方之外不出现第三次。
 */
export function requireOpsPermission(context: Context<ApiEnvironment>, permission: string): void {
  const opsContext = context.get('opsContext');
  if (!opsContext.permissions.includes(permission)) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, `The ${permission} permission is required`, {
      required: permission,
    });
  }
}
