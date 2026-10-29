import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');
vi.stubEnv('VITE_OPS_MOCK', 'false');

/**
 * 维护期判定与提示分支。
 *
 * 三个必须成立的语义：
 * 1. 状态三分：未到期（healthy）/ 30 天内到期（expiring）/ 已到期（expired），
 *    另有「无法判定」（unknown）——绝不把无法判定渲染成「正常」；
 * 2. 「今天」必须来自服务端业务日期（`referenceDate` 参数 + `businessDateOf`），
 *    函数内部不读浏览器时钟（源码参考门 §5.4）；
 * 3. 关联永久授权时，提示里必须出现「永久授权 ≠ 永久更新」，且维护期仍单独展示。
 */
const REFERENCE = '2026-10-29';

describe('维护期状态判定', () => {
  it('未到期（剩余超过 30 天）→ healthy', async () => {
    const { maintenanceStatus } = await import('#/api/ops/deployment');

    const result = maintenanceStatus({
      maintenanceUntil: '2027-01-31',
      referenceDate: REFERENCE,
    });

    expect(result.state).toBe('healthy');
    expect(result.daysRemaining).toBe(94);
  }, 20_000);

  it('30 天内到期 → expiring（边界 30 天算将到期，31 天算未到期）', async () => {
    const { maintenanceStatus } = await import('#/api/ops/deployment');

    expect(
      maintenanceStatus({
        maintenanceUntil: '2026-11-15',
        referenceDate: REFERENCE,
      }).state,
    ).toBe('expiring');
    expect(
      maintenanceStatus({
        maintenanceUntil: '2026-11-28',
        referenceDate: REFERENCE,
      }).state,
    ).toBe('expiring');
    expect(
      maintenanceStatus({
        maintenanceUntil: '2026-11-29',
        referenceDate: REFERENCE,
      }).state,
    ).toBe('healthy');
  }, 20_000);

  it('已到期 → expired 且剩余天数为负', async () => {
    const { maintenanceStatus } = await import('#/api/ops/deployment');

    const result = maintenanceStatus({
      maintenanceUntil: '2026-08-31',
      referenceDate: REFERENCE,
    });

    expect(result.state).toBe('expired');
    expect(result.daysRemaining).toBeLessThan(0);
  }, 20_000);

  it('未登记维护期 或 未取到服务端日期 → unknown（不猜「正常」）', async () => {
    const { maintenanceStatus } = await import('#/api/ops/deployment');

    expect(
      maintenanceStatus({ maintenanceUntil: null, referenceDate: REFERENCE })
        .state,
    ).toBe('unknown');
    expect(
      maintenanceStatus({ maintenanceUntil: '2027-01-31', referenceDate: null })
        .state,
    ).toBe('unknown');
  }, 20_000);

  it('服务端时刻按 Asia/Shanghai 折算日期（跨 00:00 不差一天）', async () => {
    const { businessDateOf } = await import('#/api/ops/deployment');

    expect(businessDateOf('2026-10-29T17:30:00Z', 'Asia/Shanghai')).toBe(
      '2026-10-30',
    );
    expect(businessDateOf('2026-10-29T02:00:00Z', 'Asia/Shanghai')).toBe(
      '2026-10-29',
    );
    expect(businessDateOf('not-a-date')).toBeNull();
  }, 20_000);

  it('状态文案与颜色三档区分明确', async () => {
    const { maintenanceStateView } = await import('#/api/ops/deployment');

    const expiring = maintenanceStateView({
      maintenanceUntil: '2026-11-15',
      referenceDate: REFERENCE,
    });
    const expired = maintenanceStateView({
      maintenanceUntil: '2026-08-31',
      referenceDate: REFERENCE,
    });
    const healthy = maintenanceStateView({
      maintenanceUntil: '2027-06-30',
      referenceDate: REFERENCE,
    });

    expect(expiring.label).toBe('维护期将到期');
    expect(expiring.color).toBe('orange');
    expect(expiring.summary).toContain('不再包含版本升级与技术支持');

    expect(expired.label).toBe('维护期已到期');
    expect(expired.color).toBe('red');
    expect(expired.summary).toContain('需先续费维护期');

    expect(healthy.label).toBe('维护期内');
    expect(healthy.color).toBe('green');
  }, 20_000);
});

describe('维护期横幅（永久授权 ≠ 永久更新）', () => {
  it('关联永久授权时，提示里明示「永久授权 ≠ 永久更新」且维护期单独展示', async () => {
    const { deploymentMaintenanceNotice } =
      await import('#/api/ops/deployment');

    const notice = deploymentMaintenanceNotice({
      maintenanceUntil: '2026-11-15',
      perpetualLicenseNos: ['LIC-2026-000052（虚构）'],
      referenceDate: REFERENCE,
    });

    expect(notice.permanentNote).toContain('永久授权 ≠ 永久更新');
    expect(notice.permanentNote).toContain('LIC-2026-000052');
    // 维护期状态不因「永久授权」而被放宽
    expect(notice.view.state).toBe('expiring');
  }, 20_000);

  it('未关联永久授权时不渲染永久授权段，避免噪声', async () => {
    const { deploymentMaintenanceNotice } =
      await import('#/api/ops/deployment');

    const notice = deploymentMaintenanceNotice({
      maintenanceUntil: '2026-11-15',
      perpetualLicenseNos: [],
      referenceDate: REFERENCE,
    });

    expect(notice.permanentNote).toBeNull();
  }, 20_000);

  it('横幅组件按三档渲染不同 data-testid 分支', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: MaintenanceBanner } =
      await import('../components/maintenance-banner.vue');

    const expiring = mount(MaintenanceBanner, {
      props: {
        maintenanceUntil: '2026-11-15',
        perpetualLicenseNos: ['LIC-2026-000052（虚构）'],
        referenceDate: REFERENCE,
      },
    });
    expect(
      expiring.find('[data-testid="deployment-maintenance-expiring"]').exists(),
    ).toBe(true);
    expect(expiring.text()).toContain('维护期将到期');
    expect(expiring.text()).toContain('永久授权 ≠ 永久更新');
    expect(
      expiring.find('[data-testid="deployment-perpetual-note"]').exists(),
    ).toBe(true);

    const expired = mount(MaintenanceBanner, {
      props: { maintenanceUntil: '2026-08-31', referenceDate: REFERENCE },
    });
    expect(
      expired.find('[data-testid="deployment-maintenance-expired"]').exists(),
    ).toBe(true);
    expect(expired.text()).toContain('维护期已到期');
    expect(
      expired.find('[data-testid="deployment-perpetual-note"]').exists(),
    ).toBe(false);

    const healthy = mount(MaintenanceBanner, {
      props: { maintenanceUntil: '2027-06-30', referenceDate: REFERENCE },
    });
    expect(
      healthy.find('[data-testid="deployment-maintenance-healthy"]').exists(),
    ).toBe(true);
    expect(healthy.text()).toContain('维护期至 2027-06-30');
  }, 20_000);
});
