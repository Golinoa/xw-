import { z } from 'zod';

/**
 * 运营上下文：`ops.get_current_ops_context()` 的返回形状（契约 §7.1）。
 *
 * 这个 schema 同时是中间件的入站校验：RPC 返回的行如果形状不对，必须在
 * 进入处理函数之前失败。让它「差不多能用」的代价很具体——`permissions`
 * 少一个字段就变成空数组，表现是「所有菜单都消失」，而原因看起来像权限没配。
 *
 * `status` 只可能是 `active`：RPC 的 WHERE 就带了这个条件。写成字面量而不是
 * 三值枚举，是为了让「拿到了上下文」与「账号是 active」在类型层就是同一件事，
 * 调用方不需要再判一次。
 */
export const opsContextSchema = z.object({
  operatorId: z.string().min(1),
  email: z.string().min(1),
  displayName: z.string().nullable(),
  status: z.literal('active'),
  mfaRequired: z.boolean(),
  permissionVersion: z.number().int().positive(),
  lastLoginAt: z.string().nullable(),
  roleCodes: z.array(z.string()),
  roleNames: z.array(z.string()),
  permissions: z.array(z.string()),
});

export type OpsContext = z.infer<typeof opsContextSchema>;

/**
 * 运营端 403 的 `details.reason`。
 *
 * 区分「没有账号」与「账号停用」不是为了给前端更细的提示，而是为了让人看懂
 * 该找谁：前者是「你还没被加入」，后者是「你被停了」。合并成一句 FORBIDDEN
 * 会让这两种情况都变成「去问管理员」，而管理员打开列表看到的又是正常的。
 */
export const OPS_MEMBER_REASONS = ['OPS_MEMBER_MISSING', 'OPS_MEMBER_INACTIVE'] as const;
export type OpsMemberReason = (typeof OPS_MEMBER_REASONS)[number];
