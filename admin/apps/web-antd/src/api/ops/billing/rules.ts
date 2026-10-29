/**
 * 账款业务规则（前端呈现与提交前拦截）。
 *
 * 为什么规则要在前端再写一遍：服务端是唯一权威（任何写操作都会被再次校验），
 * 但金融页面必须在**提交前**把「为什么不能做」讲清楚——尤其是
 * 「登记人 ≠ 审核人」（Task 5 负责人默认规则）与「超额核销」。
 * 本文件的每条判定都在单测里覆盖，且文案与后端 `details.reason` 词表（契约 §6.4）一致。
 */
import type { ReceiptStatus, ReceivableStatus } from './types';

import { actorId } from './format';
import { AMOUNT_ERROR_MESSAGE, parseAmountInput } from './money';

/** 拒绝原因码：稳定标识，便于单测断言与埋点，不依赖中文文案。 */
export type RuleDenyCode =
  | 'amount_invalid'
  | 'currency_mismatch'
  | 'customer_mismatch'
  | 'duplicate_receivable'
  | 'identity_unknown'
  | 'permission'
  | 'receipt_exceeded'
  | 'receipt_not_approved'
  | 'receivable_exceeded'
  | 'receivable_reversed'
  | 'receivable_settled'
  | 'segregation_of_duty'
  | 'state';

export interface RuleDecision {
  allowed: boolean;
  /** 拒绝原因码；`allowed=true` 时为空。 */
  code?: RuleDenyCode;
  /** 面向运营的说明，可直接展示。 */
  message?: string;
}

const ALLOW: RuleDecision = { allowed: true };

function deny(code: RuleDenyCode, message: string): RuleDecision {
  return { allowed: false, code, message };
}

/** 可审核的收款状态：只有 `recorded` 能走 approve/reject（契约 §3.4 状态机）。 */
const REVIEWABLE_RECEIPT_STATUS: ReceiptStatus = 'recorded';

export interface ReceiptReviewContext {
  /** 当前登录运营成员 `operator.id`。 */
  currentOperatorId: null | string | undefined;
  /** 是否具备 `receipt.approve`。 */
  hasApprovePermission: boolean;
  /** 收款登记人，可能是 id 字符串或 `{id,displayName}`。 */
  recordedBy: Parameters<typeof actorId>[0];
  status: ReceiptStatus;
}

/**
 * 审核/驳回收款的可用性判定。
 *
 * 判定顺序刻意固定为「权限 → 身份 → 状态 → 职责分离」：
 * 没有权限的人不需要知道"自己是登记人"，避免暴露与授权无关的信息。
 * 职责分离：登记人自己审核 → 禁用按钮并说明原因（服务端同样会返回
 * 403 `FORBIDDEN` + `details.reason='SEGREGATION_OF_DUTY'`）。
 */
export function canReviewReceipt(context: ReceiptReviewContext): RuleDecision {
  if (!context.hasApprovePermission) {
    return deny(
      'permission',
      '缺少「审核收款」权限（receipt.approve），无法审核',
    );
  }
  const current = context.currentOperatorId ?? '';
  if (current === '') {
    return deny('identity_unknown', '无法确认当前操作人身份，请重新登录后再试');
  }
  if (context.status !== REVIEWABLE_RECEIPT_STATUS) {
    return deny('state', `当前收款状态不是「已登记未审核」，不能重复审核`);
  }
  if (actorId(context.recordedBy) === current) {
    return deny(
      'segregation_of_duty',
      '你是该笔收款的登记人，登记人与审核人必须是不同的人，请由其他运营人员审核',
    );
  }
  return ALLOW;
}

export interface ReceiptActionContext {
  currentOperatorId?: null | string;
  hasPermission: boolean;
  status: ReceiptStatus;
}

/** 核销：需要 `receipt.reconcile`，且收款必须已审核（未审核不计入实收）。 */
export function canAllocateReceipt(
  context: ReceiptActionContext,
): RuleDecision {
  if (!context.hasPermission) {
    return deny('permission', '缺少「核销收款」权限（receipt.reconcile）');
  }
  if (context.status === 'recorded') {
    return deny('receipt_not_approved', '该收款尚未审核，审核通过后才能核销');
  }
  if (context.status === 'reversed' || context.status === 'refunded') {
    return deny('state', '该收款已冲正或已全额退款，不能再核销');
  }
  return ALLOW;
}

/** 收款冲正：需要 `receipt.reverse`；已有有效核销时必须先撤销核销（服务端 HAS_ALLOCATIONS）。 */
export function canReverseReceipt(
  context: ReceiptActionContext & { hasActiveAllocations: boolean },
): RuleDecision {
  if (!context.hasPermission) {
    return deny(
      'permission',
      '缺少「撤销核销/收款冲正」权限（receipt.reverse）',
    );
  }
  if (context.status === 'reversed') {
    return deny('state', '该收款已经冲正，不能重复冲正');
  }
  if (context.hasActiveAllocations) {
    return deny(
      'state',
      '该收款仍有有效核销，请先撤销核销再冲正（冲正不会删除原记录）',
    );
  }
  return ALLOW;
}

/** 退款登记：需要 `receipt.refund`；已冲正/已全额退款的收款不能再退。 */
export function canRefundReceipt(context: ReceiptActionContext): RuleDecision {
  if (!context.hasPermission) {
    return deny('permission', '缺少「登记退款」权限（receipt.refund）');
  }
  if (context.status === 'recorded') {
    return deny('receipt_not_approved', '该收款尚未审核，暂不能登记退款');
  }
  if (context.status === 'reversed') {
    return deny('state', '该收款已冲正，不能登记退款');
  }
  if (context.status === 'refunded') {
    return deny('state', '该收款已全额退款');
  }
  return ALLOW;
}

/** 撤销核销：需要 `receipt.reverse`，且该笔核销存在可撤销额。 */
export function canReverseAllocation(context: {
  hasPermission: boolean;
  /** 该笔核销的有效金额（amount - reversedAmount）。 */
  remainingAmount: number;
}): RuleDecision {
  if (!context.hasPermission) {
    return deny('permission', '缺少「撤销核销」权限（receipt.reverse）');
  }
  if (!(context.remainingAmount > 0)) {
    return deny('state', '该笔核销已全部撤销，没有可撤销金额');
  }
  return ALLOW;
}

/**
 * 展期可用性判定。
 *
 * Task 5 负责人默认规则：**仅未结清应收可展期**；展期不新增审批，但必须
 * `receivable.write` + 填写原因，并追加展期记录（保留原到期日）。
 */
export function canExtendReceivable(context: {
  hasPermission: boolean;
  /** 服务端返回的未收余额。 */
  outstanding?: number;
  status: ReceivableStatus;
}): RuleDecision {
  if (!context.hasPermission) {
    return deny(
      'permission',
      '缺少「维护应收计划」权限（receivable.write），不能展期',
    );
  }
  if (context.status === 'reversed') {
    return deny('receivable_reversed', '该期应收已被冲销，不能展期');
  }
  if (context.status === 'paid') {
    return deny(
      'receivable_settled',
      '该期应收已结清，不能展期（仅未结清应收可展期）',
    );
  }
  if (typeof context.outstanding === 'number' && context.outstanding <= 0) {
    return deny('receivable_settled', '该期应收已无未收余额，不能展期');
  }
  return ALLOW;
}

/** 原因必填校验（高风险动作与展期都必须填原因，写入审计）。 */
export interface ReasonValidation {
  message?: string;
  ok: boolean;
  value: string;
}

export const REASON_MAX_LENGTH = 500;

export function validateReason(raw: string): ReasonValidation {
  const value = raw.trim();
  if (value === '') {
    return {
      message: '请填写操作原因（会写入审计，便于事后追溯）',
      ok: false,
      value,
    };
  }
  if (value.length > REASON_MAX_LENGTH) {
    return {
      message: `原因不能超过 ${REASON_MAX_LENGTH} 字`,
      ok: false,
      value,
    };
  }
  return { ok: true, value };
}

/** 核销弹窗里的候选行（用户填写的草稿）。 */
export interface AllocationCandidate {
  /** 用户输入的金额字符串（保留原始输入，便于出错时回填）。 */
  amountInput: string;
  currency: string;
  customerId: string;
  /** 服务端返回的该期未收余额。 */
  outstanding: number;
  periodNo?: number;
  receivableId: string;
}

export interface AllocationLineIssue {
  code: RuleDenyCode;
  message: string;
  receivableId: string;
}

export interface AllocationCheckInput {
  lines: readonly AllocationCandidate[];
  /** 收款总额（服务端字段）。 */
  receiptAmount: number;
  /** 该收款已核销净额（服务端字段）。 */
  receiptAllocatedAmount: number;
  receiptCurrency: string;
  receiptCustomerId: string;
}

export interface AllocationCheckResult {
  /** 可分配余额（`amount - allocatedAmount` 的精确差值，展示与预校验用）。 */
  allocatable: string;
  /** 与具体行无关的问题（合计超额、没有填写任何行）。 */
  formIssues: { code: RuleDenyCode; message: string }[];
  /** 逐行问题，按行序返回。 */
  lineIssues: AllocationLineIssue[];
  ok: boolean;
  /** 本次录入合计（精确十进制字符串），仅用于提示。 */
  total: string;
}

/**
 * 核销提交前校验。
 *
 * 三重拦截（与契约 §3.4 并发不变量一一对应）：
 * 1. 单行金额 > 该期未收余额 → `RECEIVABLE_EXCEEDED`；
 * 2. 合计 > 收款可分配净额 → `RECEIPT_EXCEEDED`；
 * 3. 跨客户/跨币种 → `CUSTOMER_MISMATCH` / `CURRENCY_MISMATCH`（数据库复合外键同样会拒绝）。
 *
 * 并发场景无法靠前端避免：服务端仍可能因余额被他人先改而返回 409，此时页面提示
 * 「余额已变化，请刷新后重试」并重新拉取（见 `errors.ts`）。
 */
export function checkAllocations(
  input: AllocationCheckInput,
): AllocationCheckResult {
  const lineIssues: AllocationLineIssue[] = [];
  const formIssues: { code: RuleDenyCode; message: string }[] = [];
  const seen = new Set<string>();
  let totalCents = 0n;
  let validLineCount = 0;

  for (const line of input.lines) {
    const parsed = parseAmountInput(line.amountInput);
    if (!parsed.ok) {
      lineIssues.push({
        code: 'amount_invalid',
        message: AMOUNT_ERROR_MESSAGE[parsed.error],
        receivableId: line.receivableId,
      });
      continue;
    }
    validLineCount += 1;

    if (seen.has(line.receivableId)) {
      lineIssues.push({
        code: 'duplicate_receivable',
        message: '同一期应收只能出现一行，请合并金额',
        receivableId: line.receivableId,
      });
      continue;
    }
    seen.add(line.receivableId);

    if (line.currency !== input.receiptCurrency) {
      lineIssues.push({
        code: 'currency_mismatch',
        message: `币种不一致（收款 ${input.receiptCurrency}，应收 ${line.currency}），不能核销`,
        receivableId: line.receivableId,
      });
      continue;
    }
    if (line.customerId !== input.receiptCustomerId) {
      lineIssues.push({
        code: 'customer_mismatch',
        message: '客户不一致，不能跨客户核销',
        receivableId: line.receivableId,
      });
      continue;
    }
    if (!(parsed.value <= line.outstanding)) {
      lineIssues.push({
        code: 'receivable_exceeded',
        message: '本次核销金额超过该期未收余额，请调整后重试',
        receivableId: line.receivableId,
      });
      continue;
    }
    totalCents += BigInt(parsed.normalized.replace('.', ''));
  }

  const allocatableCents =
    BigInt(Math.round(input.receiptAmount * 100)) -
    BigInt(Math.round(input.receiptAllocatedAmount * 100));
  const total = formatCents(totalCents);
  const allocatable = formatCents(allocatableCents);

  if (validLineCount === 0) {
    formIssues.push({
      code: 'amount_invalid',
      message: '请至少填写一条核销金额',
    });
  }

  if (lineIssues.length === 0 && totalCents > allocatableCents) {
    formIssues.push({
      code: 'receipt_exceeded',
      message: `本次核销合计 ${total} 超过收款可分配余额 ${allocatable}，请调整后重试`,
    });
  }

  return {
    allocatable,
    formIssues,
    lineIssues,
    ok: lineIssues.length === 0 && formIssues.length === 0,
    total,
  };
}

/** 收款冲正的可撤销金额上限等场景复用：把整数分格式化为 2 位小数字符串。 */
function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n)
    .toString()
    .padStart(2, '0')}`;
}
