import { financeApplicationItemSchema, PERMISSIONS } from '@erp/contracts';
import { describe, expect, it } from 'vitest';

import {
  applicantLabelKey,
  applicationStageLabelKey,
  canDecide,
  canUndo,
  canWithdraw,
  isStatusFilter,
} from '../finance-application-display';

const APPROVER = '00000000-0000-4000-8000-000000000001';
const APPLICANT = '00000000-0000-4000-8000-000000000002';

function item(overrides: Record<string, unknown> = {}) {
  return financeApplicationItemSchema.parse({
    amount: 1000,
    createdAt: '2026-11-24T06:00:00.000Z',
    createdBy: APPLICANT,
    currentStep: 1,
    customerName: '张伟',
    id: 'app-1',
    kind: 'receipt',
    lineId: 'line-1',
    lineName: '团费',
    method: 'bank',
    occurredOn: '2026-11-24',
    orderId: 'order-1',
    orderNumber: 'OD-20261124-001',
    referenceNo: null,
    remark: null,
    status: 'pending',
    updatedAt: '2026-11-24T06:00:00.000Z',
    version: 1,
    voucherUrl: null,
    ...overrides,
  });
}

const approve = [PERMISSIONS.FINANCE_APPROVE];
const noApprove = [PERMISSIONS.ORDER_READ];

describe('审批动作可见性', () => {
  it('有审批权限、待审且不是自己提交的，才能审批', () => {
    expect(canDecide(item(), approve, APPROVER)).toBe(true);
  });

  it('禁止自审：创建人即使有审批权限也看不到审批按钮', () => {
    expect(canDecide(item(), approve, APPLICANT)).toBe(false);
  });

  it('没有 finance.approve 就不能审批', () => {
    expect(canDecide(item(), noApprove, APPROVER)).toBe(false);
  });

  it('非待审状态不能审批', () => {
    expect(canDecide(item({ status: 'approved' }), approve, APPROVER)).toBe(false);
    expect(canDecide(item({ status: 'rejected' }), approve, APPROVER)).toBe(false);
    expect(canDecide(item({ status: 'withdrawn' }), approve, APPROVER)).toBe(false);
  });

  it('createdBy 为空时不算自审（系统创建的记录仍可审批）', () => {
    expect(canDecide(item({ createdBy: null }), approve, APPROVER)).toBe(true);
  });
});

describe('撤回与撤销终审', () => {
  it('撤回只给创建人，且只对待审有效', () => {
    expect(canWithdraw(item(), APPLICANT)).toBe(true);
    expect(canWithdraw(item(), APPROVER)).toBe(false);
    expect(canWithdraw(item({ status: 'approved' }), APPLICANT)).toBe(false);
    expect(canWithdraw(item({ createdBy: null }), APPLICANT)).toBe(false);
  });

  it('撤销终审只对已通过的申请，要求审批权限', () => {
    expect(canUndo(item({ status: 'approved' }), approve)).toBe(true);
    expect(canUndo(item({ status: 'approved' }), noApprove)).toBe(false);
    expect(canUndo(item({ status: 'rejected' }), approve)).toBe(false);
    expect(canUndo(item(), approve)).toBe(false);
  });
});

describe('展示文案键', () => {
  it('申请人只区分你/其他成员，不暴露姓名', () => {
    expect(applicantLabelKey(item(), APPLICANT)).toBe('shell.applications.applicantYou');
    expect(applicantLabelKey(item(), APPROVER)).toBe('shell.applications.applicantOther');
    expect(applicantLabelKey(item({ createdBy: null }), APPROVER)).toBe(
      'shell.applications.applicantNone',
    );
  });

  it('级次只对暂审申请有意义，终审后不显示', () => {
    expect(applicationStageLabelKey(item({ currentStep: 1 }))).toBe(
      'shell.applications.stepFinance',
    );
    expect(applicationStageLabelKey(item({ currentStep: 2 }))).toBe(
      'shell.applications.stepAdmin',
    );
    expect(applicationStageLabelKey(item({ status: 'approved', currentStep: 2 }))).toBe('');
    expect(applicationStageLabelKey(item({ status: 'rejected', currentStep: 2 }))).toBe('');
  });

  it('状态筛选：all 只在界面存在，契约四态都要认', () => {
    expect(isStatusFilter('all')).toBe(true);
    for (const status of ['pending', 'approved', 'rejected', 'withdrawn']) {
      expect(isStatusFilter(status)).toBe(true);
    }
    expect(isStatusFilter('unknown')).toBe(false);
  });
});
