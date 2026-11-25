<script lang="ts" setup>
import type {
  FinanceApplicationItem,
  FinanceApplicationKind,
  PaymentMethod,
} from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import { Alert, DatePicker, Form, FormItem, Input, InputNumber, Modal, Select, Textarea } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  APPLICATION_KIND_LABEL_KEYS,
  PAYMENT_METHOD_LABEL_KEYS,
  PAYMENT_METHODS_ORDER,
} from './finance-application-display';

/**
 * 入口在订单详情里，按金额行打开：订单、行 id、可申请余额都由调用方传入，
 * 不再让用户重选一次。额度上限只做提交前提示，真正判定在服务端行锁里。
 */
export interface ApplicationTarget {
  orderId: string;
  orderNumber: string;
  kind: FinanceApplicationKind;
  lineId: string;
  lineName: string;
  availableAmount: number;
}

const props = defineProps<{ open: boolean; target: ApplicationTarget | null }>();

const emit = defineEmits<{
  created: [application: FinanceApplicationItem];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const submitting = ref(false);
const error = ref('');

/** 按本地日历日取，toISOString 在东八区凌晨会给昨天，财务记的是「哪天收到钱」。 */
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

watch(
  () => [props.open, props.target] as const,
  ([open]) => {
    if (!open) return;
    form.amount = undefined;
    form.method = 'bank';
    form.occurredOn = todayIso();
    form.referenceNo = '';
    form.remark = '';
    error.value = '';
    submitting.value = false;
  },
  { immediate: true },
);

const kindLabel = computed(() =>
  props.target ? $t(APPLICATION_KIND_LABEL_KEYS[props.target.kind]) : $t('shell.applications.kindGeneric'),
);
const maxAmount = computed(() => props.target?.availableAmount ?? 0);
const methodOptions = computed(() =>
  PAYMENT_METHODS_ORDER.map((method) => ({
    value: method,
    label: $t(PAYMENT_METHOD_LABEL_KEYS[method]),
  })),
);

function close() {
  if (submitting.value) return;
  emit('update:open', false);
}

async function submit() {
  const target = props.target;
  if (!target || submitting.value) return;

  const amount = form.amount ?? 0;
  if (!Number.isFinite(amount) || amount <= 0) {
    error.value = $t('shell.applications.amountRequired');
    return;
  }
  // 两位小数是契约硬约束，先拦住，避免看着「提交成功」再被 400 退回。
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    error.value = $t('shell.applications.amountPrecision');
    return;
  }
  if (amount > maxAmount.value) {
    error.value = $t('shell.applications.amountExceeds', { max: formatMoney(maxAmount.value) });
    return;
  }
  if (!form.occurredOn) {
    error.value = $t('shell.applications.occurredOnRequired');
    return;
  }

  submitting.value = true;
  error.value = '';
  try {
    const result = await authStore.api.call('createFinanceApplication', {
      body: {
        amount,
        kind: target.kind,
        lineId: target.lineId,
        method: form.method,
        occurredOn: form.occurredOn,
        orderId: target.orderId,
        ...(form.referenceNo.trim() ? { referenceNo: form.referenceNo.trim() } : {}),
        ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
      },
    });
    emit('created', result.application);
    emit('update:open', false);
  } catch (error_) {
    error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.applications.submitFailed');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Modal
    :confirm-loading="submitting"
    :mask-closable="!submitting"
    :ok-text="$t('shell.applications.submitApply')"
    :cancel-text="$t('shell.applications.cancel')"
    :open="open"
    :title="$t('shell.applications.applyTitle', { kind: kindLabel })"
    destroy-on-close
    @cancel="close"
    @ok="submit"
  >
    <Alert
      v-if="target"
      class="mb-4"
      show-icon
      type="info"
      :message="`${target.orderNumber} · ${target.lineName}`"
      :description="$t('shell.applications.availableHint', { amount: formatMoney(target.availableAmount) })"
    />

    <Form layout="vertical">
      <FormItem html-for="app-amount" :label="$t('shell.applications.formAmount')" required>
        <InputNumber
          id="app-amount"
          v-model:value="form.amount"
          class="w-full"
          :max="maxAmount"
          :min="0.01"
          :precision="2"
          :step="100"
          :placeholder="$t('shell.applications.amountPlaceholder')"
        />
      </FormItem>
      <FormItem html-for="app-method" :label="$t('shell.applications.formMethod')" required>
        <Select id="app-method" v-model:value="form.method" :options="methodOptions" />
      </FormItem>
      <FormItem html-for="app-date" :label="$t('shell.applications.formOccurredOn')" required>
        <DatePicker
          id="app-date"
          v-model:value="form.occurredOn"
          class="w-full"
          value-format="YYYY-MM-DD"
          :placeholder="$t('shell.applications.datePlaceholder')"
        />
      </FormItem>
      <FormItem html-for="app-ref" :label="$t('shell.applications.formReferenceNo')">
        <Input
          id="app-ref"
          v-model:value="form.referenceNo"
          :maxlength="64"
          :placeholder="$t('shell.applications.referencePlaceholder')"
        />
      </FormItem>
      <FormItem html-for="app-remark" :label="$t('shell.applications.formRemark')">
        <Textarea id="app-remark" v-model:value="form.remark" :maxlength="500" :rows="2" show-count />
      </FormItem>
    </Form>

    <Alert v-if="error" show-icon type="error" :message="error" role="alert" />
    <p class="mt-3 text-xs text-muted-foreground">{{ $t('shell.applications.modalNote') }}</p>
  </Modal>
</template>
