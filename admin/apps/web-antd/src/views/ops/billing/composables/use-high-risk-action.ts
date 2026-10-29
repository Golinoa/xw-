/**
 * 高风险动作的提交状态机（二次确认 + 必填原因 + 防重复提交 + 失败保留输入）。
 *
 * 适用动作为契约 §4 的高风险清单：`receipt.approve` / `receipt.reconcile` /
 * `receipt.reverse` / `receipt.refund`（页面上用 `isHighRiskPermission()` 判定，
 * 不允许在页面里手写动作码字符串）。
 *
 * 设计要点：
 * 1. `open()` 只准备摘要，**不会**发请求——高影响动作必须由用户在弹窗里显式确认；
 * 2. `confirm()` 先做原因校验，校验不过不发请求；
 * 3. `submitting` 期间重复点击直接返回，避免双击造成两笔资金动作；
 * 4. 失败时保留已填原因与错误详情（含 requestId），成功后清空原因并关闭。
 */
import type { BillingErrorView } from '#/api/ops/billing/errors';

import { ref, shallowRef } from 'vue';

import { describeBillingError } from '#/api/ops/billing/errors';
import { validateReason } from '#/api/ops/billing/rules';

/** 确认弹窗里的「金额 / 对象 / 影响」摘要行。 */
export interface HighRiskSummaryRow {
  label: string;
  /** 已格式化的展示值（金额在调用方格式化，避免这里再做金额运算）。 */
  value: string;
  /** 强调行（金额、余额变化等）。 */
  emphasis?: boolean;
}

export interface HighRiskSummary {
  /** 影响说明：这笔操作会产生什么后果。 */
  impact: string;
  rows: HighRiskSummaryRow[];
  title: string;
}

export interface HighRiskActionOptions<TResult> {
  /** 动作名，用于文案与错误标题，如「审核收款」。 */
  actionLabel: string;
  execute: (payload: { reason: string }) => Promise<TResult>;
  onSuccess?: (result: TResult) => Promise<void> | void;
}

export function useHighRiskAction<TResult>(
  options: HighRiskActionOptions<TResult>,
) {
  const open = ref(false);
  const submitting = ref(false);
  const reason = ref('');
  const reasonError = ref<null | string>(null);
  const error = shallowRef<BillingErrorView | null>(null);
  const summary = shallowRef<HighRiskSummary | null>(null);

  /** 打开确认弹窗：只准备摘要，不发请求。 */
  function prepare(next: HighRiskSummary): void {
    summary.value = next;
    reason.value = '';
    reasonError.value = null;
    error.value = null;
    open.value = true;
  }

  function cancel(): void {
    if (submitting.value) {
      return;
    }
    open.value = false;
  }

  function clearError(): void {
    error.value = null;
  }

  /**
   * 确认并提交。返回 `undefined` 表示未提交（校验失败）或提交失败（错误已落在 `error`）。
   */
  async function confirm(): Promise<TResult | undefined> {
    if (submitting.value) {
      return undefined;
    }
    const validated = validateReason(reason.value);
    if (!validated.ok) {
      reasonError.value = validated.message ?? '请填写操作原因';
      return undefined;
    }
    reasonError.value = null;
    error.value = null;
    submitting.value = true;
    try {
      const result = await options.execute({ reason: validated.value });
      // 仅在成功后清空原因：失败要保留已填内容，便于修改后重新提交
      reason.value = '';
      open.value = false;
      await options.onSuccess?.(result);
      return result;
    } catch (error_: unknown) {
      error.value = describeBillingError(error_);
      return undefined;
    } finally {
      submitting.value = false;
    }
  }

  return {
    cancel,
    clearError,
    confirm,
    error,
    open,
    prepare,
    reason,
    reasonError,
    submitting,
    summary,
  };
}
