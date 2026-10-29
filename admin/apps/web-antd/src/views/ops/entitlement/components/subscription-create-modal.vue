<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  BillingCycle,
  CreateSubscriptionResult,
  EntitlementFeatureInput,
} from '#/api/ops/entitlement/types';

import { reactive, ref, shallowRef, watch } from 'vue';

import {
  Alert,
  Button,
  DatePicker,
  Input,
  message,
  Modal,
  Select,
  Switch,
  Tag,
} from 'ant-design-vue';

import {
  BILLING_CYCLE_OPTIONS,
  createSubscription,
  describeEntitlementError,
} from '#/api/ops/entitlement';

import FeatureEditor from './feature-editor.vue';

defineOptions({ name: 'EntitlementSubscriptionCreateModal' });

/**
 * 创建订阅草稿（契约 §5.6 `POST /subscriptions`）。
 *
 * 草稿不会立即生效：必须「提交审批 → 他人审批通过」才成为 `active`
 * （界面不提供直接置为生效的分支）。
 */
const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  created: [CreateSubscriptionResult];
  'update:open': [boolean];
}>();

const form = reactive({
  autoRenewIntent: false,
  billingCycle: 'yearly' as BillingCycle,
  contractItemId: '',
  customerId: '',
  endsOn: undefined as Dayjs | undefined,
  features: [] as EntitlementFeatureInput[],
  startsOn: undefined as Dayjs | undefined,
});
const errors = ref<Record<string, string>>({});
const submitting = ref(false);
const error = shallowRef<EntitlementErrorView | null>(null);

function reset(): void {
  form.autoRenewIntent = false;
  form.billingCycle = 'yearly';
  form.contractItemId = '';
  form.customerId = '';
  form.endsOn = undefined;
  form.startsOn = undefined;
  form.features = [];
  errors.value = {};
  error.value = null;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
    }
  },
);

function validate(): boolean {
  const next: Record<string, string> = {};
  if (form.customerId.trim() === '') {
    next.customerId = '请填写客户 ID（客户选择器待客户域联调）';
  }
  if (form.contractItemId.trim() === '') {
    next.contractItemId = '请填写来源合同条目 ID（来源合同必须已生效）';
  }
  if (!form.startsOn) {
    next.startsOn = '请选择生效日';
  }
  if (
    form.startsOn &&
    form.endsOn &&
    form.endsOn.isBefore(form.startsOn, 'day')
  ) {
    next.endsOn = '到期日不能早于生效日';
  }
  if (form.features.length === 0) {
    next.features = '请至少添加一个权益行（功能键）';
  }
  const keys = form.features.map((feature) => feature.featureKey.trim());
  if (keys.includes('')) {
    next.features = '功能键不能为空';
  }
  if (new Set(keys).size !== keys.length) {
    next.features = '功能键不能重复';
  }
  errors.value = next;
  return Object.keys(next).length === 0;
}

async function submit(): Promise<void> {
  if (submitting.value || !validate()) {
    return;
  }
  const startsOn = form.startsOn;
  if (!startsOn) {
    // validate() 已保证非空；这里保留显式分支，避免用非空断言掩盖状态异常
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const result = await createSubscription({
      autoRenewIntent: form.autoRenewIntent,
      billingCycle: form.billingCycle,
      contractItemId: form.contractItemId.trim(),
      customerId: form.customerId.trim(),
      features: form.features.map((feature) => ({
        displayName: feature.displayName?.trim() || feature.featureKey,
        enabled: feature.enabled,
        featureKey: feature.featureKey.trim(),
        quota: feature.quota ?? null,
        termMonths: feature.termMonths ?? null,
      })),
      startsOn: startsOn.format('YYYY-MM-DD'),
      ...(form.endsOn ? { endsOn: form.endsOn.format('YYYY-MM-DD') } : {}),
    });
    message.success(
      `订阅 ${result.subscription.subscriptionNo} 已创建为草稿，提交审批并通过后才会生效`,
    );
    emit('update:open', false);
    emit('created', result);
  } catch (error_: unknown) {
    error.value = describeEntitlementError(error_);
  } finally {
    submitting.value = false;
  }
}

function onCancel(): void {
  if (submitting.value) {
    return;
  }
  emit('update:open', false);
}
</script>

<template>
  <Modal
    :footer="null"
    :mask-closable="false"
    :open="open"
    :width="900"
    title="创建 SaaS 订阅草稿"
    @cancel="onCancel"
  >
    <Alert
      class="mb-3"
      message="创建后为「草稿」：需提交审批并由他人审批通过才会生效；生效后的权益调整只能新增变更申请，不能直接改写已发放快照。"
      show-icon
      type="info"
    />

    <div class="grid gap-3 md:grid-cols-2">
      <div>
        <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
        <Input
          v-model:value="form.customerId"
          :status="errors.customerId ? 'error' : undefined"
          placeholder="软件客户 ID"
        />
        <p v-if="errors.customerId" class="mt-1 text-xs text-red-500">
          {{ errors.customerId }}
        </p>
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">来源合同条目 ID</div>
        <Input
          v-model:value="form.contractItemId"
          :status="errors.contractItemId ? 'error' : undefined"
          placeholder="合同条目 ID（来源合同必须 active）"
        />
        <p v-if="errors.contractItemId" class="mt-1 text-xs text-red-500">
          {{ errors.contractItemId }}
        </p>
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">计费周期</div>
        <Select
          v-model:value="form.billingCycle"
          :options="BILLING_CYCLE_OPTIONS"
          style="width: 100%"
        />
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">
          自动续订意向（仅记录）
        </div>
        <div class="flex h-8 items-center gap-2">
          <Switch v-model:checked="form.autoRenewIntent" />
          <span class="text-xs text-muted-foreground">
            首期只记录意向，不自动扣费
          </span>
        </div>
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">生效日</div>
        <DatePicker
          v-model:value="form.startsOn"
          :status="errors.startsOn ? 'error' : undefined"
          style="width: 100%"
        />
        <p v-if="errors.startsOn" class="mt-1 text-xs text-red-500">
          {{ errors.startsOn }}
        </p>
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">到期日（可空）</div>
        <DatePicker
          v-model:value="form.endsOn"
          :status="errors.endsOn ? 'error' : undefined"
          style="width: 100%"
        />
        <p v-if="errors.endsOn" class="mt-1 text-xs text-red-500">
          {{ errors.endsOn }}
        </p>
      </div>
    </div>

    <div class="mt-3">
      <div class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span>权益行</span>
        <Tag>将生成首个快照</Tag>
      </div>
      <FeatureEditor v-model="form.features" />
      <p v-if="errors.features" class="mt-1 text-xs text-red-500">
        {{ errors.features }}
      </p>
    </div>

    <Alert
      v-if="error"
      class="mt-3"
      :message="error.title"
      show-icon
      type="error"
    >
      <template #description>
        <p>{{ error.description }}</p>
        <p v-if="error.requestId" class="text-xs">
          请求 ID：<span class="font-mono">{{ error.requestId }}</span>
        </p>
      </template>
    </Alert>

    <div class="mt-4 flex justify-end gap-2">
      <Button :disabled="submitting" @click="onCancel">取消</Button>
      <Button :loading="submitting" type="primary" @click="submit">
        创建草稿
      </Button>
    </div>
  </Modal>
</template>
