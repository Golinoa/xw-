import { z } from 'zod';

/**
 * 租户侧公司配置（R-SETTING-01）。
 *
 * `approvalRules` 与 `orderRules` 会影响财务/权限口径，写入时必须二次确认，
 * 但「确认过」这件事不进数据库——它只是本次操作的一道题，不是配置项本身。
 */
export const companySettingsDataSchema = z
  .object({
    companyName: z.string().trim().min(1).max(80).optional(),
    contactPhone: z.string().trim().max(20).optional(),
    address: z.string().trim().max(200).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    fontSize: z.enum(['small', 'medium', 'large']).optional(),
    businessDictionary: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(40),
          label: z.string().trim().min(1).max(80),
        }),
      )
      .max(200)
      .optional(),
    approvalRules: z
      .object({
        selfApproval: z.boolean().optional(),
        minApprovalSteps: z.number().int().min(1).max(3).optional(),
      })
      .strict()
      .optional(),
    orderRules: z
      .object({
        defaultOrderType: z.enum(['active', 'booking']).optional(),
        requireDeposit: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CompanySettingsData = z.infer<typeof companySettingsDataSchema>;

export const companySettingsSchema = z.object({
  organizationId: z.string().uuid(),
  data: companySettingsDataSchema,
  version: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().uuid().nullable(),
});

export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const updateCompanySettingsRequestSchema = z.object({
  data: companySettingsDataSchema,
  expectedVersion: z.number().int().min(0),
  confirmed: z.boolean().optional().default(false),
});

export type UpdateCompanySettingsRequest = z.infer<typeof updateCompanySettingsRequestSchema>;
