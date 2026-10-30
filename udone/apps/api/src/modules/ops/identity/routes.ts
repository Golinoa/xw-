import { Hono } from 'hono';
import {
  ERROR_CODES,
  OPS_ROUTES,
  type OpsPermissionListResponse,
  type OpsSessionResponse,
} from '@erp/contracts';
import { respond } from '../../../lib/contract';
import { createRestClient } from '../../../lib/rest-client';
import type { ApiEnvironment } from '../../../middleware/auth';
import { ApiHttpError } from '../../../middleware/error-handler';
import { requireOpsAuth } from '../../../middleware/ops-auth';

export const opsIdentityRoutes = new Hono<ApiEnvironment>();

/** 权限目录的一行（数据库列名）。映射显式写，不让 `as` 把列改名的事故藏起来。 */
interface PermissionRow {
  code: string;
  domain: string;
  description: string;
  is_high_risk: boolean;
}

/**
 * `GET /api/v1/ops/session`
 *
 * 数据全部来自 `requireOpsAuth` 已经取回的上下文，不再回库一次。理由不是省一次
 * 往返，而是**一致性**：如果身份查一次、权限再查一次，两次之间发生的角色变更
 * 会让响应里的身份与权限互相矛盾，而这类矛盾只在权限刚被改过的那几秒出现，
 * 最难复现。
 */
opsIdentityRoutes.get(OPS_ROUTES.getOpsSession.path, requireOpsAuth(), (context) => {
  const opsContext = context.get('opsContext');

  /**
   * RPC 返回两个平行数组（`role_codes` / `role_names`），都由 `order by role.code`
   * 生成，因此下标一一对应。这里仍按「长度不一致就退回用 code 当 name」处理：
   * 靠先后顺序对齐的两个数组是脆的，真错位时至少要退化得可读，而不是把
   * 「运营只读」显示成「finance_ops」。
   */
  const roles = opsContext.roleCodes.map((code, index) => ({
    code,
    name: opsContext.roleNames[index] ?? code,
  }));

  const body: OpsSessionResponse = {
    operator: {
      id: opsContext.operatorId,
      displayName: opsContext.displayName,
      email: opsContext.email,
      status: 'active',
      mfaRequired: opsContext.mfaRequired,
    },
    roles,
    permissions: opsContext.permissions,
    permissionVersion: opsContext.permissionVersion,
    lastLoginAt: opsContext.lastLoginAt,
  };

  return respond(context, 'getOpsSession', body);
});

/**
 * `GET /api/v1/ops/permissions` —— 39 个动作码的目录，供角色编辑页渲染。
 *
 * 先用上下文里的权限判一次，再查表：只用 RLS 也能拦住（没有 `operator.read`
 * 读到 0 行），但那样前端看到的是「空列表」而不是 403，会以为目录没配好。
 * 契约写的就是 403，所以判定放在这里。
 */
opsIdentityRoutes.get(OPS_ROUTES.listOpsPermissions.path, requireOpsAuth(), async (context) => {
  const opsContext = context.get('opsContext');
  if (!opsContext.permissions.includes('operator.read')) {
    throw new ApiHttpError(403, ERROR_CODES.FORBIDDEN, 'The operator.read permission is required', {
      required: 'operator.read',
    });
  }

  const client = createRestClient(context.env, context.get('opsToken'));
  const rows = await client.rest<PermissionRow[]>(
    'permissions?select=code,domain,description,is_high_risk&order=code.asc',
    { profile: 'ops' },
  );

  const body: OpsPermissionListResponse = {
    items: rows.map((row) => ({
      code: row.code,
      domain: row.domain,
      description: row.description,
      isHighRisk: row.is_high_risk,
    })),
  };

  return respond(context, 'listOpsPermissions', body);
});
