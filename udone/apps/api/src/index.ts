import { Hono } from 'hono';
import { errorHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import type { ApiEnvironment } from './middleware/auth';
import { healthRoutes } from './routes/health';
import { organizationRoutes } from './routes/organizations';
import { memberRoutes } from './modules/members/routes';

export const app = new Hono<ApiEnvironment>();

app.use('*', requestId());
app.onError(errorHandler);
app.route('/', healthRoutes);
app.route('/', organizationRoutes);
app.route('/', memberRoutes);

export default app;
