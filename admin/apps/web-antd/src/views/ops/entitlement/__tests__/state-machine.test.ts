import { describe, expect, it } from 'vitest';

import {
  changeRequestActions,
  entitlementStatusActions,
  isHighRiskEntitlementAction,
  validateLicenseTerm,
} from '#/api/ops/entitlement/rules';
import { OPS_PERMISSION } from '#/constants/permissions';

/**
 * 状态机：只允许契约 §3.5 列出的迁移。
 *
 * 「只渲染当前态允许的动作」的呈现侧断言在下方组件测试里（`state-machine-panel`），
 * 这里先固定动作表本身，避免页面和规则各写一套。
 */
describe('权益状态机', () => {
  it('草稿只有 submit，没有审批/执行类动作', () => {
    const keys = entitlementStatusActions('draft').map((action) => action.key);
    expect(keys).toEqual(['submit']);
    expect(
      entitlementStatusActions('draft').every(
        (action) => action.permission === OPS_PERMISSION.ENTITLEMENT_REQUEST,
      ),
    ).toBe(true);
  });

  it('待审批只有 approve / reject，且都需要 entitlement.approve', () => {
    const actions = entitlementStatusActions('pending_approval');
    expect(actions.map((action) => action.key)).toEqual(['approve', 'reject']);
    expect(
      actions.every(
        (action) => action.permission === OPS_PERMISSION.ENTITLEMENT_APPROVE,
      ),
    ).toBe(true);
    expect(actions.every((action) => action.highRisk)).toBe(true);
  });

  it('生效中只能发起变更申请，不出现直接改状态的动作', () => {
    const actions = entitlementStatusActions('active');
    const keys = actions.map((action) => action.key);
    expect(keys).not.toContain('submit');
    expect(keys).not.toContain('approve');
    expect(keys).toContain('change:suspend');
    expect(keys).toContain('change:revoke');
    expect(keys).toContain('change:quota_change');
    // 生效中「恢复」没有意义（当前并未暂停）
    expect(keys).not.toContain('change:resume');
    // 所有动作都是「创建变更申请」，权限为 entitlement.request
    expect(
      actions.every(
        (action) =>
          action.changeType !== undefined &&
          action.permission === OPS_PERMISSION.ENTITLEMENT_REQUEST,
      ),
    ).toBe(true);
  });

  it('已暂停时可以申请恢复，但不再重复「暂停」', () => {
    const keys = entitlementStatusActions('suspended').map(
      (action) => action.key,
    );
    expect(keys).toContain('change:resume');
    expect(keys).not.toContain('change:suspend');
  });

  it('终态（已撤销/已到期）没有任何可用动作，只能新建', () => {
    expect(entitlementStatusActions('revoked')).toEqual([]);
    expect(entitlementStatusActions('expired')).toEqual([]);
  });

  it('变更申请：未审批（pending_approval）只给审批/驳回/取消，不给执行', () => {
    const keys = changeRequestActions('pending_approval').map(
      (action) => action.key,
    );
    expect(keys).toEqual(['approve', 'reject', 'cancel']);
    expect(keys).not.toContain('execute');
  });

  it('变更申请：已审批才出现执行，失败才出现重试', () => {
    expect(
      changeRequestActions('approved', 'extend').map((a) => a.key),
    ).toEqual(['execute', 'cancel']);
    expect(changeRequestActions('failed', 'extend').map((a) => a.key)).toEqual([
      'retry',
    ]);
    expect(changeRequestActions('executed', 'extend')).toEqual([]);
    expect(changeRequestActions('rejected', 'extend')).toEqual([]);
  });

  it('高风险：审批恒为高风险；执行仅在撤销/暂停时为高风险', () => {
    expect(
      isHighRiskEntitlementAction({
        permission: OPS_PERMISSION.ENTITLEMENT_APPROVE,
      }),
    ).toBe(true);
    expect(
      isHighRiskEntitlementAction({
        changeType: 'revoke',
        permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
      }),
    ).toBe(true);
    expect(
      isHighRiskEntitlementAction({
        changeType: 'suspend',
        permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
      }),
    ).toBe(true);
    expect(
      isHighRiskEntitlementAction({
        changeType: 'extend',
        permission: OPS_PERMISSION.ENTITLEMENT_EXECUTE,
      }),
    ).toBe(false);
    expect(
      isHighRiskEntitlementAction({
        permission: OPS_PERMISSION.ENTITLEMENT_REQUEST,
      }),
    ).toBe(false);
  });

  it('永久授权不能填到期日，限期授权必须填（契约 CHECK 反向约束）', () => {
    expect(
      validateLicenseTerm({
        licenseMode: 'perpetual',
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
      }).allowed,
    ).toBe(false);
    expect(
      validateLicenseTerm({
        licenseMode: 'perpetual',
        validFrom: '2026-01-01',
      }).allowed,
    ).toBe(true);
    expect(
      validateLicenseTerm({ licenseMode: 'term', validFrom: '2026-01-01' })
        .allowed,
    ).toBe(false);
    expect(
      validateLicenseTerm({
        licenseMode: 'term',
        validFrom: '2026-01-01',
        validTo: '2025-12-31',
      }).allowed,
    ).toBe(false);
  });
});
