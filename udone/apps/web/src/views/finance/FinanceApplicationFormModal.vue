<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { FinanceApplicationItem, FinanceApplicationKind, PaymentMethod } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { APPLICATION_KIND_LABELS, PAYMENT_METHOD_OPTIONS } from './finance-application-display';

/**
 * 发起一笔收付款申请。
 *
 * 入口在订单详情里，按金额行打开，订单、行 id 与可申请余额都由调用方传进来——
 * 这里不再让用户挑一次订单和明细行。少一次选择，就少一次选错行的机会。
 *
 * 额度上限只做「提交前提示」，真正的判定在库函数里（`available_amount` 带 FOR UPDATE）：
 * 两个人同时申请同一行的余额时，前端的上限是旧值，只有库里的行锁能挡住超额。
 */

export interface ApplicationTarget {
  orderId: string;
  orderNumber: string;
  kind: FinanceApplicationKind;
  lineId: string;
  lineName: string;
  availableAmount: number;
}

const props = defineProps<{
  open: boolean;
  target: ApplicationTarget | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  created: [application: FinanceApplicationItem];
}>();

const auth = useAuthStore();
const submitting = ref(false);
const error = ref('');

/**
 * 发生日期默认今天，按**本地日历日**取，不做 UTC 换算：
 * `toISOString()` 在东八区凌晨会给出昨天的日期，财务记的是「哪一天收到的钱」，
 * 差一天就要在对账时解释一次。
 */
function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

const form = reactive({
  amount: undefined as number | undefined,
  method: 'bank' as PaymentMethod,
  occurredOn: todayIso(),
  referenceNo: '',
  remark: '',
});

function reset() {
  form.amount = undefined;
  form.method = 'bank';
  form.occurredOn = todayIso();
  form.referenceNo = '';
  form.remark = '';
  error.value = '';
  submitting.value = false;
}

watch(
  () => [props.open, props.target] as const,
  ([open]) => {
    if (open) reset();
  },
  { immediate: true },
);

const kindLabel = computed(() =>
  props.target ? APPLICATION_KIND_LABELS[props.target.kind] : '收付款',
);

const maxAmount = computed(() => props.target?.availableAmount ?? 0);

function close() {
  if (submitting.value) return;
  emit('update:open', false);
}

async function submit() {
  const target = props.target;
  if (!target || submitting.value) return;

  const amount = form.amount ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    error.value = '金额必须大于 0';
    return;
  }
  // 两位小数在契约里也是硬约束，先在这里拦住，避免用户看着「提交成功」再被 400 退回。
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    error.value = '金额最多保留两位小数';
    return;
  }
  if (amount > maxAmount.value) {
    error.value = `金额不能超过该行的可申请余额 ${formatMoney(maxAmount.value)}`;
    return;
  }
  if (!form.occurredOn) {
    error.value = '请选择发生日期';
    return;
  }

  submitting.value = true;
  error.value = '';
  try {
    const result = await auth.api.call('createFinanceApplication', {
      body: {
        kind: target.kind,
        orderId: target.orderId,
        lineId: target.lineId,
        amount,
        method: form.method,
        occurredOn: form.occurredOn,
        ...(form.referenceNo.trim() ? { referenceNo: form.referenceNo.trim() } : {}),
        ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
      },
    });
    message.success(`已提交${kindLabel.value}申请，等待审批`);
    emit('created', result.application);
    emit('update:open', false);
  } catch (cause) {
    if (cause instanceof ApiClientError) {
      error.value = cause.message;
      return;
    }
    error.value = '提交失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="`申请${kindLabel}`"
    :confirm-loading="submitting"
    ok-text="提交申请"
    cancel-text="取消"
    destroy-on-close
    @ok="submit"
    @cancel="close"
  >
    <a-alert
      v-if="target"
      class="target-hint"
      type="info"
      show-icon
      :message="`${target.orderNumber} · ${target.lineName}`"
      :description="`该行可申请余额 ${formatMoney(target.availableAmount)}（已扣除已确认与在途金额）`"
    />

    <a-form layout="vertical">
      <a-form-item label="金额" required>
        <a-input-number
          v-model:value="form.amount"
          class="full-width"
          :min="0.01"
          :max="maxAmount"
          :precision="2"
          :step="100"
          placeholder="不超过该行可申请余额"
        />
      </a-form-item>
      <a-form-item label="方式" required>
        <a-select v-model:value="form.method" :options="PAYMENT_METHOD_OPTIONS" />
      </a-form-item>
      <a-form-item label="发生日期" required>
        <a-date-picker
          v-model:value="form.occurredOn"
          class="full-width"
          value-format="YYYY-MM-DD"
          placeholder="选择日期"
        />
      </a-form-item>
      <a-form-item label="流水号">
        <a-input
          v-model:value="form.referenceNo"
          :maxlength="64"
          placeholder="银行流水或凭证号，可选"
        />
      </a-form-item>
      <a-form-item label="备注">
        <a-textarea v-model:value="form.remark" :rows="2" :maxlength="500" show-count />
      </a-form-item>
    </a-form>

    <a-alert v-if="error" type="error" show-icon :message="error" />
    <p class="modal-note">提交后金额进入在途，占用该行余额但不计入已收/已付；终审通过后才入账。</p>
  </a-modal>
</template>

<style scoped>
.target-hint {
  margin-bottom: var(--space-16);
}

.full-width {
  width: 100%;
}

.modal-note {
  margin: var(--space-12) 0 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
</style>
