import {
  z,
  type OpsReceipt,
  type OpsReceiptDuplicateWarning,
  type OpsRefund,
} from '@erp/contracts';
import {
  billingAllocationRowSchema,
  billingReversalRowSchema,
  operatorRefRowSchema,
  receivableCustomerRowSchema,
} from '../receivables/protocol';
import { receivableRowSchema } from '../receivables/protocol';

/**
 * 收款域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 三个 schema 从 `../receivables/protocol` 借来：核销分配与撤销流水同时出现在
 * 应收详情和收款详情里，两个模块各写一份就会各漂各的。借用的方向固定为
 * 「收款 → 应收」，反过来会成环。
 *
 * 金额一律 `z.number()`：`numeric(14,2)` 经 jsonb 出来就是 JSON number。写成
 * `z.number()` 是为了让「哪天数据层改成 to_char 返回字符串」当场 503，而不是
 * 让前端 `Number("1,200.00")` 得到 NaN 再回来查。
 */

export const receiptCustomerRowSchema = receivableCustomerRowSchema;

export const receiptMethodRowSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
});

export const receiptRowSchema = z.object({
  id: z.string().min(1),
  receipt_no: z.string().min(1),
  customer_id: z.string().min(1),
  customer: receiptCustomerRowSchema,
  contract_id: z.string().nullable(),
  contract_no: z.string().nullable(),
  transaction_date: z.string().min(1),
  amount: z.number(),
  currency: z.string().min(1),
  method: receiptMethodRowSchema,
  reference_no: z.string().nullable(),
  voucher_ref: z.string().nullable(),
  status: z.enum(['recorded', 'pending_reconcile', 'reconciled', 'reversed', 'refunded']),
  allocated_amount: z.number(),
  refundable_amount: z.number(),
  recorded_by: operatorRefRowSchema.nullable(),
  approved_by: operatorRefRowSchema.nullable(),
  approved_at: z.string().nullable(),
  recorded_reason: z.string(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const refundRowSchema = z.object({
  id: z.string().min(1),
  refund_no: z.string().min(1),
  receipt_id: z.string().min(1),
  receipt_no: z.string().min(1),
  contract_id: z.string().nullable(),
  customer_id: z.string().min(1),
  customer: receiptCustomerRowSchema,
  amount: z.number(),
  currency: z.string().min(1),
  refund_date: z.string().min(1),
  reason: z.string(),
  external_voucher_ref: z.string().nullable(),
  status: z.enum(['recorded', 'approved', 'cancelled']),
  handled_by: operatorRefRowSchema.nullable(),
  approved_by: operatorRefRowSchema.nullable(),
  approved_at: z.string().nullable(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

/** 重复流水号提示的条目。只有「仅流水号相同」才会出现在这里。 */
export const duplicateWarningRowSchema = z.object({
  receipt_id: z.string().min(1),
  receipt_no: z.string().min(1),
  transaction_date: z.string().min(1),
  amount: z.number(),
  status: z.enum(['recorded', 'pending_reconcile', 'reconciled', 'reversed', 'refunded']),
});

export const receiptListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(receiptRowSchema),
  total: z.number().int().min(0),
});

export const refundListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(refundRowSchema),
  total: z.number().int().min(0),
});

/**
 * 登记收款的信封。
 *
 * `duplicate_reference` 单列一档：它不是 400 级输入错误，而是 409——同一笔钱
 * 已经在这本账上了。与 `duplicate_warnings` 的区别在于「同不同一笔」：
 * 同客户 + 同流水号 + 同金额 + 同日期才算同一笔。
 */
export const receiptCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receipt: receiptRowSchema,
    duplicate_warnings: z.array(duplicateWarningRowSchema),
  }),
  z.object({ status: z.literal('customer_not_found') }),
  z.object({ status: z.literal('contract_not_found') }),
  z.object({ status: z.literal('customer_mismatch'), contract_customer_id: z.string() }),
  z.object({ status: z.literal('currency_mismatch'), contract_currency: z.string() }),
  z.object({ status: z.literal('currency_invalid') }),
  z.object({ status: z.literal('amount_invalid') }),
  z.object({ status: z.literal('amount_scale_invalid') }),
  z.object({ status: z.literal('transaction_date_required') }),
  z.object({ status: z.literal('method_required') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('duplicate_reference') }),
]);

export const receiptDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receipt: receiptRowSchema,
    allocations: z.array(billingAllocationRowSchema),
    reversals: z.array(billingReversalRowSchema),
    refunds: z.array(refundRowSchema),
  }),
  z.object({ status: z.literal('receipt_not_found') }),
]);

export const receiptTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), receipt: receiptRowSchema }),
  z.object({ status: z.literal('receipt_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('invalid_action'), allowed_actions: z.array(z.string()) }),
  // 职责分离单独一档：它不是「状态不允许」，是「人不允许」——换个人点同一个
  // 按钮就成功了，所以路由要把它映射成 403 而不是 409。
  z.object({ status: z.literal('segregation_of_duty') }),
  z.object({ status: z.literal('reason_required') }),
]);

/**
 * 核销信封。
 *
 * 六种拒绝各自带定位信息，不做成一句「核销失败」：
 * `index` 指出是第几条分配错了，`allocatable` / `outstanding` 给出真实上限。
 * 少了任何一个，用户只能拿计算器自己减。
 */
export const receiptAllocationCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receipt: receiptRowSchema,
    receivables_summary: z.array(receivableRowSchema),
  }),
  z.object({ status: z.literal('receipt_not_found') }),
  z.object({
    status: z.literal('receipt_not_approved'),
    allowed_actions: z.array(z.string()),
  }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('allocations_required') }),
  z.object({ status: z.literal('allocation_invalid'), index: z.number().int().min(1) }),
  z.object({
    status: z.literal('amount_scale_invalid'),
    index: z.number().int().min(1),
  }),
  z.object({
    status: z.literal('duplicate_receivable'),
    index: z.number().int().min(1),
    receivable_id: z.string(),
  }),
  z.object({
    status: z.literal('receipt_exceeded'),
    requested_total: z.number(),
    allocatable: z.number(),
  }),
  z.object({ status: z.literal('receivable_not_found') }),
  z.object({
    status: z.literal('customer_mismatch'),
    index: z.number().int().min(1),
    receivable_id: z.string(),
  }),
  z.object({
    status: z.literal('currency_mismatch'),
    index: z.number().int().min(1),
    receivable_id: z.string(),
    receivable_currency: z.string(),
  }),
  z.object({
    status: z.literal('receivable_exceeded'),
    index: z.number().int().min(1),
    receivable_id: z.string(),
    outstanding: z.number(),
  }),
]);

export const receiptReverseEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receipt: receiptRowSchema,
    reversal: z.object({ amount: z.number() }),
  }),
  z.object({ status: z.literal('receipt_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('reason_required') }),
  z.object({
    status: z.literal('has_allocations'),
    allocated_amount: z.number(),
  }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
]);

export const receiptAllocationReverseEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    allocation: z.object({
      id: z.string().min(1),
      amount: z.number(),
      reversed_amount: z.number(),
    }),
    receivable: receivableRowSchema,
    receipt: receiptRowSchema,
  }),
  z.object({ status: z.literal('allocation_not_found') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({ status: z.literal('amount_invalid'), reversible: z.number() }),
  z.object({ status: z.literal('amount_scale_invalid') }),
  z.object({ status: z.literal('reversal_exceeded'), reversible: z.number() }),
]);

export const refundCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), refund: refundRowSchema }),
  z.object({ status: z.literal('receipt_not_found') }),
  z.object({ status: z.literal('amount_invalid') }),
  z.object({ status: z.literal('amount_scale_invalid') }),
  z.object({ status: z.literal('refund_date_required') }),
  z.object({ status: z.literal('reason_required') }),
  z.object({
    status: z.literal('refund_exceeded'),
    requested_amount: z.number(),
    refundable: z.number(),
  }),
]);

export const refundTransitionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    refund: refundRowSchema,
    receipt: receiptRowSchema,
  }),
  z.object({ status: z.literal('refund_not_found') }),
  z.object({ status: z.literal('invalid_action'), allowed_actions: z.array(z.string()) }),
  z.object({
    status: z.literal('invalid_transition'),
    current_status: z.string(),
    allowed_actions: z.array(z.string()),
  }),
  z.object({ status: z.literal('reason_required') }),
]);

type ReceiptRow = z.output<typeof receiptRowSchema>;
type RefundRow = z.output<typeof refundRowSchema>;
type OperatorRefRow = z.output<typeof operatorRefRowSchema>;

function toOperatorRef(row: OperatorRefRow | null) {
  return row ? { id: row.id, displayName: row.display_name } : null;
}

export function toReceipt(row: ReceiptRow): OpsReceipt {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    customerId: row.customer_id,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    contractId: row.contract_id,
    contractNo: row.contract_no,
    transactionDate: row.transaction_date,
    amount: row.amount,
    currency: row.currency,
    method: { code: row.method.code, label: row.method.label },
    referenceNo: row.reference_no,
    voucherRef: row.voucher_ref,
    status: row.status,
    allocatedAmount: row.allocated_amount,
    refundableAmount: row.refundable_amount,
    recordedBy: toOperatorRef(row.recorded_by),
    approvedBy: toOperatorRef(row.approved_by),
    approvedAt: row.approved_at,
    recordedReason: row.recorded_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRefund(row: RefundRow): OpsRefund {
  return {
    id: row.id,
    refundNo: row.refund_no,
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    contractId: row.contract_id,
    customerId: row.customer_id,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    amount: row.amount,
    currency: row.currency,
    refundDate: row.refund_date,
    reason: row.reason,
    externalVoucherRef: row.external_voucher_ref,
    status: row.status,
    handledBy: toOperatorRef(row.handled_by),
    approvedBy: toOperatorRef(row.approved_by),
    approvedAt: row.approved_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toDuplicateWarning(
  row: z.output<typeof duplicateWarningRowSchema>,
): OpsReceiptDuplicateWarning {
  return {
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    transactionDate: row.transaction_date,
    amount: row.amount,
    status: row.status,
  };
}
