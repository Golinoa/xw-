<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type {
  CreateVersionRecordInput,
  DeploymentErrorView,
  DeploymentVersionRecord,
} from '#/api/ops/deployment';

import { reactive, ref, watch } from 'vue';

import { Alert, DatePicker, Input, Modal, Select, Tag } from 'ant-design-vue';

import {
  validateVersionRecordInput,
  VERSION_RESULT_OPTIONS,
  versionText,
} from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentVersionRecordModal' });

/**
 * 升级结果登记（契约 §5.8 `POST /deployments/{id}/version-records`）。
 *
 * 两个不可让步的点：
 * 1. 这是**事后登记**，不是远程升级：文案里不出现「立即升级/执行安装」，
 *    也不允许声称后台完成了部署（PRD §6.8）；
 * 2. `fromVersion` 由实例当前版本锁定（只读）。契约要求它与当前版本一致，
 *    否则服务端 409 `STATE_CONFLICT` + `VERSION_MISMATCH`；锁定后仍可能在提交瞬间
 *    被他人推进，因此 409 由页面走「刷新后重试」分支。
 */
const props = withDefaults(
  defineProps<{
    currentVersion?: null | string;
    error?: DeploymentErrorView | null;
    open: boolean;
    submitting?: boolean;
  }>(),
  { currentVersion: null, error: null, submitting: false },
);

const emit = defineEmits<{
  submit: [CreateVersionRecordInput];
  'update:open': [boolean];
}>();

const form = reactive({
  executedOn: undefined as Dayjs | undefined,
  impactNote: '',
  result: 'succeeded' as DeploymentVersionRecord['result'],
  rollbackNote: '',
  toVersion: '',
});

const localError = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) {
      form.executedOn = undefined;
      form.impactNote = '';
      form.result = 'succeeded';
      form.rollbackNote = '';
      form.toVersion = '';
      localError.value = '';
    }
  },
);

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('update:open', false);
}

function onOk() {
  localError.value = '';
  const executedOn = form.executedOn?.format('YYYY-MM-DD') ?? '';
  const decision = validateVersionRecordInput({
    currentVersion: props.currentVersion ?? null,
    executedOn,
    fromVersion: props.currentVersion ?? '',
    toVersion: form.toVersion,
  });
  if (!decision.allowed) {
    localError.value = decision.message ?? '请检查填写内容';
    return;
  }
  emit('submit', {
    executedOn,
    fromVersion: (props.currentVersion ?? '').trim(),
    impactNote: form.impactNote.trim() || undefined,
    result: form.result,
    rollbackNote: form.rollbackNote.trim() || undefined,
    toVersion: form.toVersion.trim(),
  });
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    ok-text="登记升级结果"
    :open="open"
    title="登记升级结果（事后登记，不会执行远程升级）"
    :width="640"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="本操作只登记已由人工在客户环境完成的升级结果；后台不会连接客户环境、不保存任何远程登录凭据。"
        show-icon
        type="info"
      />

      <div class="grid grid-cols-2 gap-3">
        <div>
          <div
            class="mb-1 flex items-center gap-2 text-xs text-muted-foreground"
          >
            <span>升级前版本</span>
            <Tag color="default">锁定为实例当前版本</Tag>
          </div>
          <Input :value="versionText(currentVersion)" disabled />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">升级后版本</div>
          <Input
            v-model:value="form.toVersion"
            data-testid="deployment-to-version"
            placeholder="如 v1.2.4（原样记录，不做解析）"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">执行日期</div>
          <DatePicker
            v-model:value="form.executedOn"
            class="w-full"
            placeholder="选择实际执行日期"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">执行结果</div>
          <Select
            v-model:value="form.result"
            :options="
              VERSION_RESULT_OPTIONS.map((item) => ({
                label: item.label,
                value: item.value,
              }))
            "
          />
          <p class="mt-1 text-xs text-muted-foreground">
            {{
              VERSION_RESULT_OPTIONS.find((item) => item.value === form.result)
                ?.description
            }}
          </p>
        </div>
      </div>

      <div>
        <div class="mb-1 text-xs text-muted-foreground">影响说明（选填）</div>
        <Input.TextArea
          v-model:value="form.impactNote"
          :maxlength="500"
          :rows="2"
          placeholder="本次升级影响的功能、停机窗口或客户反馈"
          show-count
        />
      </div>

      <div v-if="form.result !== 'succeeded'">
        <div class="mb-1 text-xs text-muted-foreground">回滚备注（选填）</div>
        <Input.TextArea
          v-model:value="form.rollbackNote"
          :maxlength="500"
          :rows="2"
          placeholder="回滚方式、回滚后停留的版本、待跟进事项"
          show-count
        />
      </div>

      <p
        v-if="localError"
        class="text-xs text-red-500"
        data-testid="deployment-version-form-error"
      >
        {{ localError }}
      </p>

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <div class="space-y-1">
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
            </p>
          </div>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
