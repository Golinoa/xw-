import type {
  StubAllocationRow,
  StubExtensionRow,
  StubReceiptRow,
  StubReceivableRow,
} from './fixtures';
/**
 * 开发态账款契约桩（仅在 `VITE_OPS_MOCK=true` 的非生产构建里被动态加载）。
 *
 * 目的：在 `udone` 的 ops billing API 尚未交付时，页面可以走通全部状态
 * （loading / empty / error / validation / permission / conflict / 冲正），
 * 且**不冒充真实集成**——页面同时展示「开发态数据」提示。
 *
 * 桩刻意复刻服务端的不变量，否则前端会在假的成功里漏掉真实错误分支：
 * - 登记人自审 → 403 `FORBIDDEN` + `SEGREGATION_OF_DUTY`；
 * - 未审核收款核销 → 409 `STATE_CONFLICT` + `RECEIPT_NOT_APPROVED`；
 * - 超额核销 → 409 `RECEIPT_EXCEEDED` / `RECEIVABLE_EXCEEDED`；
 * - 仍有有效核销时冲正 → 409 `HAS_ALLOCATIONS`；
 * - 已结清应收展期 → 409 `RECEIVABLE_SETTLED`；
 * - 乐观锁 `version` 不匹配 → 409 `CONFLICT`。
 */
import type {
  CreateReceiptInput,
  CreateReceiptResult,
  CreateReceivablePlanInput,
  CreateReceivablePlanResult,
  CreateRefundInput,
  CreateRefundResult,
  ExtendReceivableInput,
  ExtendReceivableResult,
  Receipt,
  ReceiptAllocationInput,
  ReceiptAllocationResult,
  ReceiptDetail,
  ReceiptListQuery,
  ReceiptListResult,
  ReceiptTransitionInput,
  ReceiptTransitionResult,
  Receivable,
  ReceivableDetail,
  ReceivableListQuery,
  ReceivableListResult,
  ReceivableStatus,
  RefundListQuery,
  RefundListResult,
  RefundTransitionInput,
  RefundTransitionResult,
  ReverseAllocationInput,
  ReverseAllocationResult,
  ReverseReceiptInput,
  ReverseReceiptResult,
} from './types';

import { OpsApiError, resolveUserMessage } from '#/api/adapter/errors';

import {
  STUB_ALLOCATIONS,
  STUB_CONTRACTS,
  STUB_CURRENT_OPERATOR_ID,
  STUB_CUSTOMERS,
  STUB_EXTENSIONS,
  STUB_OPERATORS,
  STUB_RECEIPTS,
  STUB_RECEIVABLES,
  STUB_REFUNDS,
  STUB_REVERSALS,
} from './fixtures';
import { RECEIPT_METHOD_OPTIONS } from './format';

const STUB_LATENCY_MS = 120;
const DEFAULT_PAGE_SIZE = 15;
const PAGE_SIZE_WHITELIST = new Set([10, 15, 20, 30, 50, 100]);

interface StubState {
  allocations: StubAllocationRow[];
  extensions: StubExtensionRow[];
  receipts: StubReceiptRow[];
  receivables: StubReceivableRow[];
  refunds: typeof STUB_REFUNDS;
  reversals: typeof STUB_REVERSALS;
  sequence: number;
}

function cloneState(): StubState {
  return {
    allocations: STUB_ALLOCATIONS.map((row) => ({ ...row })),
    extensions: STUB_EXTENSIONS.map((row) => ({ ...row })),
    receipts: STUB_RECEIPTS.map((row) => ({ ...row })),
    receivables: STUB_RECEIVABLES.map((row) => ({ ...row })),
    refunds: STUB_REFUNDS.map((row) => ({
      ...row,
      customer: { ...row.customer },
    })),
    reversals: STUB_REVERSALS.map((row) => ({ ...row })),
    sequence: 900,
  };
}
let state: StubState = cloneState();

/** 仅供单测重置桩状态。 */
export function resetStubBillingState(): void {
  state = cloneState();
}

function respond<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), STUB_LATENCY_MS);
  });
}

function fail(options: {
  code: string;
  message?: string;
  reason?: string;
  status: number;
}): never {
  throw new OpsApiError({
    code: options.code,
    details: options.reason ? { reason: options.reason } : undefined,
    kind: 'http',
    reason: options.reason,
    retryable: false,
    status: options.status,
    userMessage:
      options.message ?? resolveUserMessage(options.code, options.reason),
  });
}

/** 运营端业务时区取当天（契约 §2.3：Asia/Shanghai）。 */
function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): number {
  return value / 100;
}

/** 应收状态派生（契约 §3.4 优先级表，与后端同一口径）。 */
export function deriveReceivableStatus(
  row: Pick<
    StubReceivableRow,
    'allocatedAmount' | 'amount' | 'dueDate' | 'reversedAmount'
  >,
): ReceivableStatus {
  const net = cents(row.allocatedAmount) - cents(row.reversedAmount);
  const amount = cents(row.amount);
  const today = todayInShanghai();
  if (row.reversedAmount > 0 && net <= 0) {
    return 'reversed';
  }
  if (net >= amount) {
    return 'paid';
  }
  if (row.dueDate < today) {
    return 'overdue';
  }
  return net > 0 ? 'partial' : 'upcoming';
}

function toReceivable(row: StubReceivableRow): Receivable {
  const customer =
    row.customerId === STUB_CUSTOMERS.c1.id
      ? STUB_CUSTOMERS.c1
      : STUB_CUSTOMERS.c2;
  const net = cents(row.allocatedAmount) - cents(row.reversedAmount);
  return {
    allocatedAmount: row.allocatedAmount,
    amount: row.amount,
    contractId: row.contractId,
    contractNo: row.contractNo,
    currency: row.currency,
    customer: { ...customer },
    dueDate: row.dueDate,
    id: row.id,
    note: row.note,
    outstanding: fromCents(cents(row.amount) - Math.max(net, 0)),
    periodNo: row.periodNo,
    reversedAmount: row.reversedAmount,
    status: deriveReceivableStatus(row),
    version: row.version,
  };
}

function operatorRef(id: null | string | undefined) {
  if (!id) {
    return null;
  }
  const found = Object.values(STUB_OPERATORS).find((item) => item.id === id);
  if (found) {
    return { displayName: found.displayName, id: found.id };
  }
  if (id === STUB_CURRENT_OPERATOR_ID) {
    return { displayName: '开发桩·演示运营（虚构）', id };
  }
  return { id };
}

function toReceipt(row: StubReceiptRow): Receipt {
  const customer =
    row.customerId === STUB_CUSTOMERS.c1.id
      ? STUB_CUSTOMERS.c1
      : STUB_CUSTOMERS.c2;
  const methodOption = RECEIPT_METHOD_OPTIONS.find(
    (item) => item.value === row.methodCode,
  );
  // 用查表替代嵌套三元：可读性与 lint 都更好，新增合同时只加一行。
  const contractNoByContractId = new Map<string, string>([
    [STUB_CONTRACTS.ht1.id, STUB_CONTRACTS.ht1.contractNo],
    [STUB_CONTRACTS.ht2.id, STUB_CONTRACTS.ht2.contractNo],
  ]);
  const contractNo = row.contractId
    ? (contractNoByContractId.get(row.contractId) ?? null)
    : null;
  return {
    allocatedAmount: row.allocatedAmount,
    amount: row.amount,
    approvedAt: row.approvedAt ?? null,
    approvedBy: operatorRef(row.approvedBy),
    contractId: row.contractId ?? null,
    contractNo,
    currency: row.currency,
    customer: { ...customer },
    id: row.id,
    method: {
      code: row.methodCode,
      name: methodOption?.label ?? row.methodCode,
    },
    receiptNo: row.receiptNo,
    recordedBy: operatorRef(row.recordedBy) ?? { id: row.recordedBy },
    recordedReason: row.recordedReason ?? null,
    referenceNo: row.referenceNo ?? null,
    status: row.status,
    transactionDate: row.transactionDate,
    version: row.version,
    voucherRef: row.voucherRef ?? null,
  };
}

function paginate<T>(items: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const size = PAGE_SIZE_WHITELIST.has(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;
  const current = Math.max(1, page);
  return {
    items: items.slice((current - 1) * size, current * size),
    page: current,
    pageSize: size,
    total: items.length,
  };
}

function receivableRowById(id: string): StubReceivableRow {
  const row = state.receivables.find((item) => item.id === id);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

function receiptRowById(id: string): StubReceiptRow {
  const row = state.receipts.find((item) => item.id === id);
  if (!row) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  return row;
}

// ---------------------------------------------------------------- 应收

export async function stubListReceivables(
  query: ReceivableListQuery = {},
): Promise<ReceivableListResult> {
  let rows = [...state.receivables];
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  if (query.contractId) {
    rows = rows.filter((row) => row.contractId === query.contractId);
  }
  if (query.dueFrom) {
    rows = rows.filter((row) => row.dueDate >= (query.dueFrom ?? ''));
  }
  if (query.dueTo) {
    rows = rows.filter((row) => row.dueDate <= (query.dueTo ?? ''));
  }

  let items = rows.map((row) => toReceivable(row));
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    items = items.filter((item) => allowed.has(item.status));
  }
  if (query.overdueOnly) {
    items = items.filter((item) => item.status === 'overdue');
  }

  const sortKey = query.sort === 'amount' ? 'amount' : 'dueDate';
  const direction = query.order === 'asc' ? 1 : -1;
  items = items.toSorted((left, right) => {
    const a = sortKey === 'amount' ? left.amount : left.dueDate;
    const b = sortKey === 'amount' ? right.amount : right.dueDate;
    if (a === b) {
      return 0;
    }
    return a < b ? -direction : direction;
  });

  const summary = {
    overdueAmount: items
      .filter((item) => item.status === 'overdue')
      .reduce((sum, item) => sum + cents(item.outstanding), 0),
    outstandingAmount: items.reduce(
      (sum, item) => sum + cents(item.outstanding),
      0,
    ),
    settledAmount: items.reduce(
      (sum, item) => sum + cents(item.allocatedAmount),
      0,
    ),
    totalAmount: items.reduce((sum, item) => sum + cents(item.amount), 0),
  };

  const paged = paginate(items, query.page, query.pageSize);
  return respond({
    ...paged,
    summary: {
      overdueAmount: fromCents(summary.overdueAmount),
      outstandingAmount: fromCents(summary.outstandingAmount),
      settledAmount: fromCents(summary.settledAmount),
      totalAmount: fromCents(summary.totalAmount),
    },
  });
}

export async function stubGetReceivable(
  receivableId: string,
): Promise<ReceivableDetail> {
  const row = receivableRowById(receivableId);
  const allocations = state.allocations
    .filter((item) => item.receivableId === receivableId)
    .map((item) => {
      const receipt = state.receipts.find(
        (entry) => entry.id === item.receiptId,
      );
      return {
        allocatedAt: item.allocatedAt,
        allocatedBy: operatorRef(item.allocatedBy) ?? { id: item.allocatedBy },
        amount: item.amount,
        id: item.id,
        receiptId: item.receiptId,
        receiptNo: receipt?.receiptNo,
        reversedAmount: item.reversedAmount,
      };
    });
  const allocationIds = new Set(
    state.allocations
      .filter((item) => item.receivableId === receivableId)
      .map((item) => item.id),
  );
  return respond({
    allocations,
    extensions: state.extensions
      .filter((item) => item.receivableId === receivableId)
      .map((item) => ({
        createdAt: item.createdAt,
        createdBy: item.createdBy,
        id: item.id,
        newDueDate: item.newDueDate,
        previousDueDate: item.previousDueDate,
        reason: item.reason,
      })),
    receivable: toReceivable(row),
    reversals: state.reversals.filter(
      (item) =>
        item.allocationId !== undefined && allocationIds.has(item.allocationId),
    ),
  });
}

export async function stubCreateReceivablePlan(
  input: CreateReceivablePlanInput,
): Promise<CreateReceivablePlanResult> {
  if (!Array.isArray(input.periods) || input.periods.length === 0) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '请至少填写一期应收计划',
      status: 400,
    });
  }
  const contract = Object.values(STUB_CONTRACTS).find(
    (item) => item.id === input.contractId,
  );
  if (!contract) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  const customerId =
    contract.id === STUB_CONTRACTS.ht1.id
      ? STUB_CUSTOMERS.c1.id
      : STUB_CUSTOMERS.c2.id;
  const existing = state.receivables.filter(
    (row) => row.contractId === input.contractId,
  );
  const created: Receivable[] = [];
  let periodNo = existing.length;
  for (const period of input.periods) {
    if (!(cents(period.amount) > 0)) {
      fail({
        code: 'VALIDATION_ERROR',
        status: 400,
        message: '金额必须大于 0',
      });
    }
    periodNo += 1;
    state.sequence += 1;
    const row: StubReceivableRow = {
      allocatedAmount: 0,
      amount: period.amount,
      contractId: input.contractId,
      contractNo: contract.contractNo,
      currency: 'CNY',
      customerId,
      dueDate: period.dueDate,
      id: `33333333-3333-4333-8333-${String(state.sequence).padStart(12, '0')}`,
      ...(period.note === undefined ? {} : { note: period.note }),
      periodNo,
      reversedAmount: 0,
      version: 1,
    };
    state.receivables.push(row);
    created.push(toReceivable(row));
  }
  return respond({ items: created });
}

export async function stubExtendReceivable(
  receivableId: string,
  input: ExtendReceivableInput,
): Promise<ExtendReceivableResult> {
  const row = receivableRowById(receivableId);
  const status = deriveReceivableStatus(row);
  if (status === 'paid') {
    fail({
      code: 'STATE_CONFLICT',
      reason: 'RECEIVABLE_SETTLED',
      status: 409,
    });
  }
  if (status === 'reversed') {
    fail({ code: 'STATE_CONFLICT', reason: 'RECEIVABLE_SETTLED', status: 409 });
  }
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  if (!(input.newDueDate > row.dueDate)) {
    fail({
      code: 'VALIDATION_ERROR',
      message: '新到期日必须晚于当前到期日',
      status: 400,
    });
  }
  state.sequence += 1;
  const extension = {
    createdAt: new Date().toISOString(),
    createdBy: operatorRef(STUB_CURRENT_OPERATOR_ID) ?? {
      id: STUB_CURRENT_OPERATOR_ID,
    },
    id: `77777777-7777-4777-8777-${String(state.sequence).padStart(12, '0')}`,
    newDueDate: input.newDueDate,
    previousDueDate: row.dueDate,
    reason: input.reason,
  };
  // 追加展期记录并保留原到期日；应收本体只推进到期日与版本
  row.dueDate = input.newDueDate;
  row.version += 1;
  state.extensions.push({ ...extension, receivableId });
  return respond({ extension, receivable: toReceivable(row) });
}

// ---------------------------------------------------------------- 收款

export async function stubListReceipts(
  query: ReceiptListQuery = {},
): Promise<ReceiptListResult> {
  let rows = [...state.receipts];
  if (query.customerId) {
    rows = rows.filter((row) => row.customerId === query.customerId);
  }
  if (query.contractId) {
    rows = rows.filter((row) => row.contractId === query.contractId);
  }
  if (query.methodCode) {
    rows = rows.filter((row) => row.methodCode === query.methodCode);
  }
  if (query.dateFrom) {
    rows = rows.filter((row) => row.transactionDate >= (query.dateFrom ?? ''));
  }
  if (query.dateTo) {
    rows = rows.filter((row) => row.transactionDate <= (query.dateTo ?? ''));
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    rows = rows.filter((row) => allowed.has(row.status));
  }
  const direction = query.order === 'asc' ? 1 : -1;
  rows = rows.toSorted((left, right) => {
    if (left.transactionDate === right.transactionDate) {
      if (left.receiptNo === right.receiptNo) {
        return 0;
      }
      return left.receiptNo < right.receiptNo ? direction : -direction;
    }
    return left.transactionDate < right.transactionDate
      ? direction
      : -direction;
  });
  const items = rows.map((row) => toReceipt(row));
  return respond(paginate(items, query.page, query.pageSize));
}

export async function stubGetReceipt(
  receiptId: string,
): Promise<ReceiptDetail> {
  const row = receiptRowById(receiptId);
  const allocations = state.allocations
    .filter((item) => item.receiptId === receiptId)
    .map((item) => {
      const receivable = state.receivables.find(
        (entry) => entry.id === item.receivableId,
      );
      return {
        allocatedAt: item.allocatedAt,
        allocatedBy: operatorRef(item.allocatedBy) ?? { id: item.allocatedBy },
        amount: item.amount,
        id: item.id,
        receivableDueDate: receivable?.dueDate,
        receivableId: item.receivableId,
        receivablePeriodNo: receivable?.periodNo,
        reversedAmount: item.reversedAmount,
      };
    });
  const allocationIds = new Set(allocations.map((item) => item.id));
  return respond({
    allocations,
    receipt: toReceipt(row),
    refunds: state.refunds
      .filter((item) => item.receiptId === receiptId)
      .map((item) => ({
        amount: item.amount,
        id: item.id,
        reason: item.reason,
        refundDate: item.refundDate,
        refundNo: item.refundNo,
        status: item.status,
      })),
    reversals: state.reversals.filter(
      (item) =>
        item.receiptId === receiptId ||
        (item.allocationId !== undefined &&
          allocationIds.has(item.allocationId)),
    ),
  });
}

export async function stubCreateReceipt(
  input: CreateReceiptInput,
): Promise<CreateReceiptResult> {
  if (!(cents(input.amount) > 0)) {
    fail({ code: 'VALIDATION_ERROR', status: 400, message: '金额必须大于 0' });
  }
  if (!input.transactionDate) {
    fail({ code: 'VALIDATION_ERROR', status: 400, message: '请填写交易日期' });
  }
  const warnings: string[] = [];
  if (
    input.referenceNo &&
    state.receipts.some((row) => row.referenceNo === input.referenceNo)
  ) {
    warnings.push(
      `流水号 ${input.referenceNo} 已有登记记录，请确认是否为同一笔收款`,
    );
  }
  state.sequence += 1;
  const row: StubReceiptRow = {
    allocatedAmount: 0,
    amount: input.amount,
    approvedAt: null,
    approvedBy: null,
    contractId: input.contractId ?? null,
    currency: input.currency,
    customerId: input.customerId,
    id: `44444444-4444-4444-8444-${String(state.sequence).padStart(12, '0')}`,
    methodCode: input.methodCode,
    receiptNo: `RC-2026-${String(state.sequence).padStart(6, '0')}`,
    recordedBy: STUB_CURRENT_OPERATOR_ID,
    recordedReason: null,
    referenceNo: input.referenceNo ?? null,
    status: 'recorded',
    transactionDate: input.transactionDate,
    version: 1,
    voucherRef: input.voucherRef ?? null,
  };
  state.receipts.unshift(row);
  return respond({ duplicateWarnings: warnings, receipt: toReceipt(row) });
}

export async function stubTransitionReceipt(
  receiptId: string,
  input: ReceiptTransitionInput,
): Promise<ReceiptTransitionResult> {
  const row = receiptRowById(receiptId);
  if (row.status !== 'recorded') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (
    input.action === 'approve' &&
    row.recordedBy === STUB_CURRENT_OPERATOR_ID
  ) {
    fail({ code: 'FORBIDDEN', reason: 'SEGREGATION_OF_DUTY', status: 403 });
  }
  if (input.version !== row.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  if (input.action === 'approve') {
    row.approvedAt = new Date().toISOString();
    row.approvedBy = STUB_CURRENT_OPERATOR_ID;
    row.status = 'pending_reconcile';
  }
  row.version += 1;
  return respond({ receipt: toReceipt(row) });
}

export async function stubAllocateReceipt(
  receiptId: string,
  input: ReceiptAllocationInput,
): Promise<ReceiptAllocationResult> {
  const receipt = receiptRowById(receiptId);
  if (receipt.status === 'recorded') {
    fail({
      code: 'STATE_CONFLICT',
      reason: 'RECEIPT_NOT_APPROVED',
      status: 409,
    });
  }
  if (receipt.status === 'reversed' || receipt.status === 'refunded') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.version !== undefined && input.version !== receipt.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }

  const totalCents = input.allocations.reduce(
    (sum, item) => sum + cents(item.amount),
    0,
  );
  const allocatable = cents(receipt.amount) - cents(receipt.allocatedAmount);
  if (totalCents > allocatable) {
    fail({ code: 'STATE_CONFLICT', reason: 'RECEIPT_EXCEEDED', status: 409 });
  }

  const pending: StubAllocationRow[] = [];
  for (const item of input.allocations) {
    const receivable = receivableRowById(item.receivableId);
    if (receivable.customerId !== receipt.customerId) {
      fail({
        code: 'VALIDATION_ERROR',
        reason: 'CUSTOMER_MISMATCH',
        status: 400,
      });
    }
    if (receivable.currency !== receipt.currency) {
      fail({
        code: 'VALIDATION_ERROR',
        reason: 'CURRENCY_MISMATCH',
        status: 400,
      });
    }
    const net =
      cents(receivable.allocatedAmount) - cents(receivable.reversedAmount);
    const outstanding = cents(receivable.amount) - Math.max(net, 0);
    if (cents(item.amount) > outstanding) {
      fail({
        code: 'STATE_CONFLICT',
        reason: 'RECEIVABLE_EXCEEDED',
        status: 409,
      });
    }
    state.sequence += 1;
    pending.push({
      allocatedAt: new Date().toISOString(),
      allocatedBy: STUB_CURRENT_OPERATOR_ID,
      amount: item.amount,
      currency: receipt.currency,
      customerId: receipt.customerId,
      id: `55555555-5555-4555-8555-${String(state.sequence).padStart(12, '0')}`,
      receivableId: item.receivableId,
      receiptId,
      reversedAmount: 0,
    });
  }

  for (const row of pending) {
    state.allocations.push(row);
    const receivable = receivableRowById(row.receivableId);
    receivable.allocatedAmount = fromCents(
      cents(receivable.allocatedAmount) + cents(row.amount),
    );
    receivable.version += 1;
  }
  receipt.allocatedAmount = fromCents(
    cents(receipt.allocatedAmount) + totalCents,
  );
  receipt.status = 'reconciled';
  receipt.version += 1;

  const detail = await stubGetReceipt(receiptId);
  return respond({
    allocations: detail.allocations,
    receivablesSummary: pending.map((row) => {
      const receivable = toReceivable(receivableRowById(row.receivableId));
      return {
        allocatedAmount: receivable.allocatedAmount,
        id: receivable.id,
        outstanding: receivable.outstanding,
        periodNo: receivable.periodNo,
      };
    }),
    receipt: detail.receipt,
  });
}

export async function stubReverseReceipt(
  receiptId: string,
  input: ReverseReceiptInput,
): Promise<ReverseReceiptResult> {
  const receipt = receiptRowById(receiptId);
  const active = state.allocations.filter(
    (item) => item.receiptId === receiptId && item.reversedAmount < item.amount,
  );
  if (active.length > 0) {
    fail({ code: 'STATE_CONFLICT', reason: 'HAS_ALLOCATIONS', status: 409 });
  }
  if (receipt.status === 'reversed') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  if (input.version !== receipt.version) {
    fail({ code: 'CONFLICT', status: 409 });
  }
  state.sequence += 1;
  state.reversals.push({
    amount: receipt.amount,
    createdAt: new Date().toISOString(),
    createdBy: operatorRef(STUB_CURRENT_OPERATOR_ID) ?? {
      id: STUB_CURRENT_OPERATOR_ID,
    },
    id: `66666666-6666-4666-8666-${String(state.sequence).padStart(12, '0')}`,
    reason: input.reason,
    receiptId,
    type: 'receipt_reversal',
  });
  receipt.status = 'reversed';
  receipt.version += 1;
  return respond({
    receipt: toReceipt(receipt),
    reversal: { amount: receipt.amount },
  });
}

export async function stubReverseAllocation(
  allocationId: string,
  input: ReverseAllocationInput,
): Promise<ReverseAllocationResult> {
  const allocation = state.allocations.find((item) => item.id === allocationId);
  if (!allocation) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  const remaining = cents(allocation.amount) - cents(allocation.reversedAmount);
  if (cents(input.amount) > remaining) {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  state.sequence += 1;
  state.reversals.push({
    allocationId,
    amount: input.amount,
    createdAt: new Date().toISOString(),
    createdBy: operatorRef(STUB_CURRENT_OPERATOR_ID) ?? {
      id: STUB_CURRENT_OPERATOR_ID,
    },
    id: `66666666-6666-4666-8666-${String(state.sequence).padStart(12, '0')}`,
    reason: input.reason,
    type: 'allocation_reversal',
  });
  allocation.reversedAmount = fromCents(
    cents(allocation.reversedAmount) + cents(input.amount),
  );

  const receivable = receivableRowById(allocation.receivableId);
  receivable.reversedAmount = fromCents(
    cents(receivable.reversedAmount) + cents(input.amount),
  );
  receivable.version += 1;

  const receipt = receiptRowById(allocation.receiptId);
  receipt.allocatedAmount = fromCents(
    Math.max(0, cents(receipt.allocatedAmount) - cents(input.amount)),
  );
  const stillAllocated = state.allocations.some(
    (item) =>
      item.receiptId === allocation.receiptId &&
      item.reversedAmount < item.amount,
  );
  if (!stillAllocated && receipt.status === 'reconciled') {
    receipt.status = 'pending_reconcile';
  }
  receipt.version += 1;

  return respond({
    allocation: {
      allocatedAt: allocation.allocatedAt,
      allocatedBy: operatorRef(allocation.allocatedBy) ?? {
        id: allocation.allocatedBy,
      },
      amount: allocation.amount,
      id: allocation.id,
      receivableId: allocation.receivableId,
      reversedAmount: allocation.reversedAmount,
    },
    receivable: toReceivable(receivable),
  });
}

// ---------------------------------------------------------------- 退款

export async function stubListRefunds(
  query: RefundListQuery = {},
): Promise<RefundListResult> {
  let items = [...state.refunds];
  if (query.customerId) {
    items = items.filter((item) => item.customer.id === query.customerId);
  }
  if (query.dateFrom) {
    items = items.filter((item) => item.refundDate >= (query.dateFrom ?? ''));
  }
  if (query.dateTo) {
    items = items.filter((item) => item.refundDate <= (query.dateTo ?? ''));
  }
  if (query.status && query.status.length > 0) {
    const allowed = new Set<string>(query.status);
    items = items.filter((item) => allowed.has(item.status));
  }
  items = items.toSorted((left, right) =>
    left.refundDate < right.refundDate ? 1 : -1,
  );
  return respond(paginate(items, query.page, query.pageSize));
}

export async function stubCreateRefund(
  input: CreateRefundInput,
): Promise<CreateRefundResult> {
  const receipt = receiptRowById(input.receiptId);
  const refundable =
    cents(receipt.allocatedAmount) -
    state.refunds
      .filter(
        (item) =>
          item.receiptId === input.receiptId && item.status !== 'cancelled',
      )
      .reduce((sum, item) => sum + cents(item.amount), 0);
  if (cents(input.amount) > refundable) {
    fail({ code: 'STATE_CONFLICT', reason: 'REFUND_EXCEEDED', status: 409 });
  }
  state.sequence += 1;
  const refund = {
    amount: input.amount,
    approvedBy: null,
    contractId: input.contractId ?? receipt.contractId ?? null,
    currency: receipt.currency,
    customer:
      receipt.customerId === STUB_CUSTOMERS.c1.id
        ? { ...STUB_CUSTOMERS.c1 }
        : { ...STUB_CUSTOMERS.c2 },
    externalVoucherRef: input.externalVoucherRef ?? null,
    handledBy: operatorRef(STUB_CURRENT_OPERATOR_ID) ?? {
      id: STUB_CURRENT_OPERATOR_ID,
    },
    id: `88888888-8888-4888-8888-${String(state.sequence).padStart(12, '0')}`,
    reason: input.reason,
    receiptId: input.receiptId,
    receiptNo: receipt.receiptNo,
    refundDate: input.refundDate,
    refundNo: `RF-2026-${String(state.sequence).padStart(6, '0')}`,
    status: 'recorded' as const,
  };
  state.refunds.unshift(refund);
  return respond({ refund });
}

export async function stubTransitionRefund(
  refundId: string,
  input: RefundTransitionInput,
): Promise<RefundTransitionResult> {
  const refund = state.refunds.find((item) => item.id === refundId);
  if (!refund) {
    fail({ code: 'NOT_FOUND', status: 404 });
  }
  if (refund.status !== 'recorded') {
    fail({ code: 'STATE_CONFLICT', status: 409 });
  }
  const receipt = receiptRowById(refund.receiptId);
  if (input.action === 'approve') {
    refund.status = 'approved';
    refund.approvedBy = operatorRef(STUB_CURRENT_OPERATOR_ID) ?? {
      id: STUB_CURRENT_OPERATOR_ID,
    };
    const totalApproved = state.refunds
      .filter(
        (item) =>
          item.receiptId === refund.receiptId && item.status === 'approved',
      )
      .reduce((sum, item) => sum + cents(item.amount), 0);
    if (totalApproved >= cents(receipt.amount)) {
      receipt.status = 'refunded';
      receipt.version += 1;
    }
  } else {
    refund.status = 'cancelled';
  }
  return respond({ receipt: toReceipt(receipt), refund });
}
