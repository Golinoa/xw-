/**
 * 命令下发表单的提交状态机：**幂等键只生成一次**、双击只发一次、失败保留原因与键。
 *
 * 为什么不用「提交时生成 key」的实现（其它域现在这样写）：租户命令是跨系统写操作，
 * 同一用户意图的第二次提交必须是**重放**而不是新命令。键的生命周期因此绑定
 * 「一次表单意图」：
 *
 * 1. `openForm()` 生成 key 并冻结本次上下文（含 `expectedSyncVersion`）；
 * 2. `submit()` 期间双击直接返回，不发第二个请求；
 * 3. 失败后再次 `submit()`（用户改完原因再点）**复用同一个 key**；
 * 4. 只有关闭表单后重新打开，才视为新的意图、生成新 key。
 *
 * 另外，缺少 `expectedSyncVersion` 时 `composeCommandInput` 直接拒绝，
 * 绝不发一个版本号为 `0` 的请求去触发服务端覆盖。
 */
import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type {
  CreateTenantCommandInput,
  TenantCommandAccepted,
  TenantCommandType,
} from '#/api/ops/tenant/types';

import { computed, ref, shallowRef } from 'vue';

import { describeTenantError } from '#/api/ops/tenant/errors';
import { createCommandIdempotencyKey } from '#/api/ops/tenant/idempotency';
import {
  commandRequiresHighRisk,
  composeCommandInput,
  validateReason,
} from '#/api/ops/tenant/rules';

/** 一次下发意图的冻结上下文（打开表单时确定）。 */
export interface CommandFormContext {
  changeRequestId?: string;
  commandType: TenantCommandType;
  contractId?: string;
  /** 直接来自映射详情；`undefined` 表示详情未加载完，提交会被拒绝。 */
  expectedSyncVersion: null | number | undefined;
  label: string;
  mappingId: string;
  mappingNo?: string;
}

export interface CommandSubmissionPayload {
  idempotencyKey: string;
  input: CreateTenantCommandInput;
  mappingId: string;
}

export function useCommandSubmission(options: {
  create: (payload: CommandSubmissionPayload) => Promise<TenantCommandAccepted>;
}) {
  const open = ref(false);
  const context = shallowRef<CommandFormContext | null>(null);
  const reason = ref('');
  const reasonError = ref<null | string>(null);
  const acknowledged = ref(false);
  const acknowledgedError = ref<null | string>(null);
  const submitting = ref(false);
  const error = shallowRef<null | TenantErrorView>(null);
  const accepted = shallowRef<null | TenantCommandAccepted>(null);
  /** 当前意图的幂等键；只在 `openForm()` 与 `reset()` 变化。 */
  const idempotencyKey = ref<null | string>(null);

  const highRisk = computed(() =>
    context.value ? commandRequiresHighRisk(context.value.commandType) : false,
  );

  function reset(): void {
    context.value = null;
    reason.value = '';
    reasonError.value = null;
    acknowledged.value = false;
    acknowledgedError.value = null;
    error.value = null;
    accepted.value = null;
    submitting.value = false;
    idempotencyKey.value = null;
  }

  /** 打开表单：生成幂等键，之后无论提交多少次都用它。 */
  function openForm(next: CommandFormContext): void {
    reset();
    context.value = next;
    idempotencyKey.value = createCommandIdempotencyKey();
    open.value = true;
  }

  function close(): void {
    if (submitting.value) {
      return;
    }
    open.value = false;
    reset();
  }

  function setReason(value: string): void {
    reason.value = value;
    if (reasonError.value) {
      reasonError.value = null;
    }
  }

  function setAcknowledged(value: boolean): void {
    acknowledged.value = value;
    if (acknowledgedError.value) {
      acknowledgedError.value = null;
    }
  }

  async function submit(): Promise<TenantCommandAccepted | undefined> {
    if (submitting.value) {
      return undefined;
    }
    const current = context.value;
    const key = idempotencyKey.value;
    if (!current || !key) {
      return undefined;
    }
    const validatedReason = validateReason(reason.value);
    if (!validatedReason.ok) {
      reasonError.value = validatedReason.message ?? '请填写操作原因';
      return undefined;
    }
    if (highRisk.value && !acknowledged.value) {
      acknowledgedError.value = '请勾选确认，表示已了解本次操作的影响';
      return undefined;
    }
    const composed = composeCommandInput({
      draft: {
        commandType: current.commandType,
        ...(current.contractId === undefined
          ? {}
          : { contractId: current.contractId }),
        ...(current.changeRequestId === undefined
          ? {}
          : { changeRequestId: current.changeRequestId }),
      },
      expectedSyncVersion: current.expectedSyncVersion,
      reason: validatedReason.value,
    });
    if (!composed.ok) {
      // 版本缺失属于前置条件问题，直接拦在提交前，不发请求。
      error.value = {
        accepted: false,
        canRetry: false,
        description: composed.message,
        kind: 'validation',
        shouldRefresh: composed.code === 'version_missing',
        title:
          composed.code === 'version_missing' ? '缺少同步版本' : '提交内容有误',
      };
      return undefined;
    }

    submitting.value = true;
    error.value = null;
    try {
      const result = await options.create({
        idempotencyKey: key,
        input: composed.value,
        mappingId: current.mappingId,
      });
      accepted.value = result;
      open.value = false;
      reason.value = '';
      acknowledged.value = false;
      return result;
    } catch (error_: unknown) {
      // 失败保留原因与键：改完原因再点，是同一次意图的重放。
      error.value = describeTenantError(error_);
      return undefined;
    } finally {
      submitting.value = false;
    }
  }

  return {
    accepted,
    acknowledged,
    acknowledgedError,
    close,
    context,
    error,
    highRisk,
    idempotencyKey,
    open,
    openForm,
    reason,
    reasonError,
    reset,
    setAcknowledged,
    setReason,
    submit,
    submitting,
  };
}
