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

export default app;
