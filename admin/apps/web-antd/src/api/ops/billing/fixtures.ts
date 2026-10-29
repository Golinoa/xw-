/**
 * 开发态账款桩的**虚构**数据。
 *
 * 硬约束：
 * 1. 全部为虚构客户、虚构合同号、虚构金额，禁止写入任何真实客户或真实金额；
 * 2. 客户名带「（虚构）」后缀，编号使用连续演示序号；
 * 3. 只在 `VITE_OPS_MOCK=true` 且非生产构建时加载（见 `endpoints.ts` / `adapter/env.ts`）；
 * 4. 页面必须同时展示「开发态数据」提示——桩数据绝不冒充真实集成。
 *
 * 应收 `status` 不落库（契约 §3.4：派生值），由 `dev-stub.ts` 按同一优先级函数计算，
 * 避免桩里出现"和真实口径不一致的状态"。
 */
import type {
  BillingReversalLine,
  ReceiptStatus,
  ReceivableExtension,
  Refund,
} from './types';

/** 桩会话里的当前运营成员（与 `api/ops/__stub__/fixtures.ts` 的 STUB_OPERATOR 保持一致）。 */
export const STUB_CURRENT_OPERATOR_ID = '00000000-0000-4000-8000-000000000001';

export const STUB_OPERATORS = {
  financeReviewer: {
    displayName: '财务复核·李（虚构）',
    id: '00000000-0000-4000-8000-000000000002',
  },
  receiptRecorder: {
    displayName: '收款登记·王（虚构）',
    id: '00000000-0000-4000-8000-000000000003',
  },
  settlement: {
    displayName: '结算复核·赵（虚构）',
    id: '00000000-0000-4000-8000-000000000004',
  },
} as const;

export const STUB_CUSTOMERS = {
  c1: {
    customerNo: 'KH-2026-000101',
    id: '11111111-1111-4111-8111-111111111101',
    name: '星澜文旅集团有限公司（虚构）',
  },
  c2: {
    customerNo: 'KH-2026-000102',
    id: '11111111-1111-4111-8111-111111111102',
    name: '云栖数据服务有限公司（虚构）',
  },
} as const;

export const STUB_CONTRACTS = {
  ht1: {
    contractNo: 'HT-2026-000201',
    id: '22222222-2222-4222-8222-222222222201',
  },
  ht2: {
    contractNo: 'HT-2026-000202',
    id: '22222222-2222-4222-8222-222222222202',
  },
} as const;

/** 应收行（不含派生状态）。 */
export interface StubReceivableRow {
  allocatedAmount: number;
  amount: number;
  contractId: string;
  contractNo: string;
  currency: string;
  customerId: string;
  dueDate: string;
  id: string;
  note?: string;
  periodNo: number;
  reversedAmount: number;
  version: number;
}

export const STUB_RECEIVABLES: StubReceivableRow[] = [
  {
    allocatedAmount: 120_000,
    amount: 120_000,
    contractId: STUB_CONTRACTS.ht1.id,
    contractNo: STUB_CONTRACTS.ht1.contractNo,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    dueDate: '2026-09-30',
    id: '33333333-3333-4333-8333-333333333301',
    note: '首期款（虚构数据）',
    periodNo: 1,
    reversedAmount: 0,
    version: 2,
  },
  {
    allocatedAmount: 40_000,
    amount: 120_000,
    contractId: STUB_CONTRACTS.ht1.id,
    contractNo: STUB_CONTRACTS.ht1.contractNo,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    dueDate: '2026-11-30',
    id: '33333333-3333-4333-8333-333333333302',
    note: '二期款（已展期，虚构数据）',
    periodNo: 2,
    reversedAmount: 0,
    version: 3,
  },
  {
    allocatedAmount: 15_000,
    amount: 120_000,
    contractId: STUB_CONTRACTS.ht1.id,
    contractNo: STUB_CONTRACTS.ht1.contractNo,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    dueDate: '2026-12-31',
    id: '33333333-3333-4333-8333-333333333303',
    note: '三期款（核销已撤销，虚构数据）',
    periodNo: 3,
    reversedAmount: 15_000,
    version: 2,
  },
  {
    allocatedAmount: 0,
    amount: 86_000,
    contractId: STUB_CONTRACTS.ht2.id,
    contractNo: STUB_CONTRACTS.ht2.contractNo,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c2.id,
    dueDate: '2026-08-31',
    id: '33333333-3333-4333-8333-333333333304',
    note: '首期款（逾期演示，虚构数据）',
    periodNo: 1,
    reversedAmount: 0,
    version: 1,
  },
  {
    allocatedAmount: 30_000,
    amount: 86_000,
    contractId: STUB_CONTRACTS.ht2.id,
    contractNo: STUB_CONTRACTS.ht2.contractNo,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c2.id,
    dueDate: '2026-11-30',
    id: '33333333-3333-4333-8333-333333333305',
    note: '二期款（部分收款，虚构数据）',
    periodNo: 2,
    reversedAmount: 0,
    version: 2,
  },
];

export interface StubReceiptRow {
  allocatedAmount: number;
  amount: number;
  approvedAt?: null | string;
  approvedBy?: null | string;
  contractId?: null | string;
  currency: string;
  customerId: string;
  id: string;
  methodCode: string;
  receiptNo: string;
  recordedBy: string;
  recordedReason?: null | string;
  referenceNo?: null | string;
  status: ReceiptStatus;
  transactionDate: string;
  version: number;
  voucherRef?: null | string;
}

export const STUB_RECEIPTS: StubReceiptRow[] = [
  {
    allocatedAmount: 120_000,
    amount: 120_000,
    approvedAt: '2026-10-02T03:10:00Z',
    approvedBy: STUB_OPERATORS.financeReviewer.id,
    contractId: STUB_CONTRACTS.ht1.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '44444444-4444-4444-8444-444444444401',
    methodCode: 'bank_transfer',
    receiptNo: 'RC-2026-000301',
    recordedBy: STUB_OPERATORS.receiptRecorder.id,
    referenceNo: 'TRX-DEMO-0001',
    status: 'reconciled',
    transactionDate: '2026-10-02',
    version: 3,
  },
  {
    allocatedAmount: 40_000,
    amount: 40_000,
    approvedAt: '2026-10-12T06:30:00Z',
    approvedBy: STUB_OPERATORS.financeReviewer.id,
    contractId: STUB_CONTRACTS.ht1.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '44444444-4444-4444-8444-444444444402',
    methodCode: 'bank_transfer',
    receiptNo: 'RC-2026-000302',
    recordedBy: STUB_OPERATORS.receiptRecorder.id,
    referenceNo: 'TRX-DEMO-0002',
    status: 'reconciled',
    transactionDate: '2026-10-12',
    version: 3,
  },
  {
    // 当前登录人自己登记的收款：审核按钮必须不可用（职责分离演示）
    allocatedAmount: 0,
    amount: 86_000,
    contractId: STUB_CONTRACTS.ht2.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c2.id,
    id: '44444444-4444-4444-8444-444444444403',
    methodCode: 'cash',
    receiptNo: 'RC-2026-000303',
    recordedBy: STUB_CURRENT_OPERATOR_ID,
    recordedReason: '客户现场交付现金（虚构数据）',
    referenceNo: 'CASH-DEMO-0001',
    status: 'recorded',
    transactionDate: '2026-10-20',
    version: 1,
  },
  {
    allocatedAmount: 30_000,
    amount: 30_000,
    approvedAt: '2026-10-18T01:00:00Z',
    approvedBy: STUB_OPERATORS.settlement.id,
    contractId: STUB_CONTRACTS.ht2.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c2.id,
    id: '44444444-4444-4444-8444-444444444404',
    methodCode: 'cheque',
    receiptNo: 'RC-2026-000304',
    recordedBy: STUB_OPERATORS.receiptRecorder.id,
    referenceNo: 'CHQ-DEMO-0001',
    status: 'reconciled',
    transactionDate: '2026-10-18',
    version: 3,
  },
  {
    allocatedAmount: 0,
    amount: 20_000,
    approvedAt: '2026-10-08T02:00:00Z',
    approvedBy: STUB_OPERATORS.financeReviewer.id,
    contractId: STUB_CONTRACTS.ht1.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '44444444-4444-4444-8444-444444444405',
    methodCode: 'bank_transfer',
    receiptNo: 'RC-2026-000305',
    recordedBy: STUB_OPERATORS.receiptRecorder.id,
    recordedReason: '重复登记后冲正（虚构数据）',
    referenceNo: 'TRX-DEMO-0003',
    status: 'reversed',
    transactionDate: '2026-10-08',
    version: 4,
  },
  {
    // 已审核、待核销：核销演示入口
    allocatedAmount: 0,
    amount: 15_000,
    approvedAt: '2026-10-26T07:20:00Z',
    approvedBy: STUB_OPERATORS.financeReviewer.id,
    contractId: STUB_CONTRACTS.ht1.id,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '44444444-4444-4444-8444-444444444406',
    methodCode: 'bank_transfer',
    receiptNo: 'RC-2026-000306',
    recordedBy: STUB_OPERATORS.receiptRecorder.id,
    referenceNo: 'TRX-DEMO-0004',
    status: 'pending_reconcile',
    transactionDate: '2026-10-26',
    version: 2,
  },
];

export interface StubAllocationRow {
  allocatedAt: string;
  allocatedBy: string;
  amount: number;
  currency: string;
  customerId: string;
  id: string;
  receivableId: string;
  receiptId: string;
  reversedAmount: number;
}

export const STUB_ALLOCATIONS: StubAllocationRow[] = [
  {
    allocatedAt: '2026-10-03T02:00:00Z',
    allocatedBy: STUB_OPERATORS.financeReviewer.id,
    amount: 120_000,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '55555555-5555-4555-8555-555555555501',
    receivableId: '33333333-3333-4333-8333-333333333301',
    receiptId: '44444444-4444-4444-8444-444444444401',
    reversedAmount: 0,
  },
  {
    allocatedAt: '2026-10-13T03:00:00Z',
    allocatedBy: STUB_OPERATORS.financeReviewer.id,
    amount: 40_000,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '55555555-5555-4555-8555-555555555502',
    receivableId: '33333333-3333-4333-8333-333333333302',
    receiptId: '44444444-4444-4444-8444-444444444402',
    reversedAmount: 0,
  },
  {
    allocatedAt: '2026-10-19T03:00:00Z',
    allocatedBy: STUB_OPERATORS.settlement.id,
    amount: 30_000,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c2.id,
    id: '55555555-5555-4555-8555-555555555503',
    receivableId: '33333333-3333-4333-8333-333333333305',
    receiptId: '44444444-4444-4444-8444-444444444404',
    reversedAmount: 0,
  },
  {
    // 已全额撤销的核销：撤销不覆盖原流水
    allocatedAt: '2026-10-24T03:00:00Z',
    allocatedBy: STUB_OPERATORS.financeReviewer.id,
    amount: 15_000,
    currency: 'CNY',
    customerId: STUB_CUSTOMERS.c1.id,
    id: '55555555-5555-4555-8555-555555555504',
    receivableId: '33333333-3333-4333-8333-333333333303',
    receiptId: '44444444-4444-4444-8444-444444444406',
    reversedAmount: 15_000,
  },
];

export const STUB_REVERSALS: BillingReversalLine[] = [
  {
    allocationId: '55555555-5555-4555-8555-555555555504',
    amount: 15_000,
    createdAt: '2026-10-25T01:30:00Z',
    createdBy: STUB_OPERATORS.settlement,
    id: '66666666-6666-4666-8666-666666666601',
    reason: '核销对象选错，撤销后重新分配（虚构数据）',
    type: 'allocation_reversal',
  },
  {
    amount: 20_000,
    createdAt: '2026-10-09T02:10:00Z',
    createdBy: STUB_OPERATORS.financeReviewer,
    id: '66666666-6666-4666-8666-666666666602',
    reason: '该笔收款为重复登记，冲正保留原记录（虚构数据）',
    receiptId: '44444444-4444-4444-8444-444444444405',
    type: 'receipt_reversal',
  },
];

/** 展期记录行：带 `receivableId` 便于桩内按应收过滤（响应时会被剥掉）。 */
export interface StubExtensionRow extends ReceivableExtension {
  receivableId: string;
}

export const STUB_EXTENSIONS: StubExtensionRow[] = [
  {
    createdAt: '2026-10-21T06:00:00Z',
    createdBy: STUB_OPERATORS.settlement,
    id: '77777777-7777-4777-8777-777777777701',
    newDueDate: '2026-11-30',
    previousDueDate: '2026-10-31',
    reason: '客户申请顺延一个月，已与客户确认（虚构数据）',
    receivableId: '33333333-3333-4333-8333-333333333302',
  },
];

export const STUB_REFUNDS: Refund[] = [
  {
    amount: 5000,
    approvedBy: null,
    contractId: STUB_CONTRACTS.ht1.id,
    currency: 'CNY',
    customer: STUB_CUSTOMERS.c1,
    externalVoucherRef: 'REFUND-DEMO-0001',
    handledBy: STUB_OPERATORS.receiptRecorder,
    id: '88888888-8888-4888-8888-888888888801',
    reason: '超出实际交付范围，按合同退还差额（虚构数据）',
    receiptId: '44444444-4444-4444-8444-444444444401',
    receiptNo: 'RC-2026-000301',
    refundDate: '2026-10-27',
    refundNo: 'RF-2026-000401',
    status: 'recorded',
  },
  {
    amount: 2000,
    approvedBy: STUB_OPERATORS.financeReviewer,
    contractId: STUB_CONTRACTS.ht2.id,
    currency: 'CNY',
    customer: STUB_CUSTOMERS.c2,
    externalVoucherRef: 'REFUND-DEMO-0002',
    handledBy: STUB_OPERATORS.receiptRecorder,
    id: '88888888-8888-4888-8888-888888888802',
    reason: '服务未开通部分退还（虚构数据）',
    receiptId: '44444444-4444-4444-8444-444444444404',
    receiptNo: 'RC-2026-000304',
    refundDate: '2026-10-22',
    refundNo: 'RF-2026-000402',
    status: 'approved',
  },
];

/** 开发态提示的固定文案（页面与桩共用，避免出现"像真实数据"的措辞）。 */
export const DEV_DATA_NOTICE =
  '开发态数据（全部为虚构客户与虚构金额，未经真实后端集成，不可用于对账或决策）';
