import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 系统设置的取值范围与「只提交改动项」。
 *
 * 三个必须成立的语义：
 * 1. 契约给了上限的项（窗口 1–365、工时 1–720）越界必须被拦住，拦截发生在提交前；
 * 2. 契约**没给**上限的项（导出保留天数）不得编一个上限——只校验正整数；
 * 3. `PATCH` 只带改动项：全量提交会让「两人各改一项」时后提交者回滚前一项。
 */
describe('设置项范围校验', () => {
  it('窗口超过 365 天 → 拒绝，且提示带单位', async () => {
    const { validateSettingsValue } = await import('#/api/ops/identity/rules');

    const result = validateSettingsValue('overviewExpiryWindowDays', 366);

    expect(result).toMatchObject({
      message: expect.stringContaining('365'),
      ok: false,
    });
    expect(result).toMatchObject({
      message: expect.stringContaining('天'),
    });
  });

  it('窗口边界值 1 与 365 都接受', async () => {
    const { validateSettingsValue } = await import('#/api/ops/identity/rules');

    expect(validateSettingsValue('overviewExpiryWindowDays', 1).ok).toBe(true);
    expect(validateSettingsValue('overviewExpiryWindowDays', 365).ok).toBe(
      true,
    );
  });

  it('工时超过 720 小时 → 拒绝', async () => {
    const { validateSettingsValue } = await import('#/api/ops/identity/rules');

    expect(validateSettingsValue('ticketDueHours', 721).ok).toBe(false);
    expect(validateSettingsValue('ticketDueHours', 720).ok).toBe(true);
  });

  it('小数与空值 → 拒绝（服务端会 400，不该等到提交后才知道）', async () => {
    const { validateSettingsValue } = await import('#/api/ops/identity/rules');

    expect(validateSettingsValue('ticketDueHours', '1.5').ok).toBe(false);
    expect(validateSettingsValue('ticketDueHours', '').ok).toBe(false);
    expect(validateSettingsValue('ticketDueHours', 'abc').ok).toBe(false);
  });

  it('导出保留天数契约未给上限：只校验正整数，不编上限', async () => {
    const { validateSettingsValue } = await import('#/api/ops/identity/rules');

    expect(validateSettingsValue('exportRetentionDays', 3650).ok).toBe(true);
    expect(validateSettingsValue('exportRetentionDays', 0).ok).toBe(false);
    expect(validateSettingsValue('exportRetentionDays', -1).ok).toBe(false);
  });
});

describe('只提交改动项', () => {
  const original = {
    exportRetentionDays: 7,
    overviewExpiryWindowDays: 30,
    ticketDueHours: 48,
  };

  it('只改一项时请求体只含该项 + reason', async () => {
    const { buildSettingsPatch } = await import('#/api/ops/identity/rules');

    const result = buildSettingsPatch(
      original,
      { ...original, ticketDueHours: 24 },
      '缩短内部时限',
    );

    expect(result).toMatchObject({
      changed: ['ticketDueHours'],
      ok: true,
      payload: { reason: '缩短内部时限', ticketDueHours: 24 },
    });
  });

  it('没有改动时 changed 为空（调用方据此禁用提交，不发空请求）', async () => {
    const { buildSettingsPatch } = await import('#/api/ops/identity/rules');

    const result = buildSettingsPatch(original, { ...original }, '无改动');

    expect(result).toMatchObject({
      changed: [],
      ok: true,
      payload: { reason: '无改动' },
    });
  });

  it('多项越界时按字段聚合提示，而不是只报第一个', async () => {
    const { buildSettingsPatch } = await import('#/api/ops/identity/rules');

    const result = buildSettingsPatch(
      original,
      { ...original, overviewExpiryWindowDays: 0, ticketDueHours: 999 },
      '测试',
    );

    expect(result).toMatchObject({
      issues: {
        overviewExpiryWindowDays: expect.stringContaining('临期权益窗口'),
        ticketDueHours: expect.stringContaining('720'),
      },
      ok: false,
    });
  });
});
