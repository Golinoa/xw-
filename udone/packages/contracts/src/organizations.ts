import { z } from 'zod';
import { memberRoleSchema } from './members';

/**
 * 组织与当前用户上下文。
 *
 * id 使用 `z.string().min(1)` 而非 `z.uuid()`：数据库主键确实是 uuid，但本地/测试夹具
 * 使用 `org-alpha` 这类短标识。等迁移测试全部改用真实 uuid 后再收紧，避免为了校验强度
 * 把测试夹具改成随机值、失去可读性。
 */
export const organizationNameSchema = z.string().trim().min(1).max(120);

export const organizationIdSchema = z.string().trim().min(1).max(128);
export const organizationParamsSchema = z.object({ id: organizationIdSchema });
export const memberParamsSchema = z.object({
  id: organizationIdSchema,
  userId: z.string().trim().min(1).max(128),
});

export const createOrganizationRequestSchema = z.object({
  name: organizationNameSchema,
});

export const organizationMembershipSchema = z.object({
  organizationId: z.string().min(1),
  organizationName: z.string().min(1),
  role: memberRoleSchema,
});

export const organizationSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const createOrganizationResponseSchema = z.object({
  organization: organizationSummarySchema,
  membership: organizationMembershipSchema,
});

export const meResponseSchema = z.object({
  userId: z.string().min(1),
  memberships: z.array(organizationMembershipSchema),
});

export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;
export type CreateOrganizationResponse = z.infer<typeof createOrganizationResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
