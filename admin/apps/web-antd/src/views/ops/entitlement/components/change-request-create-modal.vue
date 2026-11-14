<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  ChangeRequestType,
  CreateChangeRequestInput,
  CreateChangeRequestResult,
  EntitlementDiff,
  EntitlementFeatureInput,
  EntitlementSnapshotLine,
  EntitlementSubjectType,
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
  CHANGE_REQUEST_TYPE_OPTIONS,
  changeTypeLabel,
  describeEntitlementError,
} from '#/api/ops/entitlement';
import {
  createLicenseChangeRequest,
  createSubscriptionChangeRequest,
} from '#/api/ops/entitlement/change-requests';

import ChangeRequestDiff from './change-request-diff.vue';
import FeatureEditor from './feature-editor.vue';

defineOptions({ name: 'EntitlementChangeRequestCreateModal' });

/**
 * 变更申请创建（契约 §5.6 `POST /subscriptions|licenses/{id}/change-requests`）。
 *
 * 流程：填写（类型 / 原因 / 权益行）→ **本地差异预览** → 提交。
 * 本地预览只用当前快照行与新行做展示性对比，明确标注「提交后以服务端
 * `before_summary`/`after_summary` 为准」，不冒充服务端计算结果。
 */
const props = defineProps<{
  currentFeatures: EntitlementSnapshotLine[];
  initialChangeType?: ChangeRequestType | null;
  open: boolean;
  subjectId: string;
  subjectNo: string;
  subjectType: EntitlementSubjectType;
}>();

const emit = defineEmits<{
  created: [CreateChangeRequestResult];
  'update:open': [boolean];
}>();

const step = ref<'edit' | 'preview'>('edit');
const submitting = ref(false);
const error = shallowRef<EntitlementErrorView | null>(null);
const form = reactive({
  changeType: 'quota_change' as ChangeRequestType,
  effectiveOn: undefined as Dayjs | undefined,
  features: [] as EntitlementFeatureInput[],
  reason: '',
});
const formErrors = ref<Record<string, string>>({});

function featuresFromSnapshot(
  lines: EntitlementSnapshotLine[],
): EntitlementFeatureInput[] {
  return lines.map((line) => ({
    displayName: line.displayNameSnapshot,
    enabled: line.enabled,
    featureKey: line.featureKey,
    quota: line.quota,
    termMonths: line.termMonths,
  }));
}

function reset(): void {
  step.value = 'edit';
  error.value = null;
  formErrors.value = {};
  form.changeType = props.initialChangeType ?? 'quota_change';
  form.effectiveOn = undefined;
  form.reason = '';
  form.features = featuresFromSnapshot(props.currentFeatures);
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
    }
  },
);

/** 本地差异预览：仅展示，不做额度运算（数值原样并列）。 */
const localDiff = computed<EntitlementDiff>(() => ({
  after: {
    features: form.features.map((feature) => ({
      displayName: feature.displayName,
      enabled: feature.enabled,
      featureKey: feature.featureKey,
      quota: feature.quota ?? null,
      termMonths: feature.termMonths ?? null,
    })),
  },
  before: {
    features: props.currentFeatures.map((line) => ({
      displayName: line.displayNameSnapshot,
      enabled: line.enabled,
      featureKey: line.featureKey,
      quota: line.quota,
      termMonths: line.termMonths,
    })),
  },
}));

function validate(): boolean {
  const errors: Record<string, string> = {};
  if (form.reason.trim() === '') {
    errors.reason = '请填写变更原因（会写入审计，审批人据此判断）';
  }
  if (form.features.length === 0) {
    errors.features = '请至少保留一个权益行';
  }
  const keys = form.features.map((feature) => feature.featureKey.trim());
  if (keys.includes('')) {
    errors.features = '功能键不能为空';
  }
  if (new Set(keys).size !== keys.length) {
    errors.features = '功能键不能重复';
  }
  formErrors.value = errors;
  return Object.keys(errors).length === 0;
}

function goPreview(): void {
  if (!validate()) {
    return;
  }
  step.value = 'preview';
}

async function submit(): Promise<void> {
  if (submitting.value) {
    return;
  }
  if (!validate()) {
    step.value = 'edit';
    return;
  }
  const input: CreateChangeRequestInput = {
    changeType: form.changeType,
    proposedFeatures: form.features.map((feature) => ({
      displayName: feature.displayName?.trim() || feature.featureKey,
      enabled: feature.enabled,
      featureKey: feature.featureKey.trim(),
      quota: feature.quota ?? null,
      termMonths: feature.termMonths ?? null,
    })),
    reason: form.reason.trim(),
    ...(form.effectiveOn
      ? { effectiveOn: form.effectiveOn.format('YYYY-MM-DD') }
      : {}),
  };

  submitting.value = true;
  error.value = null;
  try {
    const result =
      props.subjectType === 'subscription'
        ? await createSubscriptionChangeRequest(props.subjectId, input)
        : await createLicenseChangeRequest(props.subjectId, input);
    message.success(
      `变更申请已提交（待审批）：${changeTypeLabel(result.changeRequest.changeType)}`,
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
    :title="`发起权益变更 · ${subjectNo}`"
    :width="900"
    destroy-on-close
    @cancel="onCancel"
  >
    <Alert
      class="mb-3"
      message="变更申请提交后进入「待审批」，审批通过后才能执行并下发同步命令；界面不会直接改写订阅/授权状态。"
      show-icon
      type="info"
    />

    <template v-if="step === 'edit'">
      <div class="grid gap-3 md:grid-cols-2">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">变更类型</div>
          <Select
            v-model:value="form.changeType"
            :options="CHANGE_REQUEST_TYPE_OPTIONS"
            style="width: 100%"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            暂停 / 撤销属于高风险缩权，执行前会再次二次确认。
          </p>
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">生效日（可空）</div>
          <DatePicker v-model:value="form.effectiveOn" style="width: 100%" />
        </div>
      </div>

      <div class="mt-3">
        <div class="mb-1 flex items-center gap-2">
          <span class="text-xs text-muted-foreground">变更原因</span>
          <Tag color="red">必填</Tag>
        </div>
        <Input.TextArea
          v-model:value="form.reason"
          :maxlength="500"
          :rows="2"
          :status="formErrors.reason ? 'error' : undefined"
          placeholder="例如：客户新增两个门店，导游排班账号额度需要从 30 调整为 60"
          show-count
        />
        <p v-if="formErrors.reason" class="mt-1 text-xs text-red-500">
          {{ formErrors.reason }}
        </p>
      </div>

      <div class="mt-3">
        <div class="mb-1 text-xs text-muted-foreground">
          变更后的权益行（初始为当前快照，可修改后提交）
        </div>
        <FeatureEditor v-model="form.features" />
        <p v-if="formErrors.features" class="mt-1 text-xs text-red-500">
          {{ formErrors.features }}
        </p>
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <Button @click="onCancel">取消</Button>
        <Button type="primary" @click="goPreview">预览差异</Button>
      </div>
    </template>

    <template v-else>
      <Alert
        class="mb-2"
        message="以下为本地预览：提交后以服务端 before_summary / after_summary 为准"
        show-icon
        type="warning"
      />
      <ChangeRequestDiff :diff="localDiff" />

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

      <div class="mt-4 flex justify-between">
        <Button :disabled="submitting" @click="step = 'edit'">返回修改</Button>
        <div class="flex gap-2">
          <Button :disabled="submitting" @click="onCancel">取消</Button>
          <Button :loading="submitting" type="primary" @click="submit">
            提交审批
          </Button>
        </div>
      </div>
    </template>
  </Modal>
</template>
