import { z } from 'zod';

/**
 * 运营会话与权限目录（契约 §5.1 `GET /session`、`GET /permissions`）。
 *
 * `/session` 是前端启动时唯一必须成功的调用：菜单、按钮、拒绝页全部由它
 * 决定。所以它的形状要写死在这里，而不是让前端从若干端点拼装——拼装出来的
 * 「当前身份」在两次请求之间可能变，而权限变更必须即时生效。
 *
 * `status` 是字面量而不是三值枚举：能拿到 `/session` 就意味账号是 active
 * （RPC 的 WHERE 带了这个条件）。把它写成枚举会留一个前端必须判、但永远为
 * true 的分支。
 */
export const opsSessionResponseSchema = z.object({
  operator: z.object({
    id: z.string().min(1),
    displayName: z.string().nullable(),
    email: z.string().min(1),
    status: z.literal('active'),
    mfaRequired: z.boolean(),
  }),
  roles: z.array(
    z.object({
      code: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
  permissions: z.array(z.string()),
  /** 单调递增。前端据此判断「权限变了」并重新拉一遍菜单。 */
  permissionVersion: z.number().int().positive(),
  lastLoginAt: z.string().nullable(),
});

export type OpsSessionResponse = z.infer<typeof opsSessionResponseSchema>;

export const opsPermissionSchema = z.object({
  code: z.string().min(1),
  domain: z.string().min(1),
  description: z.string(),
  isHighRisk: z.boolean(),
});

export type OpsPermission = z.infer<typeof opsPermissionSchema>;

export const opsPermissionListResponseSchema = z.object({
  items: z.array(opsPermissionSchema),
});

export type OpsPermissionListResponse = z.infer<typeof opsPermissionListResponseSchema>;
