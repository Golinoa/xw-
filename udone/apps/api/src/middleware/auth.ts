import type { MiddlewareHandler } from 'hono';
import type { AuthContext, OpsContext, Permission } from '@erp/contracts';
import { ERROR_CODES } from '@erp/contracts';
import type { OrganizationRepository } from '../services/organization-service';
import type { CustomerRepository } from '../modules/customers/customer-service';
import type { OrderRepository } from '../modules/orders/order-service';
import type { SupplierRepository } from '../modules/suppliers/supplier-service';
import type { TourRouteRepository } from '../modules/routes/route-service';
import type { TouristRepository } from '../modules/tourists/tourist-service';
import type { FinanceRepository } from '../modules/finance/finance-service';
import type { FinanceApplicationRepository } from '../modules/finance-applications/finance-application-service';
import type { SettlementRepository } from '../modules/settlements/settlement-service';
import type { CompanySettingsRepository } from '../modules/company-settings/company-settings-service';
import type { AuditRepository } from '../modules/audit/audit-service';
import { ApiHttpError } from './error-handler';
import { createSupabaseAuthVerifier } from '../services/supabase-auth-verifier';
import type { OpsAuthUpstream } from '../modules/ops/auth/upstream';
import type { OpsInviteUpstream } from '../modules/ops/accounts/invite-upstream';

export interface AuthVerifier {
  verify(token: string, organizationId?: string): Promise<AuthContext | null>;
  hasPermission(context: AuthContext, permission: Permission): Promise<boolean>;
}

export interface ApiEnvironment {
  Bindings: {
    AUTH_VERIFIER?: AuthVerifier;
    ORGANIZATION_REPOSITORY?: OrganizationRepository;
    CUSTOMER_REPOSITORY?: CustomerRepository;
    ORDER_REPOSITORY?: OrderRepository;
    SUPPLIER_REPOSITORY?: SupplierRepository;
    ROUTE_REPOSITORY?: TourRouteRepository;
    TOURIST_REPOSITORY?: TouristRepository;
    FINANCE_REPOSITORY?: FinanceRepository;
    FINANCE_APPLICATION_REPOSITORY?: FinanceApplicationRepository;
    SETTLEMENT_REPOSITORY?: SettlementRepository;
    COMPANY_SETTINGS_REPOSITORY?: CompanySettingsRepository;
    AUDIT_REPOSITORY?: AuditRepository;
    /**
     * GoTrue 的注入点，只存在于测试。
     *
     * 本地没有 `/auth/v1`（`db:local:*` 只起 PostgREST），登录端点若直接写 `fetch`，
     * 它的每条分支都只能在有真实 Supabase 项目的地方跑到。绑定是对象而不是字符串，
     * 所以 `wrangler.toml` 里写不出它——这一点由类型而不是约定保证。
     */
    OPS_AUTH_UPSTREAM?: OpsAuthUpstream;
    /**
     * 租户侧接收端的基址（定时派发用）。
     *
     * 没配时不静默跳过：命令会落 `failed/unknown` 并留一条可查记录，
     * 因为「看起来在跑、其实一次都没发出去」比直接失败更难查。
     */
    TENANT_API_BASE_URL?: string;
    /**
     * GoTrue `auth.admin` 的注入点，只存在于测试。理由同 `OPS_AUTH_UPSTREAM`：
     * 邀请要真的建一个 auth 用户，而本地没有 `/auth/v1`。
     */
    OPS_INVITE_UPSTREAM?: OpsInviteUpstream;
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    /**
     * 项目 JWT secret，只用于两件事：幂等中间件验签取 `sub`（它跑在 `requireAuth`
     * 之前，拿不到已认证身份），以及本地/CI 的测试签发通道。
     *
     * 不配置时幂等命名空间退化为令牌哈希——同一个人的下一次刷新会换一格，
     * 幂等随之失效。生产必须配。
     */
    SUPABASE_JWT_SECRET?: string;
    APP_BASE_URL?: string;
    APP_VERSION?: string;
    /**
     * 对象存储的公开基址（host，不带 `/storage/v1`）。签名地址由它拼出来。
     *
     * 不配置时回落到本地 Supabase shim 的 54321：生产必须配成项目地址，否则
     * 签发出去的 URL 指向 localhost——这类错误在浏览器里表现为「下载没反应」，
     * 而不是一个报错，所以它必须是一个显式配置项而不是推断出来的值。
     */
    OPS_STORAGE_PUBLIC_URL?: string;
    ALLOWED_ORIGINS?: string;
    RATE_LIMIT_PER_MINUTE?: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
  };
  Variables: {
    auth: AuthContext;
    authToken: string;
    requestId: string;
    /**
     * 运营上下文，只由 `requireOpsAuth()` 写入。与 `auth` 并存而不复用同一个
     * 变量：两套身份来自不同的表、有不同的失败码，混成一个字段会让
     * 「这条路由到底该判哪一套」重新变成读代码才能回答的问题。
     */
    opsContext: OpsContext;
    opsToken: string;
  };
}

export function authVerifier(environment: ApiEnvironment['Bindings']): AuthVerifier {
  if (environment.AUTH_VERIFIER) return environment.AUTH_VERIFIER;
  if (!environment.SUPABASE_URL || !environment.SUPABASE_PUBLISHABLE_KEY) {
    throw new ApiHttpError(
      503,
      ERROR_CODES.INTERNAL_ERROR,
      'Authentication service is not configured',
    );
  }
  return createSupabaseAuthVerifier(environment);
}

export const requireAuth = (): MiddlewareHandler<ApiEnvironment> => async (context, next) => {
  const authorization = context.req.header('Authorization');
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i);

  if (!bearer) {
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  }

  const organizationId = context.req.header('X-Organization-ID');
  const verifier = authVerifier(context.env);
  const identity = organizationId
    ? await verifier.verify(bearer[1], organizationId)
    : await verifier.verify(bearer[1]);
  if (!identity) {
    throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
  }

  context.set('auth', identity);
  context.set('authToken', bearer[1]);
  await next();
};

export const requirePermission =
  (permission: Permission): MiddlewareHandler<ApiEnvironment> =>
  async (context, next) => {
    const identity = context.get('auth');
    if (!identity) {
      throw new ApiHttpError(401, ERROR_CODES.AUTH_REQUIRED, 'Authentication is required');
    }

    if (!(await authVerifier(context.env).hasPermission(identity, permission))) {
      throw new ApiHttpError(
        403,
        ERROR_CODES.FORBIDDEN,
        'You do not have permission to perform this action',
      );
    }

    await next();
  };
