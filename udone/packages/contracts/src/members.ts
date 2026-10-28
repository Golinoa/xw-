import { z } from 'zod';

export const memberRoleSchema = z.enum(['admin', 'operator', 'finance']);
export const memberStatusSchema = z.enum(['active', 'disabled']);

export const createOrganizationInvitationRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role: memberRoleSchema,
});

export const updateOrganizationMemberRequestSchema = z.object({
  role: memberRoleSchema,
  status: memberStatusSchema,
});

export interface OrganizationInvitation {
  id: string;
  status: 'pending';
  expiresAt: string;
}

export interface OrganizationMemberUpdate {
  userId: string;
  role: 'admin' | 'operator' | 'finance';
  status: 'active' | 'disabled';
}
