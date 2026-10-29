import type { AuthContext, AuthRole, DataScope, Permission } from '@erp/contracts';
import type { ApiEnvironment, AuthVerifier } from '../middleware/auth';

type AuthorizationRow = {
  organization_id: string;
  role: AuthRole;
  permissions: Permission[];
  data_scope: DataScope;
};

function decodeClaims(token: string): { sub: string; session_id: string } | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')),
    ) as {
      sub?: unknown;
      session_id?: unknown;
    };
    if (typeof claims.sub !== 'string' || typeof claims.session_id !== 'string') return null;
    return { sub: claims.sub, session_id: claims.session_id };
  } catch {
    return null;
  }
}

function isAuthRole(value: unknown): value is AuthRole {
  return value === 'admin' || value === 'operator' || value === 'finance';
}

export function createSupabaseAuthVerifier(
  environment: Pick<ApiEnvironment['Bindings'], 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'>,
  fetcher: typeof fetch = fetch,
): AuthVerifier {
  const baseUrl = environment.SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY;

  return {
    async verify(token, organizationId) {
      const claims = decodeClaims(token);
      if (!claims || !baseUrl || !publishableKey) return null;

      const headers = {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      };
      const userResponse = await fetcher(`${baseUrl}/auth/v1/user`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (!userResponse.ok) return null;
      const user = (await userResponse.json()) as { id?: unknown };
      if (user.id !== claims.sub) return null;

      const membershipHeaders = {
        ...headers,
        'Content-Type': 'application/json',
        ...(organizationId ? { 'X-Organization-ID': organizationId } : {}),
      };
      const authorizationResponse = await fetcher(
        `${baseUrl}/rest/v1/rpc/get_current_auth_context`,
        {
          method: 'POST',
          headers: membershipHeaders,
          body: JSON.stringify({ requested_organization_id: organizationId ?? null }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!authorizationResponse.ok) {
        throw new Error(
          `Authorization context verification failed (${authorizationResponse.status})`,
        );
      }
      const rows = (await authorizationResponse.json()) as AuthorizationRow[];
      const authorization = rows[0];
      if (
        !authorization ||
        !isAuthRole(authorization.role) ||
        !Array.isArray(authorization.permissions) ||
        (authorization.data_scope !== 'own' && authorization.data_scope !== 'all') ||
        (organizationId && authorization.organization_id !== organizationId)
      )
        return null;

      return {
        userId: claims.sub,
        organizationId: authorization.organization_id,
        role: authorization.role,
        sessionId: claims.session_id,
        permissions: authorization.permissions,
        dataScope: authorization.data_scope,
      } satisfies AuthContext;
    },

    async hasPermission(context, permission) {
      return context.permissions.includes(permission);
    },
  };
}
