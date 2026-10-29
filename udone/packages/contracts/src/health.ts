import { z } from 'zod';

export const dependencyStatusSchema = z.enum(['available', 'unavailable', 'missing_configuration']);
export const healthStatusSchema = z.enum(['ok', 'degraded']);

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  version: z.string(),
  requestId: z.string(),
  dependencies: z.object({ supabase: dependencyStatusSchema }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
