/**
 * 账款域类型（billing）。
 *
 * 真源：`Docs/ops-api-contract.md` §3.4（数据模型/状态机）与 §5.5（端点）。
 * 规则：
 * 1. 字段名严格照抄契约，不得自行改名或造同义字段；
 * 2. 契约未给出的形态（如 `recordedBy` 是 id 还是对象）在下方显式标注「待确认」，
 *    并由归一化函数（`actorId` / `methodLabel`）同时兼容两种形态，避免后端定稿后整页返工；
 * 3. 金额一律 `number`（2 位小数），**不允许**在类型层出现字符串金额。
 */

/**
 * 应收状态（派生值，契约 §3.4）。
 * `unpaid` 为保留值，v1 不返回（契约 §11 U-02）；前端仍需能渲染，避免未知枚举炸页。
 */
export type ReceivableStatus =
  | 'overdue'
  | 'paid'
  | 'partial'
  | 'reversed'
  | 'unpaid'
  | 'upcoming';

/** 收款状态（契约 §3.4 状态机）。 */
export type ReceiptStatus =
  | 'pending_reconcile'
  | 'reconciled'
  | 'recorded'
  | 'refunded'
  | 'reversed';

/** 退款状态：契约 §11 U-03 采用 `recorded → approved / cancelled`。 */
export type RefundStatus = 'approved' | 'cancelled' | 'recorded';

/**
 * 操作者引用。
 *
 * 待确认：契约 §5.5 的 `recordedBy` / `approvedBy` / `allocatedBy` 未给出形态，
 * 表格列是 `uuid`，但「账款明细」要求展示操作者姓名，故两种形态都要能渲染。
 */
export type OpsActorRef = string | { displayName?: string; id: string };

/**
 * 收款方式引用。
 *
 * 待确认：契约响应字段为 `method`（过滤字段是 `methodCode`），未给出结构；
 * 兼容「代码字符串」与「{code,name}」两种形态。
 */
export type BillingMethodRef = string | { code: string; name?: string };

/** 客户引用（列表/详情内嵌，契约写 `customer{...}`）。 */
export interface BillingCustomerRef {
  customerNo?: string;
  id: string;
  name: string;
}

/** 分页查询公共参数（契约 §2.4）。 */
export interface OpsListQuery {
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  sort?: string;
}

/** 分页响应公共形态（契约 §2.4）。 */
export interface OpsPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ---------------------------------------------------------------- 应收

/** 应收条目（列表条目与详情主体共用契约字段）。 */
export interface Receivable {
  /** 已核销金额（含已被撤销的核销额，撤销额另见 `reversedAmount`）。 */
  allocatedAmount: number;
  contractId: string;
  contractNo: string;
  currency: string;
  customer: BillingCustomerRef;
  dueDate: string;
  id: string;
  note?: string;
  /** 未收余额，服务端计算（前端不得自行用 amount - allocatedAmount 展示）。 */
  outstanding: number;
  periodNo: number;
  /** 已冲销金额；契约列表未列，详情可能返回，故可选。 */
  reversedAmount?: number;
  status: ReceivableStatus;
  amount: number;
  /** 乐观锁版本，展期必须回传。 */
  version?: number;
}

/** 应收列表汇总（契约 §5.5：`summary{...}`，服务端口径）。 */
export interface ReceivableSummary {
  overdueAmount: number;
  outstandingAmount: number;
  settledAmount: number;
  totalAmount: number;
}

export interface ReceivableListQuery extends OpsListQuery {
  contractId?: string;
  customerId?: string;
  dueFrom?: string;
  dueTo?: string;
  overdueOnly?: boolean;
  status?: ReceivableStatus[];
}

export interface ReceivableListResult extends OpsPagedResult<Receivable> {
  summary?: ReceivableSummary;
}

/** 核销分配流水（应收详情内的 `allocations[]`）。 */
export interface ReceivableAllocationLine {
  allocatedAt: string;
  allocatedBy: OpsActorRef;
  amount: number;
  id: string;
  receiptId: string;
  receiptNo?: string;
  /** 已被撤销的金额；「有效核销额」= amount - reversedAmount。 */
  reversedAmount?: number;
}

/** 展期记录（仅追加，保留原到期日；契约 §3.4）。 */
export interface ReceivableExtension {
  createdAt: string;
  createdBy: OpsActorRef;
  id: string;
  newDueDate: string;
  previousDueDate: string;
  reason: string;
}

/** 冲正/撤销流水（仅追加，不覆盖原流水）。 */
export interface BillingReversalLine {
  amount: number;
  /** 关联的核销流水（撤销核销时存在）。 */
  allocationId?: string;
  createdAt: string;
  createdBy: OpsActorRef;
  id: string;
  reason: string;
  /**
   * 关联的原收款（收款冲正时存在）。
   * 待确认：契约详情响应未列该字段，但「冲正记录关联原收款」需要它可追溯。
   */
  receiptId?: string;
  /** `receipt_reversal` = 收款冲正；`allocation_reversal` = 撤销核销。 */
  type?: 'allocation_reversal' | 'receipt_reversal';
}

export interface ReceivableDetail {
  allocations: ReceivableAllocationLine[];
  extensions: ReceivableExtension[];
  receivable: Receivable;
  reversals: BillingReversalLine[];
}

/** `POST /receivables` 请求体：只提交明细行金额，合计由服务端复算（契约 §2.2）。 */
export interface CreateReceivablePlanInput {
  contractId: string;
  periods: CreateReceivablePeriodInput[];
}

export interface CreateReceivablePeriodInput {
  amount: number;
  dueDate: string;
  note?: string;
}

export interface CreateReceivablePlanResult {
  items: Receivable[];
}

export interface ExtendReceivableInput {
  newDueDate: string;
  reason: string;
  version: number;
}

export interface ExtendReceivableResult {
  extension: ReceivableExtension;
  receivable: Receivable;
}

// ---------------------------------------------------------------- 收款

/** 收款条目（列表与详情主体）。 */
export interface Receipt {
  allocatedAmount: number;
  approvedAt?: null | string;
  approvedBy?: null | OpsActorRef;
  contractId?: null | string;
  contractNo?: null | string;
  currency: string;
  customer: BillingCustomerRef;
  id: string;
  method: BillingMethodRef;
  receiptNo: string;
  recordedBy: OpsActorRef;
  recordedReason?: null | string;
  referenceNo?: null | string;
  status: ReceiptStatus;
  transactionDate: string;
  amount: number;
  version?: number;
  voucherRef?: null | string;
}

export interface ReceiptListQuery extends OpsListQuery {
  contractId?: string;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  methodCode?: string;
  status?: ReceiptStatus[];
}

export type ReceiptListResult = OpsPagedResult<Receipt>;

/** 核销分配（收款详情内的 `allocations[]`）。 */
export interface ReceiptAllocationLine {
  allocatedAt: string;
  allocatedBy: OpsActorRef;
  amount: number;
  id: string;
  receivableId: string;
  receivablePeriodNo?: number;
  receivableDueDate?: string;
  reversedAmount?: number;
}

export interface RefundBrief {
  amount: number;
  id: string;
  reason: string;
  refundDate: string;
  refundNo: string;
  status: RefundStatus;
}

export interface ReceiptDetail {
  allocations: ReceiptAllocationLine[];
  receipt: Receipt;
  refunds: RefundBrief[];
  reversals: BillingReversalLine[];
}

export interface CreateReceiptInput {
  amount: number;
  contractId?: string;
  currency: string;
  customerId: string;
  methodCode: string;
  referenceNo?: string;
  transactionDate: string;
  voucherRef?: string;
}

export interface CreateReceiptResult {
  /** 同流水号重复登记的提示（契约 §5.5 `duplicateWarnings[]`），不是错误。 */
  duplicateWarnings: string[];
  receipt: Receipt;
}

export type ReceiptTransitionAction = 'approve' | 'reject';

export interface ReceiptTransitionInput {
  action: ReceiptTransitionAction;
  reason?: string;
  version: number;
}

export interface ReceiptTransitionResult {
  receipt: Receipt;
}

export interface ReceiptAllocationInput {
  allocations: ReceiptAllocationDraft[];
  reason?: string;
  version?: number;
}

export interface ReceiptAllocationDraft {
  amount: number;
  receivableId: string;
}

/** 核销后的应收摘要（契约 §5.5 `receivablesSummary[]`）。 */
export interface ReceiptAllocationReceivableSummary {
  allocatedAmount: number;
  id: string;
  outstanding: number;
  periodNo?: number;
}

export interface ReceiptAllocationResult {
  allocations: ReceiptAllocationLine[];
  receivablesSummary: ReceiptAllocationReceivableSummary[];
  receipt: Receipt;
}

export interface ReverseReceiptInput {
  reason: string;
  version: number;
}

export interface ReverseReceiptResult {
  receipt: Receipt;
  reversal: { amount: number };
}

export interface ReverseAllocationInput {
  amount: number;
  reason: string;
}

export interface ReverseAllocationResult {
  allocation: ReceiptAllocationLine;
  receivable: Receivable;
}

// ---------------------------------------------------------------- 退款

export interface Refund {
  amount: number;
  approvedBy?: null | OpsActorRef;
  contractId?: null | string;
  currency: string;
  customer: BillingCustomerRef;
  externalVoucherRef?: null | string;
  handledBy: OpsActorRef;
  id: string;
  reason: string;
  receiptId: string;
  receiptNo: string;
  refundDate: string;
  refundNo: string;
  status: RefundStatus;
}

export interface RefundListQuery extends OpsListQuery {
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: RefundStatus[];
}

export type RefundListResult = OpsPagedResult<Refund>;

export interface CreateRefundInput {
  amount: number;
  contractId?: string;
  externalVoucherRef?: string;
  reason: string;
  receiptId: string;
  refundDate: string;
}

export interface CreateRefundResult {
  refund: Refund;
}

export type RefundTransitionAction = 'approve' | 'cancel';

export interface RefundTransitionInput {
  action: RefundTransitionAction;
  reason: string;
}

export interface RefundTransitionResult {
  receipt?: Receipt;
  refund: Refund;
}
