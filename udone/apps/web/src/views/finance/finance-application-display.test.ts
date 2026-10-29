import { describe, expect, it } from 'vitest';
import type { FinanceApplicationItem, Permission } from '@erp/contracts';
import {
  APPLICATION_STATUS_FILTER_OPTIONS,
  applicationStageLabel,
  applicantLabel,
  canDecide,
  canUndo,
  canWithdraw,
  hasRowActions,
  isApplicationKind,
  isStatusFilter,
  opinionRequired,
} from './finance-application-display';

/**
 * 按钮可见性的断言。这些规则每一条都有对应的服务端校验，但两边不一致时
 * 用户看到的先是「按钮能点」，后是「被拒绝」——那就是界面在骗人。
 */

function item(overrides: Partial<FinanceApplicationItem> = {}): FinanceApplicationItem {
  return {
    id: 'app-1',
    kind: 'receipt',
    status: 'pending',
    currentStep: 1,
    orderId: 'order-1',
    orderNumber: 'SO-20261029-000009',
    customerName: '张三',
    lineId: 'rec-1',
    lineName: '团费',
    amount: 3000,
    method: 'bank',
    occurredOn: '2026-10-29',
    referenceNo: null,
    voucherUrl: null,
    remark: null,
    createdBy: 'user-operator',
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const approver: readonly Permission[] = ['order.read', 'finance.approve'];
const creator: readonly Permission[] = ['order.read', 'finance.write'];

describe('application row labels', () => {
  it('shows which step is waiting', () => {
    expect(applicationStageLabel(item({ currentStep: 1 }))).toBe('待财务审批');
    expect(applicationStageLabel(item({ currentStep: 2 }))).toBe('待管理员终审');
  });

  it('hides the step once the application is finished', () => {
    // 已驳回的行上摆「第 2 级」会让人以为还在等谁审批。
    expect(applicationStageLabel(item({ status: 'rejected', currentStep: 2 }))).toBe('—');
    expect(applicationStageLabel(item({ status: 'approved', currentStep: 2 }))).toBe('—');
  });

  it('does not invent a colleague name it cannot read', () => {
    // profiles 只有 select_self 策略，读不到同事姓名，只能区分「你 / 其他成员」。
    expect(applicantLabel(item(), 'user-operator')).toBe('你');
    expect(applicantLabel(item(), 'user-finance')).toBe('其他成员');
    expect(applicantLabel(item({ createdBy: null }), 'user-finance')).toBe('—');
    expect(applicantLabel(item(), null)).toBe('其他成员');
  });
});

describe('decision visibility', () => {
  it('lets an approver decide someone else pending application', () => {
    expect(canDecide(item(), approver, 'user-finance')).toBe(true);
  });

  it('hides the decision from the creator even when they hold finance.approve', () => {
    // 服务端会返回 SELF_APPROVAL_FORBIDDEN；界面不该先让人点开审批框。
    expect(canDecide(item(), approver, 'user-operator')).toBe(false);
  });

  it('hides the decision without finance.approve', () => {
    expect(canDecide(item(), creator, 'user-finance')).toBe(false);
  });

  it('hides the decision once the application is decided', () => {
    for (const status of ['approved', 'rejected', 'withdrawn'] as const) {
      expect(canDecide(item({ status }), approver, 'user-finance')).toBe(false);
    }
  });

  it('allows deciding when the creator is unknown', () => {
    // created_by 允许为 null（用户被删除），这时不应因为「可能是自己」而永久卡住。
    expect(canDecide(item({ createdBy: null }), approver, 'user-finance')).toBe(true);
  });
});

describe('withdraw and undo visibility', () => {
  it('lets only the creator withdraw a pending application', () => {
    expect(canWithdraw(item(), 'user-operator')).toBe(true);
    expect(canWithdraw(item(), 'user-finance')).toBe(false);
  });

  it('does not offer a withdrawal on an already decided application', () => {
    expect(canWithdraw(item({ status: 'approved' }), 'user-operator')).toBe(false);
  });

  it('offers an undo only on approved applications to approvers', () => {
    expect(canUndo(item({ status: 'approved' }), approver)).toBe(true);
    expect(canUndo(item({ status: 'approved' }), creator)).toBe(false);
    expect(canUndo(item({ status: 'pending' }), approver)).toBe(false);
  });

  it('knows when a row has no actions at all', () => {
    const decided = item({ status: 'approved', createdBy: 'someone-else' });
    expect(hasRowActions(decided, creator, 'user-operator')).toBe(false);
    expect(hasRowActions(item(), approver, 'user-finance')).toBe(true);
  });
});

describe('filters and validation helpers', () => {
  it('keeps the status filter values aligned with the contract enum', () => {
    expect(APPLICATION_STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual([
      'all',
      'pending',
      'approved',
      'rejected',
      'withdrawn',
    ]);
  });

  it('rejects unknown query values instead of forwarding them', () => {
    expect(isStatusFilter('pending')).toBe(true);
    expect(isStatusFilter('waiting')).toBe(false);
    expect(isApplicationKind('payment')).toBe(true);
    expect(isApplicationKind('refund')).toBe(false);
  });

  it('requires an opinion only when rejecting', () => {
    expect(opinionRequired('reject')).toBe(true);
    expect(opinionRequired('approve')).toBe(false);
  });
});
