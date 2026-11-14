/**
 * 收款、审核、核销、冲正 API（契约 §5.5）。
 *
 * 状态机提醒（契约 §3.4）：
 * `recorded` --approve(receipt.approve, 登记人≠审核人)--> `pending_reconcile`
 * `pending_reconcile` --首次核销(receipt.reconcile)--> `reconciled` --全额退款--> `refunded`
 * 任一态 --reverse(receipt.reverse, 无有效核销)--> `reversed`
 * 未审核的收款**不计入实收**，所以核销前置条件是已审核。
 */
import type {
  CreateReceiptInput,
  CreateReceiptResult,
  ReceiptAllocationInput,
  ReceiptAllocationResult,
  ReceiptDetail,
  ReceiptListQuery,
  ReceiptListResult,
  ReceiptTransitionInput,
  ReceiptTransitionResult,
  ReverseAllocationInput,
  ReverseAllocationResult,
  ReverseReceiptInput,
  ReverseReceiptResult,
} from './types';

import {
  BILLING_ENDPOINTS,
  buildListParams,
  createIdempotencyKey,
  requestClient,
  writeConfig,
} from './endpoints';

/** 收款列表（服务端分页/筛选）。 */
export async function fetchReceipts(
  query: ReceiptListQuery = {},
): Promise<ReceiptListResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubListReceipts } = await import('./dev-stub');
    return stubListReceipts(query);
  }
  return requestClient.get<ReceiptListResult>(BILLING_ENDPOINTS.receipts, {
    params: buildListParams(query),
  });
}

/** 收款详情：含核销分配、冲正流水、关联退款（冲正/退款是新增流水，不改原记录）。 */
export async function fetchReceipt(receiptId: string): Promise<ReceiptDetail> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubGetReceipt } = await import('./dev-stub');
    return stubGetReceipt(receiptId);
  }
  return requestClient.get<ReceiptDetail>(BILLING_ENDPOINTS.receipt(receiptId));
}

/** 登记线下收款（分次收款：同一客户可多次登记）。 */
export async function createReceipt(
  input: CreateReceiptInput,
): Promise<CreateReceiptResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubCreateReceipt } = await import('./dev-stub');
    return stubCreateReceipt(input);
  }
  return requestClient.post<CreateReceiptResult>(
    BILLING_ENDPOINTS.receipts,
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 审核/驳回收款。高风险动作：必须 `reason`、必须 `version`、必须登记人以外的人执行。 */
export async function transitionReceipt(
  receiptId: string,
  input: ReceiptTransitionInput,
): Promise<ReceiptTransitionResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubTransitionReceipt } = await import('./dev-stub');
    return stubTransitionReceipt(receiptId, input);
  }
  return requestClient.post<ReceiptTransitionResult>(
    BILLING_ENDPOINTS.receiptTransition(receiptId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 核销：把（已审核的）收款分配到一条或多条应收，支持跨应收分配。 */
export async function allocateReceipt(
  receiptId: string,
  input: ReceiptAllocationInput,
): Promise<ReceiptAllocationResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubAllocateReceipt } = await import('./dev-stub');
    return stubAllocateReceipt(receiptId, input);
  }
  return requestClient.post<ReceiptAllocationResult>(
    BILLING_ENDPOINTS.receiptAllocations(receiptId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/**
 * 收款冲正：生成反向流水，原收款记录保留（状态变 `reversed`，金额不改写）。
 * 仍有有效核销时服务端返回 409 `HAS_ALLOCATIONS`。
 */
export async function reverseReceipt(
  receiptId: string,
  input: ReverseReceiptInput,
): Promise<ReverseReceiptResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubReverseReceipt } = await import('./dev-stub');
    return stubReverseReceipt(receiptId, input);
  }
  return requestClient.post<ReverseReceiptResult>(
    BILLING_ENDPOINTS.receiptReverse(receiptId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}

/** 撤销核销：只追加反向流水并回滚应收已核销额，不删除原核销记录。 */
export async function reverseAllocation(
  allocationId: string,
  input: ReverseAllocationInput,
): Promise<ReverseAllocationResult> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubReverseAllocation } = await import('./dev-stub');
    return stubReverseAllocation(allocationId, input);
  }
  return requestClient.post<ReverseAllocationResult>(
    BILLING_ENDPOINTS.allocationReverse(allocationId),
    input,
    writeConfig(createIdempotencyKey()),
  );
}
