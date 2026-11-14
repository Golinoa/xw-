<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  CreateLicenseResult,
  EntitlementFeatureInput,
  LicenseMode,
} from '#/api/ops/entitlement/types';

import { computed, reactive, ref, shallowRef, watch } from 'vue';

import {
  Alert,
  Button,
  DatePicker,
  Input,
  message,
  Modal,
  Select,
  Tag,
} from 'ant-design-vue';

import {
  createLicense,
  describeEntitlementError,
  LICENSE_MODE_OPTIONS,
  validateLicenseTerm,
} from '#/api/ops/entitlement';

import FeatureEditor from './feature-editor.vue';

defineOptions({ name: 'EntitlementLicenseCreateModal' });

/**
 * 创建私有授权草稿（契约 §5.6 `POST /licenses`）。
 *
 * 永久授权 ≠ 永久更新：
 * - `license_mode='perpetual'` 时到期日必须留空（契约 CHECK）；
 * - 维护期 `maintenanceUntil` 单独填写，界面上不能由授权方式推导。
 */
const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  created: [CreateLicenseResult];
  'update:open': [boolean];
}>();

const form = reactive({
  contractItemId: '',
  customerId: '',
  deploymentInstanceId: '',
  features: [] as EntitlementFeatureInput[],
  licenseMode: 'term' as LicenseMode,
  maintenanceUntil: undefined as Dayjs | undefined,
  validFrom: undefined as Dayjs | undefined,
  validTo: undefined as Dayjs | undefined,
});
const errors = ref<Record<string, string>>({});
const submitting = ref(false);
const error = shallowRef<EntitlementErrorView | null>(null);

const perpetual = computed(() => form.licenseMode === 'perpetual');

watch(
  () => props.open,
  (open) => {
    if (open) {
      form.contractItemId = '';
      form.customerId = '';
      form.deploymentInstanceId = '';
      form.features = [];
      form.licenseMode = 'term';
      form.maintenanceUntil = undefined;
      form.validFrom = undefined;
      form.validTo = undefined;
      errors.value = {};
      error.value = null;
    }
  },
);

watch(perpetual, (value) => {
  if (value) {
    form.validTo = undefined;
  }
});

function validate(): boolean {
  const next: Record<string, string> = {};
  if (form.customerId.trim() === '') {
    next.customerId = '请填写客户 ID';
  }
  if (form.contractItemId.trim() === '') {
    next.contractItemId = '请填写来源合同条目 ID（来源合同必须已生效）';
  }
  if (form.deploymentInstanceId.trim() === '') {
    next.deploymentInstanceId = '私有授权必须关联部署实例';
  }
  if (!form.validFrom) {
    next.validFrom = '请选择生效日';
  }
  const term = validateLicenseTerm({
    licenseMode: form.licenseMode,
    validFrom: form.validFrom?.format('YYYY-MM-DD'),
    validTo: form.validTo?.format('YYYY-MM-DD'),
  });
  if (!term.allowed) {
    next.validTo = term.message ?? '授权期限不合法';
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
  const validFrom = form.validFrom;
  if (!validFrom) {
    // validate() 已保证非空；显式分支替代非空断言
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const result = await createLicense({
      contractItemId: form.contractItemId.trim(),
      customerId: form.customerId.trim(),
      deploymentInstanceId: form.deploymentInstanceId.trim(),
      features: form.features.map((feature) => ({
        displayName: feature.displayName?.trim() || feature.featureKey,
        enabled: feature.enabled,
        featureKey: feature.featureKey.trim(),
        quota: feature.quota ?? null,
        termMonths: feature.termMonths ?? null,
      })),
      licenseMode: form.licenseMode,
      validFrom: validFrom.format('YYYY-MM-DD'),
      ...(form.maintenanceUntil
        ? { maintenanceUntil: form.maintenanceUntil.format('YYYY-MM-DD') }
        : {}),
      ...(form.licenseMode === 'term' && form.validTo
        ? { validTo: form.validTo.format('YYYY-MM-DD') }
        : {}),
    });
    message.success(
      `授权 ${result.license.licenseNo} 已创建为草稿，提交审批并通过后才会生效`,
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
    title="创建私有授权草稿"
    @cancel="onCancel"
  >
    <Alert
      class="mb-3"
      message="永久授权只表示软件使用无到期日，不代表包含永久更新；维护期请单独填写，到期后不再包含版本更新与技术支持。"
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
        <div class="mb-1 text-xs text-muted-foreground">部署实例 ID</div>
        <Input
          v-model:value="form.deploymentInstanceId"
          :status="errors.deploymentInstanceId ? 'error' : undefined"
          placeholder="私有化部署实例 ID"
        />
        <p v-if="errors.deploymentInstanceId" class="mt-1 text-xs text-red-500">
          {{ errors.deploymentInstanceId }}
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
        <div class="mb-1 text-xs text-muted-foreground">授权方式</div>
        <Select
          v-model:value="form.licenseMode"
          :options="LICENSE_MODE_OPTIONS"
          style="width: 100%"
        />
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">生效日</div>
        <DatePicker
          v-model:value="form.validFrom"
          :status="errors.validFrom ? 'error' : undefined"
          style="width: 100%"
        />
        <p v-if="errors.validFrom" class="mt-1 text-xs text-red-500">
          {{ errors.validFrom }}
        </p>
      </div>
      <div>
        <div class="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>到期日</span>
          <Tag v-if="perpetual">永久授权必须留空</Tag>
        </div>
        <DatePicker
          v-model:value="form.validTo"
          :disabled="perpetual"
          :status="errors.validTo ? 'error' : undefined"
          style="width: 100%"
        />
        <p v-if="errors.validTo" class="mt-1 text-xs text-red-500">
          {{ errors.validTo }}
        </p>
      </div>
      <div>
        <div class="mb-1 text-xs text-muted-foreground">
          维护期至（与授权期限独立）
        </div>
        <DatePicker v-model:value="form.maintenanceUntil" style="width: 100%" />
      </div>
    </div>

    <div class="mt-3">
      <div class="mb-1 text-xs text-muted-foreground">
        权益行（将生成首个快照）
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
