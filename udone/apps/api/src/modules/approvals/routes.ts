import { Hono } from 'hono';
import type { Context } from 'hono';
import { PERMISSIONS, ROUTES, approvalFlowSchema } from '@erp/contracts';
import { parseJson, respond } from '../../lib/contract';
import type { ApiEnvironment } from '../../middleware/auth';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { approvalFlowRepository } from './approval-service';

export const approvalRoutes = new Hono<ApiEnvironment>();

type ApiContext = Context<ApiEnvironment>;

function repository(context: ApiContext) {
  return (
    context.env.APPROVAL_FLOW_REPOSITORY ??
    approvalFlowRepository(context.env, context.get('authToken'))
  );
}

/** 读对所有成员开放：申请人需要知道这笔要过几级，否则催签都找不到人。 */
approvalRoutes.get(ROUTES.getApprovalFlow.path, requireAuth(), async (context) => {
  const flow = await repository(context).get(context.get('auth').organizationId);
  return respond(context, 'getApprovalFlow', flow);
});

approvalRoutes.patch(
  ROUTES.updateApprovalFlow.path,
  requireAuth(),
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  async (context) => {
    const body = await parseJson(context, approvalFlowSchema);
    const organizationId = context.get('auth').organizationId;
    const repositoryInstance = repository(context);

    await repositoryInstance.save(organizationId, body);
    // 回读一次：保存成功不代表存进去的是你以为的那份（DB 会做默认值合并）。
    return respond(context, 'updateApprovalFlow', await repositoryInstance.get(organizationId));
  },
);
