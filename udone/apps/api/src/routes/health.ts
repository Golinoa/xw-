import { Hono } from 'hono';
import { ROUTES } from '@erp/contracts';
import type { DependencyStatus } from '@erp/contracts';
import { respond } from '../lib/contract';
import type { ApiEnvironment } from '../middleware/auth';

async function checkSupabase(environment: ApiEnvironment['Bindings']): Promise<DependencyStatus> {
  if (!environment.SUPABASE_URL || !environment.SUPABASE_PUBLISHABLE_KEY)
    return 'missing_configuration';
  try {
    const response = await fetch(`${environment.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/health`, {
      headers: { apikey: environment.SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    return response.ok ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export const healthRoutes = new Hono<ApiEnvironment>().get(ROUTES.health.path, async (context) => {
  const supabase = await checkSupabase(context.env);
  const ready = supabase === 'available';

  return respond(
    context,
    'health',
    {
      status: ready ? 'ok' : 'degraded',
      version: context.env.CF_VERSION_METADATA?.id ?? context.env.APP_VERSION ?? 'development',
      requestId: context.get('requestId'),
      dependencies: { supabase },
    },
    ready ? 200 : 503,
  );
});
