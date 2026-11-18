import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, ReportResponse } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { ReportRepository } from './report-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read'],
  dataScope: 'all',
};
const operator: AuthContext = { ...admin, role: 'operator', permissions: [] };

const report: ReportResponse = {
  dateField: 'createdAt',
  from: '2026-11-01',
  to: '2026-11-30',
  includeCancelled: false,
  overview: { orderCount: 2, receivableTotal: 10000, payableTotal: 6000, profit: 4000 },
  finance: { confirmedIn: 3000, pendingIn: 1000, confirmedOut: 2000, pendingOut: 500 },
  byStatus: { active: 1, completed: 1 },
};

function repositoryStub(overrides: Partial<ReportRepository> = {}): ReportRepository {
  return {
    tenant: vi.fn().mockResolvedValue(report),
    suppliers: vi.fn().mockResolvedValue({ items: [] }),
    ...overrides,
  };
}

function setup(repository: ReportRepository, identity: AuthContext = admin) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (ctx, permission) => ctx.permissions.includes(permission)),
    },
    REPORT_REPOSITORY: repository,
  };
  return { testApp, env };
}

const headers = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };

describe('report routes', () => {
  it('returns the shared口径 report', async () => {
    const tenant = vi.fn().mockResolvedValue(report);
    const { testApp, env } = setup(repositoryStub({ tenant }));
    const response = await testApp.request(
      '/api/reports/tenant?from=2026-11-01&to=2026-11-30',
      { headers },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReportResponse;
    expect(body.overview.orderCount).toBe(2);
    expect(body.dateField).toBe('createdAt');
    expect(tenant).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-11-01', includeCancelled: false }),
      ORG,
    );
  });

  it('passes includeCancelled through', async () => {
    const tenant = vi.fn().mockResolvedValue(report);
    const { testApp, env } = setup(repositoryStub({ tenant }));
    const response = await testApp.request(
      '/api/reports/tenant?from=2026-11-01&to=2026-11-30&includeCancelled=true',
      { headers },
      env,
    );
    expect(response.status).toBe(200);
    expect(tenant).toHaveBeenCalledWith(expect.objectContaining({ includeCancelled: true }), ORG);
  });

  it('rejects an invalid date format', async () => {
    const tenant = vi.fn();
    const { testApp, env } = setup(repositoryStub({ tenant }));
    const response = await testApp.request(
      '/api/reports/tenant?from=2026/11/01&to=2026-11-30',
      { headers },
      env,
    );
    expect(response.status).toBe(400);
    expect(tenant).not.toHaveBeenCalled();
  });

  it('returns supplier statistics from the same range', async () => {
    const suppliers = vi.fn().mockResolvedValue({ items: [] });
    const { testApp, env } = setup(repositoryStub({ suppliers }));
    const response = await testApp.request(
      '/api/reports/suppliers?from=2026-11-01&to=2026-11-30',
      { headers },
      env,
    );
    expect(response.status).toBe(200);
    expect(suppliers).toHaveBeenCalledWith(expect.any(Object), ORG);
  });

  it('refuses reads without order.read', async () => {
    const tenant = vi.fn();
    const { testApp, env } = setup(repositoryStub({ tenant }), operator);
    const response = await testApp.request(
      '/api/reports/tenant?from=2026-11-01&to=2026-11-30',
      { headers },
      env,
    );
    expect(response.status).toBe(403);
    expect(tenant).not.toHaveBeenCalled();
  });
});
