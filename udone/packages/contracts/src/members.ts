import { z } from 'zod';
import { authRoleSchema } from './permissions';

/** 成员角色复用权限矩阵派生的角色联合，不再单独维护一份枚举。 */
export const memberRoleSchema = authRoleSchema;
export const memberStatusSchema = z.enum(['active', 'disabled']);

export const invitationStatusSchema = z.literal('pending');

export const createOrganizationInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: memberRoleSchema,
});

export const updateOrganizationMemberRequestSchema = z.object({
  role: memberRoleSchema,
  status: memberStatusSchema,
});

/** 单条成员记录。列表与更新响应共用同一结构。 */
export const organizationMemberSchema = z.object({
  userId: z.string().min(1),
  role: memberRoleSchema,
  status: memberStatusSchema,
});

export const organizationInvitationSchema = z.object({
  id: z.string().min(1),
  status: invitationStatusSchema,
  expiresAt: z.string().min(1),
});

export const memberListResponseSchema = z.object({
  members: z.array(organizationMemberSchema),
});

export const memberUpdateResponseSchema = z.object({
  member: organizationMemberSchema,
});

export const invitationResponseSchema = z.object({
  invitation: organizationInvitationSchema,
});

export const invitationParamsSchema = z.object({
  invitationId: z.string().trim().min(1).max(128),
});

export const membershipSchema = z.object({
  organizationId: z.string().min(1),
  role: memberRoleSchema,
});
export const acceptInvitationResponseSchema = z.object({
  membership: membershipSchema,
});

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;
export type OrganizationInvitation = z.infer<typeof organizationInvitationSchema>;
export type OrganizationInvitationResponse = z.infer<typeof invitationResponseSchema>;
export type OrganizationMemberUpdateResponse = z.infer<typeof memberUpdateResponseSchema>;
export type Membership = z.infer<typeof membershipSchema>;
