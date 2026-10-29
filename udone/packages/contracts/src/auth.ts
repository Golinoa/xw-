import { z } from 'zod';
import { authRoleSchema, dataScopeSchema, permissionSchema } from './permissions';

/**
 * 已验证的请求身份上下文。由 Worker 中间件产生，绝不接受客户端提交的同名字段。
 */
export const authContextSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  role: authRoleSchema,
  sessionId: z.string().min(1),
  permissions: z.array(permissionSchema).readonly(),
  dataScope: dataScopeSchema,
});

export type AuthContext = z.infer<typeof authContextSchema>;
