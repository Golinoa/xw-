import { z } from 'zod';

/**
 * billing 域两个文件（`receivables.ts` / `receipts.ts`）共用的三个形状。
 *
 * 单独一个文件是为了不产生循环 import：应收要引用「核销分配」，收款也要引用
 * 「核销分配」，而收款还引用应收（列表项里嵌 `receivable`）。两边互相 import
 * 会在模块初始化阶段碰到未定义的 schema——`z.object` 在顶层求值，报出来的是
 * `undefined is not a ZodType`，与「少写一个字段」看起来一模一样。
 */

/**
 * 操作者引用：`{id, displayName}` 而不是裸 uuid（契约 §5.9 的同一口径）。
 *
 * 列表要直接渲染人名，返回 uuid 会逼前端为每行再查一次 `GET /operators`，
 * 把一次列表请求变成 N+1。审计事件里的 `actor` 已是这个形状，两处保持一致。
 */
export const opsOperatorRefSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
});
export type OpsOperatorRef = z.infer<typeof opsOperatorRefSchema>;

/**
 * 一条核销分配。
 *
 * 同时出现在 `GET /receivables/{id}`（按应收过滤：「这期是谁付的」）与
 * `GET /receipts/{id}`（按收款过滤：「这笔钱抵了哪几期」）里。过滤方向相反，
 * 形状必须相同——否则前端要为同一个列表写两套渲染。
 *
 * `reversedAmount` 是**这条分配**被撤销的部分，不是该期的：一期可能被多笔收款
 * 核销，按分配统计才说得清是哪一笔被撤了。
 */
export const opsBillingAllocationSchema = z.object({
  id: z.uuid(),
  receiptId: z.uuid(),
  receiptNo: z.string(),
  receivableId: z.uuid(),
  periodNo: z.number().int().min(1),
  contractId: z.uuid(),
  dueDate: z.iso.date(),
  amount: z.number(),
  reversedAmount: z.number(),
  allocatedBy: opsOperatorRefSchema.nullable(),
  allocatedAt: z.string(),
});
export type OpsBillingAllocation = z.infer<typeof opsBillingAllocationSchema>;

/**
 * 一条撤销流水（反向记录）。
 *
 * 撤销不覆盖原分配：原分配行永远保留，撤销是另一条正数流水。所以「这笔钱核销
 * 过又被撤销」在数据里是两条记录，而不是一条被改过的记录。
 */
export const opsBillingReversalSchema = z.object({
  id: z.uuid(),
  allocationId: z.uuid(),
  receivableId: z.uuid(),
  amount: z.number(),
  reason: z.string(),
  reversedBy: opsOperatorRefSchema.nullable(),
  createdAt: z.string(),
});
export type OpsBillingReversal = z.infer<typeof opsBillingReversalSchema>;
