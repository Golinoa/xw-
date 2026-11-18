import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, CompanySettings } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { CompanySettingsRepository } from './company-settings-service';

const ORG = 'a0000000-0000-4000-8000-000000000001';
const USER = 'a1000000-0000-4000-8000-000000000001';

const admin: AuthContext = {
  userId: USER,
  organizationId: ORG,
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['settings.manage'],
  dataScope: 'all',
};

const operator: AuthContext = {
  ...admin,
  userId: 'a1000000-0000-4000-8000-000000000002',
  role: 'operator',
  permissions: [],
};

function settings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    organizationId: ORG,
    data: { theme: 'light', fontSize: 'medium' },
    version: 1,
    updatedAt: '2026-11-18T00:00:00Z',
    updatedBy: USER,
    ...overrides,
  };
}

function repositoryStub(
  overrides: Partial<CompanySettingsRepository> = {},
): CompanySettingsRepository {
  return {
    get: vi.fn().mockResolvedValue(settings()),
    update: vi.fn().mockResolvedValue({ settings: settings({ version: 2 }) }),
    ...overrides,
  };
}

function setup(repository: CompanySettingsRepository, identity: AuthContext = admin) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    COMPANY_SETTINGS_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': ORG };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

describe('company settings routes', () => {
  it('reads the current version for a member', async () => {
    const { testApp, env } = setup(repositoryStub());
    const response = await testApp.request('/api/company-settings', { headers: authHeaders }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 1, data: { theme: 'light' } });
  });

  it('requires a second confirmation before changing approval rules', async () => {
    const update = vi.fn().mockResolvedValue({ settings: settings({ version: 2 }) });
    const { testApp, env } = setup(repositoryStub({ update }));
    const response = await testApp.request(
      '/api/company-settings',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({
          data: { approvalRules: { selfApproval: true } },
          expectedVersion: 1,
        }),
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(update).not.toHaveBeenCalled();
  });

  it('passes confirmed writes through with the expected version', async () => {
    const update = vi.fn().mockResolvedValue({ settings: settings({ version: 2 }) });
    const { testApp, env } = setup(repositoryStub({ update }));
    const response = await testApp.request(
      '/api/company-settings',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({
          data: { approvalRules: { selfApproval: true } },
          expectedVersion: 1,
          confirmed: true,
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith(ORG, { approvalRules: { selfApproval: true } }, 1);
  });

  it('maps a stale version to 409 without losing the conflict reason', async () => {
    const { testApp, env } = setup(
      repositoryStub({ update: vi.fn().mockResolvedValue({ error: 'VERSION_CONFLICT' }) }),
    );
    const response = await testApp.request(
      '/api/company-settings',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ data: { theme: 'dark' }, expectedVersion: 1 }),
      },
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('refuses a write without settings.manage', async () => {
    const update = vi.fn();
    const { testApp, env } = setup(repositoryStub({ update }), operator);
    const response = await testApp.request(
      '/api/company-settings',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ data: { theme: 'dark' }, expectedVersion: 1 }),
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });
});
