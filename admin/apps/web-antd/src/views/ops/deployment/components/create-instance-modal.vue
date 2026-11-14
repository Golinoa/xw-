<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type {
  CreateDeploymentInput,
  DeploymentErrorView,
  DeploymentType,
} from '#/api/ops/deployment';

import { reactive, ref, watch } from 'vue';

import { Alert, DatePicker, Input, Modal, Select } from 'ant-design-vue';

import { DEPLOYMENT_TYPE_OPTIONS } from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentCreateModal' });

/**
 * 创建部署实例（状态直接落 `planned`，契约 §3.7 状态机第一行）。
 *
 * 校验只拦「必然被服务端拒绝」的必填项（客户、名称、部署类型）；
 * 同客户同名（`UNIQUE(customer_id, name)`）由服务端 409 `CONFLICT` 返回，
 * 页面刷新列表后改名重试——前端**不**做唯一性猜测。
 */
const props = defineProps<{
  error?: DeploymentErrorView | null;
  open: boolean;
  submitting?: boolean;
}>();

const emit = defineEmits<{
  submit: [CreateDeploymentInput];
  'update:open': [boolean];
}>();

const form = reactive({
  currentVersion: '',
  customerId: '',
  deploymentType: 'private' as DeploymentType,
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
    if (open) {
      form.currentVersion = '';
      form.customerId = '';
      form.deploymentType = 'private';
      form.environmentRef = '';
      form.goLiveOn = undefined;
      form.maintenanceUntil = undefined;
      form.name = '';
      form.ownerOperatorId = '';
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
  if (form.customerId.trim() === '') {
    localError.value = '请填写客户（customerId）';
    return;
  }
  if (form.name.trim() === '') {
    localError.value = '请填写实例名称';
    return;
  }
  emit('submit', {
    currentVersion: form.currentVersion.trim() || undefined,
    customerId: form.customerId.trim(),
    deploymentType: form.deploymentType,
    environmentRef: form.environmentRef.trim() || undefined,
    goLiveOn: form.goLiveOn?.format('YYYY-MM-DD'),
    maintenanceUntil: form.maintenanceUntil?.format('YYYY-MM-DD'),
    name: form.name.trim(),
    ownerOperatorId: form.ownerOperatorId.trim() || undefined,
  });
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    ok-text="创建实例"
    :open="open"
    title="新建部署实例"
    :width="640"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="实例台账只登记事实：不保存 SSH 密钥、数据库口令、主机 root 凭据或任何可直接登录客户环境的秘密。"
        show-icon
        type="info"
      />

      <div class="grid grid-cols-2 gap-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
          <Input
            v-model:value="form.customerId"
            data-testid="deployment-create-customer"
            placeholder="按客户 ID 精确绑定"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">实例名称</div>
          <Input
            v-model:value="form.name"
            data-testid="deployment-create-name"
            placeholder="同客户下名称唯一"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">部署类型</div>
          <Select
            v-model:value="form.deploymentType"
            :options="DEPLOYMENT_TYPE_OPTIONS"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            客户环境标识（可读标识，不是地址）
          </div>
          <Input
            v-model:value="form.environmentRef"
            placeholder="如：客户自建机房 A（不要填 IP/域名）"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">当前版本（可空）</div>
          <Input
            v-model:value="form.currentVersion"
            placeholder="如 v1.2.3，原样记录"
          />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">上线日期（可空）</div>
          <DatePicker v-model:value="form.goLiveOn" class="w-full" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            维护期至（可空，决定是否包含升级与支持）
          </div>
          <DatePicker v-model:value="form.maintenanceUntil" class="w-full" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">负责人（可空）</div>
          <Input
            v-model:value="form.ownerOperatorId"
            placeholder="负责该实例的运营成员 ID"
          />
        </div>
      </div>

      <p
        v-if="localError"
        class="text-xs text-red-500"
        data-testid="deployment-create-error"
      >
        {{ localError }}
      </p>

      <Alert
        v-if="props.error"
        :message="props.error.title"
        show-icon
        type="error"
      >
        <template #description>
          <div class="space-y-1">
            <p>{{ props.error.description }}</p>
            <p v-if="props.error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{
                props.error.requestId
              }}</span>
            </p>
          </div>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
