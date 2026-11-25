import { describe, expect, it } from 'vitest';
import { customerSourceListQuerySchema } from './customers';

/**
 * 来源列表的 `includeInactive` 不是可选的装饰。
 *
 * 服务端默认只回启用项，管理页不带这个参数时，用户点一次「停用」就等于把来源删了
 * （列表里再也找不到，也就恢复不了）。同时「不传参数」必须仍然合法——
 * 客户表单只要启用项，传空才是正常调用。
 */
describe('customerSourceListQuerySchema', () => {
  it('allows callers that want active sources only', () => {
    expect(customerSourceListQuerySchema.safeParse(undefined).success).toBe(true);
    expect(customerSourceListQuerySchema.safeParse({}).success).toBe(true);
    expect(customerSourceListQuerySchema.safeParse({ includeInactive: '0' }).success).toBe(true);
  });

  it('accepts the management page flag', () => {
    const parsed = customerSourceListQuerySchema.safeParse({ includeInactive: '1' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.includeInactive).toBe('1');
  });

  it('rejects values the API would silently read as false', () => {
    // 服务端判断的是 `=== '1'`，`true` / `yes` 会被当成 false —— 这种歧义必须在契约里挡住。
    expect(customerSourceListQuerySchema.safeParse({ includeInactive: 'true' }).success).toBe(
      false,
    );
    expect(customerSourceListQuerySchema.safeParse({ includeInactive: 'yes' }).success).toBe(false);
    expect(customerSourceListQuerySchema.safeParse({ includeInactive: true }).success).toBe(false);
  });
});
