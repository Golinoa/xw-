import { Hono, type Context } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  opsDeploymentVersionReportQuerySchema,
  opsExpiringEntitlementReportQuerySchema,
  opsReceivableReportQuerySchema,
  opsTenantSyncFailureReportQuerySchema,
  z,
} from '@erp/contracts';
import { respond } from '../../../lib/contract';
import { RestConflictError, RestRequestError, createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';
import { requireOpsPermission } from '../../../middleware/ops-permission';
import {
  expiringReportEnvelopeSchema,
  receivableReportEnvelopeSchema,
  syncReportEnvelopeSchema,
  toExpiringReport,
  toReceivableReport,
  toSyncReport,
  toVersionReport,
  versionReportEnvelopeSchema,
} from './protocol';

export const opsReportRoutes = new Hono<ApiEnvironment>();

/**
 * 报表域（契约 §5.9 的四个 `/reports/*`）。
 *
 * 这一层只做三件事：权限（每个报表一个动作码）、查询参数翻译、`{status}` 信封
 * 到 HTTP 的映射。口径全在 SQL 里——报表自己算一遍是这一域最容易犯的错，
 * 因为「结果看起来对」而报错永远不会发生。
 *
 * 两处一致的约定：
 *
 * 1. **非法筛选值是 400，不是空列表。** `groupBy=quarter` 回空报表会让调用方
 *    以为「确实没有数据」，而实际是他把枚举拼错了。所以 SQL 回
 *    `invalid_*` 信封、这里翻成 400 + `reason`。
 * 2. **可重复参数用 `req.queries()`。** `?status=overdue&status=partial` 是数组；
 *    `req.query()` 只取最后一个，静默丢掉前一个——筛选条件少一个的症状是
 *    「报表数字比预期大」，而那看起来像口径问题。
 */
async function callReport<S extends z.ZodType>(
  context: Context<ApiEnvironment>,
  name: string,
  body: Record<string, unknown>,
  schema: S,
): Promise<z.output<S>> {
  const client = createRestClient(context.env, context.get('opsToken'));

  let payload: unknown;
  try {
    payload = await client.rest<unknown>(`rpc/${name}`, { method: 'POST', body, profile: 'ops' });
  } catch (cause) {
    const requestId = context.get('requestId');
    if (cause instanceof RestConflictError) {
      throw new ApiHttpError(409, ERROR_CODES.CONFLICT, 'The report reported a conflict');
    }
    if (cause instanceof RestRequestError) {
      if (cause.status === 403) {
        throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'The report refused this request');
      }
      if (cause.status === 400 || cause.status === 422) {
        throw new ApiHttpError(
          400,
          ERROR_CODES.VALIDATION_ERROR,
          'The report rejected the request',
        );
      }
    }
    throw new ApiHttpError(503, ERROR_CODES.INTERNAL_ERROR, 'The report is unavailable', {
      requestId,
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: 'ops_rpc_shape_invalid',
        rpc: name,
        requestId: context.get('requestId'),
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      }),
    );
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'The report returned an unexpected shape',
    );
  }
  return parsed.data;
}

function invalidFilter(reason: string, value: unknown): ApiHttpError {
  return new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The report filter is invalid', {
    reason,
    value,
  });
}

function parseQuery<T>(context: Context<ApiEnvironment>, schema: z.ZodType<T>): T {
  const raw: Record<string, unknown> = { ...context.req.query() };
  const statuses = context.req.queries('status');
  if (statuses) raw.status = statuses;
  // 空串是「前端把空输入框发了上来」，与「没传」同义；交给 zod 会变成非法日期。
  for (const key of ['dueFrom', 'dueTo', 'createdFrom', 'customerId', 'contractId']) {
    if (raw[key] === '') delete raw[key];
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(400, ERROR_CODES.VALIDATION_ERROR, 'The query parameters are invalid', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

/** `GET /api/v1/ops/reports/receivables` */
opsReportRoutes.get(OPS_ROUTES.getOpsReceivableReport.path, requireOpsAuth(), async (context) => {
  requireOpsPermission(context, 'receivable.read');
  const query = parseQuery(context, opsReceivableReportQuerySchema);

  const result = await callReport(
    context,
    'report_receivables',
    {
      p_customer_id: query.customerId ?? null,
      p_contract_id: query.contractId ?? null,
      // 空数组与「不筛」同义（前端清空筛选时发的是 `[]`）。
      p_statuses: query.status ?? null,
      p_due_from: query.dueFrom ?? null,
      p_due_to: query.dueTo ?? null,
      p_group_by: query.groupBy ?? null,
    },
    receivableReportEnvelopeSchema,
  );

  if (result.status === 'invalid_group_by') {
    throw invalidFilter('INVALID_GROUP_BY', result.value);
  }

  return respond(context, 'getOpsReceivableReport', toReceivableReport(result));
});

/** `GET /api/v1/ops/reports/expiring-entitlements` */
opsReportRoutes.get(
  OPS_ROUTES.getOpsExpiringEntitlementReport.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'entitlement.read');
    const query = parseQuery(context, opsExpiringEntitlementReportQuerySchema);

    const result = await callReport(
      context,
      'report_expiring_entitlements',
      {
        p_window_days: query.windowDays ?? null,
        p_subject_type: query.subjectType ?? null,
      },
      expiringReportEnvelopeSchema,
    );

    if (result.status === 'invalid_window') {
      throw invalidFilter('INVALID_WINDOW', result.value);
    }
    if (result.status === 'invalid_subject_type') {
      throw invalidFilter('INVALID_SUBJECT_TYPE', result.value);
    }

    return respond(context, 'getOpsExpiringEntitlementReport', toExpiringReport(result));
  },
);

/** `GET /api/v1/ops/reports/tenant-sync-failures` */
opsReportRoutes.get(
  OPS_ROUTES.getOpsTenantSyncFailureReport.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'tenant.read');
    const query = parseQuery(context, opsTenantSyncFailureReportQuerySchema);

    const result = await callReport(
      context,
      'report_tenant_sync_failures',
      {
        p_command_type: query.commandType ?? null,
        p_created_from: query.createdFrom ?? null,
      },
      syncReportEnvelopeSchema,
    );

    if (result.status === 'invalid_command_type') {
      throw invalidFilter('INVALID_COMMAND_TYPE', result.value);
    }

    return respond(context, 'getOpsTenantSyncFailureReport', toSyncReport(result));
  },
);

/** `GET /api/v1/ops/reports/deployment-versions` */
opsReportRoutes.get(
  OPS_ROUTES.getOpsDeploymentVersionReport.path,
  requireOpsAuth(),
  async (context) => {
    requireOpsPermission(context, 'deployment.read');
    const query = parseQuery(context, opsDeploymentVersionReportQuerySchema);

    const result = await callReport(
      context,
      'report_deployment_versions',
      {
        p_customer_id: query.customerId ?? null,
        p_statuses: query.status ?? null,
      },
      versionReportEnvelopeSchema,
    );

    if (result.status !== 'ok') {
      // 这个报表没有业务失败分支，走到这里说明契约与 SQL 脱节了。
      throw new ApiHttpError(
        503,
        ERROR_CODES.INTERNAL_ERROR,
        'The report returned an unknown status',
      );
    }

    return respond(context, 'getOpsDeploymentVersionReport', toVersionReport(result));
  },
);
