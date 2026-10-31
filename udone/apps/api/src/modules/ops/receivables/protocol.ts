import {
  z,
  type OpsBillingAllocation,
  type OpsBillingReversal,
  type OpsReceivable,
  type OpsReceivableExtension,
} from '@erp/contracts';

/**
 * billing 域 RPC 返回值（snake_case）与出口形状（camelCase）之间的一层。
 *
 * 与其它域同构：库里 `jsonb_build_object('due_date', …)` 出来是 snake_case，
 * 出站一律 camelCase。不做 `as` 断言——列改名会变成前端 `undefined`，而有 zod
 * 校验时同样的漂移是 `ops_rpc_shape_invalid` + RPC 名 + 字段路径，一次就能定位。
 *
 * **金额是 number**：`numeric(14,2)` 经 jsonb 出来就是 JSON number。写成
 * `z.number()` 是为了让「哪天数据层改成 to_char 返回字符串」当场 503，而不是让
 * 前端 `Number("1,200.00")` 得到 NaN 之后再回来查。
 */
export const receivableCustomerRowSchema = z.object({
  id: z.string().min(1),
  customer_no: z.string().min(1),
  name: z.string().min(1),
});

export const receivableRowSchema = z.object({
  id: z.string().min(1),
  contract_id: z.string().min(1),
  contract_no: z.string().min(1),
  customer_id: z.string().min(1),
  customer: receivableCustomerRowSchema,
  period_no: z.number().int().min(1),
  due_date: z.string().min(1),
  amount: z.number(),
  currency: z.string().min(1),
  allocated_amount: z.number(),
  reversed_amount: z.number(),
  outstanding: z.number(),
  status: z.enum(['reversed', 'paid', 'overdue', 'partial', 'upcoming']),
  note: z.string().nullable().optional(),
  version: z.number().int().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export const receivableExtensionRowSchema = z.object({
  id: z.string().min(1),
  previous_due_date: z.string().min(1),
  new_due_date: z.string().min(1),
  reason: z.string().min(1),
  created_by: z.string().nullable().optional(),
  created_at: z.string().min(1),
});

/**
 * 核销分配 / 撤销流水：**billing 域两个模块共用**，所以放在这里而不是
 * `receipts/protocol.ts`。
 *
 * `apps/api/src/modules/ops/receipts/protocol.ts` 会 import 这三个 schema。
 * 反向（这里 import 收款模块）不行：会形成模块环，而环在 ESM 里报出来的是
 * 「用到时还是 undefined」，与「字段名写错」长得一样。
 *
 * 键名与库里一致（snake_case），出站由 `toBillingAllocation` 转 camelCase。
 */
export const operatorRefRowSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
});

export const billingAllocationRowSchema = z.object({
  id: z.string().min(1),
  receipt_id: z.string().min(1),
  receipt_no: z.string().min(1),
  receivable_id: z.string().min(1),
  period_no: z.number().int().min(1),
  contract_id: z.string().min(1),
  due_date: z.string().min(1),
  amount: z.number(),
  reversed_amount: z.number(),
  allocated_by: operatorRefRowSchema.nullable(),
  allocated_at: z.string().min(1),
});

export const billingReversalRowSchema = z.object({
  id: z.string().min(1),
  allocation_id: z.string().min(1),
  receivable_id: z.string().min(1),
  amount: z.number(),
  reason: z.string().min(1),
  reversed_by: operatorRefRowSchema.nullable(),
  created_at: z.string().min(1),
});

export const receivableSummaryEnvelopeSchema = z.object({
  total_amount: z.number(),
  settled_amount: z.number(),
  outstanding_amount: z.number(),
  overdue_amount: z.number(),
});

export const receivableListEnvelopeSchema = z.object({
  status: z.literal('ok'),
  items: z.array(receivableRowSchema),
  total: z.number().int().min(0),
  summary: receivableSummaryEnvelopeSchema,
});

/**
 * 生成计划的信封。
 *
 * 每个失败分支都带一个能直接渲染的定位信息（`period_no` / 两个合计），而不是
 * 只给一个字符串：应收计划的错误几乎都出在某一期，而「第几期错了」正是录入人
 * 唯一需要的线索；合计不符时不给两个数，用户只能自己再算一遍。
 */
export const receivablePlanCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), items: z.array(receivableRowSchema) }),
  z.object({ status: z.literal('contract_not_found') }),
  z.object({ status: z.literal('contract_not_active'), contract_status: z.string() }),
  z.object({ status: z.literal('periods_required') }),
  z.object({ status: z.literal('plan_exists') }),
  z.object({ status: z.literal('due_date_required'), period_no: z.number().int().min(1) }),
  z.object({ status: z.literal('amount_invalid'), period_no: z.number().int().min(1) }),
  z.object({ status: z.literal('amount_scale_invalid'), period_no: z.number().int().min(1) }),
  z.object({
    status: z.literal('plan_total_mismatch'),
    planned_total: z.number(),
    contract_total: z.number(),
  }),
]);

export const receivableDetailEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receivable: receivableRowSchema,
    allocations: z.array(billingAllocationRowSchema),
    extensions: z.array(receivableExtensionRowSchema),
    reversals: z.array(billingReversalRowSchema),
  }),
  z.object({ status: z.literal('receivable_not_found') }),
]);

export const receivableExtensionCreateEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    receivable: receivableRowSchema,
    extension: receivableExtensionRowSchema,
  }),
  z.object({ status: z.literal('receivable_not_found') }),
  z.object({ status: z.literal('version_mismatch'), current_version: z.number().int() }),
  z.object({ status: z.literal('reason_required') }),
  z.object({
    status: z.literal('receivable_settled'),
    allocated_amount: z.number(),
    reversed_amount: z.number(),
  }),
  z.object({ status: z.literal('invalid_due_date'), current_due_date: z.string() }),
]);

type ReceivableRow = z.output<typeof receivableRowSchema>;

export function toReceivable(row: ReceivableRow): OpsReceivable {
  return {
    id: row.id,
    contractId: row.contract_id,
    contractNo: row.contract_no,
    customerId: row.customer_id,
    customer: {
      id: row.customer.id,
      customerNo: row.customer.customer_no,
      name: row.customer.name,
    },
    periodNo: row.period_no,
    dueDate: row.due_date,
    amount: row.amount,
    currency: row.currency,
    allocatedAmount: row.allocated_amount,
    reversedAmount: row.reversed_amount,
    outstanding: row.outstanding,
    status: row.status,
    note: row.note ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toReceivableExtension(
  row: z.output<typeof receivableExtensionRowSchema>,
): OpsReceivableExtension {
  return {
    id: row.id,
    previousDueDate: row.previous_due_date,
    newDueDate: row.new_due_date,
    reason: row.reason,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  };
}

export function toBillingAllocation(
  row: z.output<typeof billingAllocationRowSchema>,
): OpsBillingAllocation {
  return {
    id: row.id,
    receiptId: row.receipt_id,
    receiptNo: row.receipt_no,
    receivableId: row.receivable_id,
    periodNo: row.period_no,
    contractId: row.contract_id,
    dueDate: row.due_date,
    amount: row.amount,
    reversedAmount: row.reversed_amount,
    allocatedBy: row.allocated_by
      ? { id: row.allocated_by.id, displayName: row.allocated_by.display_name }
      : null,
    allocatedAt: row.allocated_at,
  };
}

export function toBillingReversal(
  row: z.output<typeof billingReversalRowSchema>,
): OpsBillingReversal {
  return {
    id: row.id,
    allocationId: row.allocation_id,
    receivableId: row.receivable_id,
    amount: row.amount,
    reason: row.reason,
    reversedBy: row.reversed_by
      ? { id: row.reversed_by.id, displayName: row.reversed_by.display_name }
      : null,
    createdAt: row.created_at,
  };
}
