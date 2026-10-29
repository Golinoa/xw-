import type { MiddlewareHandler } from 'hono';
import type { AuthContext, Permission } from '@erp/contracts';
import { ERROR_CODES } from '@erp/contracts';
import type { OrganizationRepository } from '../services/organization-service';
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
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    APP_BASE_URL?: string;
    APP_VERSION?: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
  };
  Variables: {
    auth: AuthContext;
    authToken: string;
    requestId: string;
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
