<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type {
  DeploymentErrorView,
  DeploymentInstance,
  UpdateDeploymentInput,
} from '#/api/ops/deployment';

import { reactive, ref, watch } from 'vue';

import { Alert, DatePicker, Input, Modal } from 'ant-design-vue';

defineOptions({ name: 'DeploymentEditModal' });

/**
 * 编辑实例基础信息（契约 §5.8 `PATCH /deployments/{id}`）。
 *
 * 可编辑字段**不含** `status` 与 `currentVersion`：
 * - 状态只能走 `transition`（契约 §3.7 状态机）；
 * - 当前版本只能由升级登记推进（§5.8 version-records 响应回带 `currentVersion`）。
 *
 * `version` 必须回传（乐观锁）；409 `CONFLICT` 由页面走「刷新后重试」。
 */
const props = defineProps<{
  error?: DeploymentErrorView | null;
  instance: DeploymentInstance | null;
  open: boolean;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  submit: [UpdateDeploymentInput];
  'update:open': [boolean];
}>();

const form = reactive({
  environmentRef: '',
  goLiveOn: undefined as Dayjs | undefined,
  maintenanceUntil: undefined as Dayjs | undefined,
  name: '',
  ownerOperatorId: '',
});

const localError = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    const instance = props.instance;
    form.name = instance?.name ?? '';
    form.environmentRef = instance?.environmentRef ?? '';
    form.goLiveOn = undefined;
    form.maintenanceUntil = undefined;
    form.ownerOperatorId = instance?.owner?.id ?? '';
    localError.value = '';
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
  if (!props.instance) {
    localError.value = '缺少实例数据，请刷新后重试';
    return;
  }
  if (form.name.trim() === '') {
    localError.value = '实例名称不能为空';
    return;
  }
  emit('submit', {
    environmentRef: form.environmentRef.trim(),
    goLiveOn: form.goLiveOn?.format('YYYY-MM-DD') ?? undefined,
    maintenanceUntil: form.maintenanceUntil?.format('YYYY-MM-DD') ?? undefined,
    name: form.name.trim(),
    ownerOperatorId: form.ownerOperatorId.trim() || null,
    version: props.instance.version ?? 0,
  });
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    ok-text="保存"
    :open="open"
    title="编辑实例基础信息"
    :width="620"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="状态与当前版本不在此处修改：状态走「状态动作」，当前版本只能通过登记升级结果推进。"
        show-icon
        type="info"
      />

      <div class="grid grid-cols-2 gap-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">实例名称</div>
          <Input v-model:value="form.name" data-testid="deployment-edit-name" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            客户环境标识（可读标识，不是地址）
          </div>
          <Input v-model:value="form.environmentRef" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            上线日期（登记上线前必填）
          </div>
          <DatePicker v-model:value="form.goLiveOn" class="w-full" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            维护期至（决定是否包含升级与支持）
          </div>
          <DatePicker v-model:value="form.maintenanceUntil" class="w-full" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            负责人（运营成员 ID）
          </div>
          <Input v-model:value="form.ownerOperatorId" />
        </div>
      </div>

      <p
        v-if="localError"
        class="text-xs text-red-500"
        data-testid="deployment-edit-error"
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

      <p class="text-xs text-muted-foreground">
        留空的日期表示「不修改」；如需清空维护期，请与后端确认可空语义后再操作。
      </p>
    </div>
  </Modal>
</template>
