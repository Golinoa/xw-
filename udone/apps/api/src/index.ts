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
import { opsReceivableRoutes } from './modules/ops/receivables/routes';
import { opsCustomerRoutes } from './modules/ops/customers/routes';
import { opsIdentityRoutes } from './modules/ops/identity/routes';
import { opsMetaRoutes } from './modules/ops/meta/routes';
import { opsReceiptRoutes } from './modules/ops/receipts/routes';
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

export default app;
