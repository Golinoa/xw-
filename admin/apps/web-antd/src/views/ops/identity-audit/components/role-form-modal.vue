<script lang="ts" setup>
/**
 * 角色创建 / 编辑（契约 §5.1 `POST /roles`、`PATCH /roles/{roleId}`）。
 *
 * 三条约束：
 * 1. **系统角色不可改 code**：`isSystem=true` 时 code 只读；后端仍会拒绝改 code 的请求，
 *    前端只读只是避免让管理员白填一遍。
 * 2. **变更前后权限必须展示**：编辑态下方列出「新增 / 移除」的动作码，让人提交前就知道
 *    这次改动会让多少人获得或失去什么能力（契约 §3.9 要求把前后摘要写进审计）。
 * 3. **原因必填**：`role.manage` 属高风险动作。
 */
import type {
  IdentityErrorView,
  OpsPermissionItem,
  OpsRoleDetail,
} from '#/api/ops/identity';

import { computed, ref, watch } from 'vue';

import { Alert, Input, Modal, Select, Tag } from 'ant-design-vue';

import {
  diffPermissions,
  hasPermissionChange,
  summarizePermissionDiff,
  validateReason,
} from '../governance';
import PermissionPicker from './permission-picker.vue';

defineOptions({ name: 'GovernanceRoleFormModal' });

const props = withDefaults(
  defineProps<{
    catalog: OpsPermissionItem[];
    error: IdentityErrorView | null;
    mode: 'create' | 'edit';
    open: boolean;
    role?: null | OpsRoleDetail;
    submitting?: boolean;
  }>(),
  { role: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [
    payload: {
      code?: string;
      description?: string;
      name: string;
      permissionCodes: string[];
      reason: string;
      status?: 'active' | 'disabled';
    },
  ];
}>();

const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

const code = ref('');
const name = ref('');
const description = ref('');
const status = ref<'active' | 'disabled'>('active');
const permissionCodes = ref<string[]>([]);
const reason = ref('');
const localError = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    code.value = props.role?.code ?? '';
    name.value = props.role?.name ?? '';
    description.value = props.role?.description ?? '';
    status.value = props.role?.status ?? 'active';
    permissionCodes.value = [...(props.role?.permissions ?? [])];
    reason.value = '';
    localError.value = null;
  },
);

const isEdit = computed(() => props.mode === 'edit');
const codeLocked = computed(
  () => isEdit.value && Boolean(props.role?.isSystem),
);

const permissionDiff = computed(() =>
  diffPermissions(props.role?.permissions ?? [], permissionCodes.value),
);

const statusOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

function onOk() {
  if (props.submitting) {
    return;
  }
  const trimmedName = name.value.trim();
  if (trimmedName === '') {
    localError.value = '请填写角色名称';
    return;
  }
  if (!isEdit.value) {
    const trimmedCode = code.value.trim();
    if (!ROLE_CODE_PATTERN.test(trimmedCode)) {
      localError.value =
        '角色 code 需为 3–32 位小写字母开头，仅含小写字母、数字与下划线（创建后不可修改）';
      return;
    }
  }
  if (permissionCodes.value.length === 0) {
    localError.value = '请至少勾选一个权限动作码';
    return;
  }
  const reasonError = validateReason(reason.value);
  if (reasonError) {
    localError.value = reasonError;
    return;
  }
  if (isEdit.value && !hasPermissionChange(permissionDiff.value)) {
    localError.value = '权限未变更，请调整后再提交';
    return;
  }
  localError.value = null;
  emit('submit', {
    ...(isEdit.value ? {} : { code: code.value.trim() }),
    description:
      description.value.trim() === '' ? undefined : description.value.trim(),
    name: trimmedName,
    permissionCodes: [...permissionCodes.value].toSorted(),
    reason: reason.value.trim(),
    status: status.value,
  });
}

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('cancel');
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    :ok-text="isEdit ? '保存变更' : '创建角色'"
    :open="open"
    :title="isEdit ? `编辑角色：${role?.name ?? ''}` : '新建角色'"
    :width="760"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="text-sm text-foreground">角色 code</span>
            <Tag v-if="!isEdit" color="orange">必填</Tag>
          </div>
          <Input
            v-model:value="code"
            :disabled="isEdit"
            placeholder="例如 audit_temp"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            <span v-if="codeLocked">系统角色不可修改 code。</span>
            <span v-else-if="isEdit"
              >code 创建后不可修改（后端以 code 做唯一键）。</span
            >
            <span v-else
              >小写字母开头，3–32 位，仅含小写字母、数字与下划线。</span
            >
          </p>
        </div>
        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="text-sm text-foreground">角色名称</span>
            <Tag color="orange">必填</Tag>
          </div>
          <Input v-model:value="name" placeholder="例如 临时审计" />
        </div>
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">描述（选填）</div>
        <Input
          v-model:value="description"
          :maxlength="200"
          placeholder="说明这个角色负责什么，便于同事判断该不该授予"
        />
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">状态</div>
        <Select v-model:value="status" class="w-40" :options="statusOptions" />
        <p class="mt-1 text-xs text-muted-foreground">
          停用角色后，持有该角色的成员会立即失去对应动作码（服务端每次请求重新判定）。
        </p>
      </div>

      <div>
        <div class="mb-2 flex items-center gap-2">
          <span class="text-sm text-foreground">权限动作码</span>
          <Tag color="orange">至少一个</Tag>
        </div>
        <PermissionPicker v-model="permissionCodes" :catalog="catalog" />
      </div>

      <Alert
        v-if="isEdit"
        :message="`本次改动：${summarizePermissionDiff(permissionDiff)}`"
        show-icon
        type="info"
      >
        <template #description>
          <div v-if="permissionDiff.added.length > 0" class="mt-1">
            <span class="text-xs">新增：</span>
            <Tag
              v-for="item in permissionDiff.added"
              :key="item"
              class="mb-1"
              color="green"
            >
              {{ item }}
            </Tag>
          </div>
          <div v-if="permissionDiff.removed.length > 0" class="mt-1">
            <span class="text-xs">移除：</span>
            <Tag
              v-for="item in permissionDiff.removed"
              :key="item"
              class="mb-1"
              color="red"
            >
              {{ item }}
            </Tag>
          </div>
          <p class="mt-1 text-xs text-muted-foreground">
            前后权限摘要会写入审计日志（契约 §3.9）。
          </p>
        </template>
      </Alert>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">变更原因</span>
          <Tag color="red">高风险动作</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="200"
          :rows="2"
          placeholder="例如：审计巡检需要查看操作日志"
        />
      </div>

      <Alert v-if="localError" :message="localError" show-icon type="warning" />

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <p>{{ error.description }}</p>
          <p v-if="error.requestId" class="mt-1 text-xs">
            请求 ID：{{ error.requestId }}
          </p>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
