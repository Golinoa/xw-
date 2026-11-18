import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ERROR_CODES,
  PERMISSIONS,
  ROUTES,
  updateCompanySettingsRequestSchema,
} from '@erp/contracts';
import { parseJson, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { ApiHttpError } from '../../middleware/error-handler';
import { companySettingsRepository } from './company-settings-service';

/** 影响财务或权限的配置必须先看到二次确认（R-SETTING-01）。 */
const SENSITIVE_KEYS = ['approvalRules', 'orderRules'] as const;

export const companySettingsRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext) {
  return (
    context.env.COMPANY_SETTINGS_REPOSITORY ??
    companySettingsRepository(context.env, context.get('authToken'))
  );
}

companySettingsRoutes.get(ROUTES.getCompanySettings.path, requireAuth(), async (context) => {
  const settings = await repository(context).get(context.get('auth').organizationId);
  return respond(context, 'getCompanySettings', settings);
});

companySettingsRoutes.patch(
  ROUTES.updateCompanySettings.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (context) => {
    const body = await parseJson(context, updateCompanySettingsRequestSchema);
    const organizationId = context.get('auth').organizationId;
    const current = await repository(context).get(organizationId);
    const data = body.data as Record<string, unknown>;
    const previous = current.data as Record<string, unknown>;

    const changedSensitiveKey = SENSITIVE_KEYS.find(
      (key) => key in data && JSON.stringify(data[key]) !== JSON.stringify(previous[key]),
    );
    if (changedSensitiveKey && !body.confirmed) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        'Changing financial or permission settings requires confirmation',
        { field: 'confirmed', key: changedSensitiveKey },
      );
    }

    const result = await repository(context).update(
      organizationId,
      body.data,
      body.expectedVersion,
    );
    if (result.error === 'VERSION_CONFLICT') {
      throw new ApiHttpError(
        409,
        ERROR_CODES.STATE_CONFLICT,
        'Company settings were changed by someone else; reload before saving',
        { reason: 'VERSION_MISMATCH', currentVersion: current.version },
      );
    }
    if (result.error === 'INVALID_DATA') {
      throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'Invalid company settings payload');
    }
    return respond(context, 'updateCompanySettings', result.settings!);
  },
);
