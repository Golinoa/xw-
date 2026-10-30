import type { MiddlewareHandler } from 'hono';
import type { AuthContext, OpsContext, Permission } from '@erp/contracts';
import { ERROR_CODES } from '@erp/contracts';
import type { OrganizationRepository } from '../services/organization-service';
import type { CustomerRepository } from '../modules/customers/customer-service';
import type { OrderRepository } from '../modules/orders/order-service';
import type { SupplierRepository } from '../modules/suppliers/supplier-service';
import type { FinanceRepository } from '../modules/finance/finance-service';
import type { FinanceApplicationRepository } from '../modules/finance-applications/finance-application-service';
import { ApiHttpError } from './error-handler';
import { createSupabaseAuthVerifier } from '../services/supabase-auth-verifier';

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
    FINANCE_REPOSITORY?: FinanceRepository;
    FINANCE_APPLICATION_REPOSITORY?: FinanceApplicationRepository;
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
