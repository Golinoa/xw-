import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface SettingsBody {
  organizationId: string;
  data: Record<string, unknown>;
  version: number;
}

interface ErrorBody {
  code?: string;
  details?: { reason?: string; field?: string };
}

describe('公司配置走真实 PostgREST', () => {
  it('读默认值：版本 0，空配置', async () => {
    const response = await call<SettingsBody>('/api/company-settings', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body.version).toBe(0);
  });

  it('管理员保存第一版，版本递增', async () => {
    const response = await call<SettingsBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { theme: 'dark', fontSize: 'large' }, expectedVersion: 0 },
    });
    expectStatus(response, 200);
    expect(response.body.version).toBe(1);
    expect(response.body.data).toMatchObject({ theme: 'dark', fontSize: 'large' });
  });

  it('敏感配置没有二次确认时返回 400，且不写库', async () => {
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { approvalRules: { selfApproval: true } }, expectedVersion: 1 },
    });
    expectStatus(response, 400);
    expect(response.body.details).toMatchObject({ field: 'confirmed' });

    const current = await call<SettingsBody>('/api/company-settings', { actor: 'admin' });
    expect(current.body.version).toBe(1);
  });

  it('带上确认后敏感配置可保存', async () => {
    const response = await call<SettingsBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: {
        data: { approvalRules: { selfApproval: true } },
        expectedVersion: 1,
        confirmed: true,
      },
    });
    expectStatus(response, 200);
    expect(response.body.version).toBe(2);
  });

  it('旧版本写回被拒，返回可识别的 VERSION_MISMATCH', async () => {
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { theme: 'light' }, expectedVersion: 1 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(response.body.details?.reason).toBe('VERSION_MISMATCH');
  });

  it('无 settings.manage 的角色不能写', async () => {
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'operator',
      body: { data: { theme: 'light' }, expectedVersion: 2 },
    });
    expectStatus(response, 403);
  });
});
