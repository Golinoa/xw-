<script lang="ts" setup>
/**
 * 邀请运营成员（契约 §5.1 `POST /operators/invitations`）。
 *
 * 这是高风险动作 `operator.manage`：必须填原因、写审计、二次确认（弹窗本身即确认步骤）。
 *
 * 一条容易误解的语义：**邀请成功 ≠ 账号可用**。后端只发出邀请（service_role），
 * 被邀请人需自行完成注册。因此成功提示统一说「邀请已发出」，不说「已开通」。
 */
import type {
  IdentityErrorView,
  InviteOperatorPayload,
  OpsRoleDetail,
} from '#/api/ops/identity';

import { computed, ref, watch } from 'vue';

import { Alert, Descriptions, Input, Modal, Select, Tag } from 'ant-design-vue';

import { validateReason, validateRoleSelection } from '../governance';

defineOptions({ name: 'GovernanceOperatorInviteModal' });

const props = withDefaults(
  defineProps<{
    error: IdentityErrorView | null;
    open: boolean;
    roles: OpsRoleDetail[];
    submitting?: boolean;
  }>(),
  { submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [payload: InviteOperatorPayload];
}>();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const email = ref('');
const roleCodes = ref<string[]>([]);
const reason = ref('');
const localError = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (open) {
      email.value = '';
      roleCodes.value = [];
      reason.value = '';
      localError.value = null;
    }
  },
);

const roleOptions = computed(() =>
  props.roles
    .filter((role) => role.status === 'active')
    .map((role) => ({
      label: `${role.name}（${role.code}）`,
      value: role.code,
    })),
);

const selectedRoles = computed(() =>
  roleCodes.value.flatMap((code) => {
    const role = props.roles.find((item) => item.code === code);
    return role ? [role] : [];
  }),
);

/** 提示用：邀请后这些人将获得的权限条数（并集，仅预览）。 */
const permissionPreview = computed(() => {
  const codes = new Set<string>();
  for (const role of selectedRoles.value) {
    for (const code of role.permissions) {
      codes.add(code);
    }
  }
  return codes.size;
});

function onOk() {
  if (props.submitting) {
    return;
  }
  const trimmedEmail = email.value.trim();
  if (!EMAIL_PATTERN.test(trimmedEmail)) {
    localError.value = '请填写有效的邮箱地址（邀请将发送到该邮箱）';
    return;
  }
  const roleError = validateRoleSelection(roleCodes.value);
  if (roleError) {
    localError.value = roleError;
    return;
  }
  const reasonError = validateReason(reason.value);
  if (reasonError) {
    localError.value = reasonError;
    return;
  }
  localError.value = null;
  emit('submit', {
    email: trimmedEmail,
    reason: reason.value.trim(),
    roleCodes: [...roleCodes.value],
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
    ok-text="发出邀请"
    :open="open"
    title="邀请运营成员"
    :width="600"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="邀请发出后对方需自行注册才能登录，邀请成功不等于账号已开通。"
        show-icon
        type="info"
      />

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">邮箱</span>
          <Tag color="orange">必填</Tag>
        </div>
        <Input
          v-model:value="email"
          data-testid="operator-invite-email"
          placeholder="例如：ops.zhang@example.com"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          同一邮箱只能存在一个运营账号（重复邀请返回 409）。
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">初始角色</span>
          <Tag color="orange">至少一个</Tag>
        </div>
        <Select
          v-model:value="roleCodes"
          class="w-full"
          mode="multiple"
          :options="roleOptions"
          option-filter-prop="label"
          placeholder="选择角色（可多选，权限取并集）"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          已停用的角色不可分配。多角色按动作码并集生效。
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">邀请原因</span>
          <Tag color="red">高风险动作</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="200"
          :rows="2"
          placeholder="例如：新同事入职，需要交付与售后权限"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          原因会写入审计日志（不可修改、不可删除）。
        </p>
      </div>

      <Descriptions
        v-if="selectedRoles.length > 0"
        bordered
        size="small"
        :column="1"
      >
        <Descriptions.Item label="权限预览">
          {{ selectedRoles.map((role) => role.name).join(' + ') }} →
          {{ permissionPreview }} 个动作码
          <span class="text-xs text-muted-foreground">
            （按角色并集估算，实际授权以服务端判定为准）
          </span>
        </Descriptions.Item>
      </Descriptions>

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
