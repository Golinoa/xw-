/**
 * 权益高风险动作的提交状态机（二次确认 + 必填原因 + 防重复提交 + 失败保留输入）。
 *
 * 适用动作：`entitlement.approve`（审批/驳回）与 `entitlement.execute` 中的
 * `revoke`/`suspend`（由 `isHighRiskEntitlementAction()` 判定，页面不手写动作码）。
 *
 * 设计要点（与 billing 域同一模式，避免两套交互）：
 * 1. `prepare()` 只准备摘要，**不发请求**——高影响动作必须由用户显式确认；
 * 2. `confirm()` 先校验原因，校验不过不发请求；
 * 3. `submitting` 期间重复点击直接返回，避免双击产生两条审批/执行；
 * 4. 失败保留已填原因与 `requestId`，成功后清空并关闭。
 */
import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';

import { ref, shallowRef } from 'vue';

import { describeEntitlementError } from '#/api/ops/entitlement/errors';
import { validateEntitlementReason } from '#/api/ops/entitlement/rules';

export interface HighRiskSummaryRow {
  emphasis?: boolean;
  label: string;
  value: string;
}

export interface HighRiskSummary {
  /** 影响说明：这次动作会产生什么后果（含下游命令/审批后果）。 */
  impact: string;
  rows: HighRiskSummaryRow[];
  title: string;
}

export interface HighRiskActionOptions<TResult> {
  actionLabel: string;
  execute: (payload: { reason: string }) => Promise<TResult>;
  onSuccess?: (result: TResult) => Promise<void> | void;
}

export function useEntitlementHighRisk<TResult>(
  options: HighRiskActionOptions<TResult>,
) {
  const open = ref(false);
  const submitting = ref(false);
  const reason = ref('');
  const reasonError = ref<null | string>(null);
  const error = shallowRef<EntitlementErrorView | null>(null);
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
    const validated = validateEntitlementReason(reason.value);
    if (!validated.ok) {
      reasonError.value = validated.message ?? '请填写操作原因';
      return undefined;
    }
    reasonError.value = null;
    error.value = null;
    submitting.value = true;
    try {
      const result = await options.execute({ reason: validated.value });
      reason.value = '';
      open.value = false;
      await options.onSuccess?.(result);
      return result;
    } catch (error_: unknown) {
      error.value = describeEntitlementError(error_);
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
