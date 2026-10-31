import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { idempotency } from './middleware/idempotency';
import { rateLimit } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import type { ApiEnvironment } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { organizationRoutes } from './routes/organizations';
import { memberRoutes } from './modules/members/routes';
import { customerRoutes } from './modules/customers/routes';
import { orderRoutes } from './modules/orders/routes';
import { supplierRoutes } from './modules/suppliers/routes';
import { financeRoutes } from './modules/finance/routes';
import { financeApplicationRoutes } from './modules/finance-applications/routes';
import { opsAccountRoutes } from './modules/ops/accounts/routes';
import { opsAuthRoutes } from './modules/ops/auth/routes';
import { opsCatalogRoutes } from './modules/ops/catalog/routes';
import { opsContractRoutes } from './modules/ops/contracts/routes';
import { opsDeploymentRoutes } from './modules/ops/deployment/routes';
import { opsReceivableRoutes } from './modules/ops/receivables/routes';
import { opsReportRoutes } from './modules/ops/reports/routes';
import { opsCustomerRoutes } from './modules/ops/customers/routes';
import { opsIdentityRoutes } from './modules/ops/identity/routes';
import { opsMetaRoutes } from './modules/ops/meta/routes';
import { opsOverviewRoutes } from './modules/ops/overview/routes';
import { opsReceiptRoutes } from './modules/ops/receipts/routes';
import { opsSettingsRoutes } from './modules/ops/settings/routes';
import { opsExportsRoutes } from './modules/ops/exports/routes';
import { opsEntitlementRoutes } from './modules/ops/entitlements/routes';
import { opsTenantIntegrationRoutes } from './modules/ops/tenant-integration/routes';
import { opsTicketRoutes } from './modules/ops/tickets/routes';

export const app = new Hono<ApiEnvironment>();

// Order is fixed and documented in .harness/CONTRACTS.md:
//   requestId -> cors -> rateLimit -> idempotency -> routes
// Request IDs must exist before anything logs; CORS has to wrap every route so a
// preflight never reaches auth; rate limiting runs before any work is done; the
// idempotency cache only stores 2xx bodies, so an unauthenticated 401 stays out.
app.use('*', requestId());
app.use('*', corsMiddleware());
app.use('*', rateLimit());
app.use('*', idempotency());
app.onError(errorHandler);
app.route('/', healthRoutes);
app.route('/', organizationRoutes);
app.route('/', memberRoutes);
app.route('/', customerRoutes);
app.route('/', orderRoutes);
app.route('/', supplierRoutes);
app.route('/', financeRoutes);
app.route('/', financeApplicationRoutes);
// 运营后台：路径自带 /api/v1/ops 前缀，鉴权是 requireOpsAuth 而不是 requireAuth。
app.route('/', opsAuthRoutes);
app.route('/', opsMetaRoutes);
app.route('/', opsIdentityRoutes);
app.route('/', opsAccountRoutes);
app.route('/', opsCustomerRoutes);
// 产品目录接在客户域之后：两者没有交叉路径，顺序只影响阅读（客户 → 目录 → 合同）。
app.route('/', opsCatalogRoutes);
// 合同接在 catalog 之后：合同引用客户与套餐（套餐状态、客户资格），阅读顺序同依赖顺序。
app.route('/', opsContractRoutes);
app.route('/', opsReceivableRoutes);
// 工单接在应收之后：它只引用客户、产品、合同（三张都已落地），不引用收款链路。
// 内部顺序有硬约束——`/tickets/assignable-operators` 必须先于 `/tickets/:ticketId`。
app.route('/', opsTicketRoutes);
// 收款接在工单之后：它引用客户、合同、应收三者，且是唯一在事务里跨域改余额的
// 模块（核销同时动 receipts 与多行 receivables）。放在最后读起来最清楚。
app.route('/', opsReceiptRoutes);
// 权益接在收款之后：它只引用客户、合同、合同条目与功能字典，不引用任何
// 金额链路——订阅与授权是「卖出去的权利」，与「收到多少钱」是两条线。
app.route('/', opsEntitlementRoutes);
// 租户集成接在权益之后：它引用客户、产品、合同与权益变更申请（`changeRequestId`），
// 是唯一同时指向「卖出去的权利」和「远端那台机器」的模块。放在最后，
// 依赖方向自上而下读得出来。
app.route('/', opsTenantIntegrationRoutes);
// 部署台账接在租户之后：它引用客户、合同与私有化授权，而「租户开通之后能不能
// 上线」正是它要回答的问题。两条线互不写对方的表。
app.route('/', opsDeploymentRoutes);
app.route('/', opsSettingsRoutes);
// 导出接在设置页之后：它读的保留期（`retention.exportDays`）来自设置页，
// 而设置页不依赖它——依赖方向仍然是自上而下。
app.route('/', opsExportsRoutes);
// 总览接在最后：它不写任何表，只跨域读——客户、合同、应收、收款、权益、租户、
// 部署、工单。放在最后意味着它的依赖方向是「全都看过一遍」，而不是「被别人依赖」。
app.route('/', opsOverviewRoutes);
// 报表接在总览之后：它不写任何表，只读同一组口径（`ops.v_receivable_status`）。
// 放在总览之后是读的顺序，不是依赖——两者互不调用。
app.route('/', opsReportRoutes);

export default app;
