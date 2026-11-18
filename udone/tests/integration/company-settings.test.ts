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

async function currentVersion(): Promise<number> {
  const response = await call<SettingsBody>('/api/company-settings', { actor: 'admin' });
  expectStatus(response, 200);
  return response.body.version;
}

describe('公司配置走真实 PostgREST', () => {
  it('读配置返回当前版本', async () => {
    const response = await call<SettingsBody>('/api/company-settings', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body.version).toBeGreaterThanOrEqual(0);
  });

  it('管理员保存配置，版本递增', async () => {
    const before = await currentVersion();
    const response = await call<SettingsBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { theme: 'dark', fontSize: 'large' }, expectedVersion: before },
    });
    expectStatus(response, 200);
    expect(response.body.version).toBe(before + 1);
    expect(response.body.data).toMatchObject({ theme: 'dark', fontSize: 'large' });
  });

  it('敏感配置没有二次确认时返回 400，且不写库', async () => {
    const before = await currentVersion();
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { approvalRules: { selfApproval: true } }, expectedVersion: before },
    });
    expectStatus(response, 400);
    expect(response.body.details).toMatchObject({ field: 'confirmed' });

    const current = await call<SettingsBody>('/api/company-settings', { actor: 'admin' });
    expect(current.body.version).toBe(before);
  });

  it('带上确认后敏感配置可保存', async () => {
    const before = await currentVersion();
    const response = await call<SettingsBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: {
        data: { approvalRules: { selfApproval: true } },
        expectedVersion: before,
        confirmed: true,
      },
    });
    expectStatus(response, 200);
    expect(response.body.version).toBe(before + 1);
  });

  it('旧版本写回被拒，返回可识别的 VERSION_MISMATCH', async () => {
    let before = await currentVersion();
    // 单文件跑时初始版本是 0，没有「更旧的版本」可用；先写一次造出基线。
    if (before === 0) {
      const seed = await call<SettingsBody>('/api/company-settings', {
        method: 'PATCH',
        actor: 'admin',
        body: { data: { theme: 'system' }, expectedVersion: 0 },
      });
      expectStatus(seed, 200);
      before = seed.body.version;
    }
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'admin',
      body: { data: { theme: 'light' }, expectedVersion: before - 1 },
    });
    expectStatus(response, 409);
    expect(response.body).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(response.body.details?.reason).toBe('VERSION_MISMATCH');
  });

  it('无 settings.manage 的角色不能写', async () => {
    const before = await currentVersion();
    const response = await call<ErrorBody>('/api/company-settings', {
      method: 'PATCH',
      actor: 'operator',
      body: { data: { theme: 'light' }, expectedVersion: before },
    });
    expectStatus(response, 403);
  });
});
