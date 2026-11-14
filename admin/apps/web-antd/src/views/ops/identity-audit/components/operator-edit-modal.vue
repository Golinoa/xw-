<script lang="ts" setup>
/**
 * 修改运营成员（契约 §5.1 `PATCH /operators/{operatorId}`）。
 *
 * 覆盖状态：validation（本地必填）/ conflict（409 版本过期，必须刷新）/ state-conflict
 * （`LAST_ROLE` / `LAST_ADMIN`，属于正确的拒绝，不是故障）。
 *
 * 三条硬约束：
 * 1. **必须带 `version`**：没有版本号就不提交（按钮在列表页已按此禁用，这里再拦一次，
 *    防止弹窗被复用时绕过）。不带版本的 PATCH 等于「无条件覆盖」，会冲掉别人的改动。
 * 2. **至少保留一个角色**：本地先拦一次，服务端还会再判（`STATE_CONFLICT` + `LAST_ROLE`）。
 * 3. **`mfaRequired` 未返回时不冒充已开启**：界面上明确写「后端未返回当前值」，
 *    避免把已开启 MFA 的账号显示为未开启。
 */
import type {
  IdentityErrorView,
  OpsOperatorListItem,
  OpsOperatorStatus,
  OpsRoleDetail,
  UpdateOperatorPayload,
} from '#/api/ops/identity';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Descriptions,
  Input,
  Modal,
  Select,
  Switch,
  Tag,
} from 'ant-design-vue';

import { operatorStatusView } from '#/api/ops/identity';

import {
  diffPermissions,
  mfaValueTrusted,
  permissionCodesOfRoles,
  summarizePermissionDiff,
  validateReason,
  validateRoleSelection,
} from '../governance';

defineOptions({ name: 'GovernanceOperatorEditModal' });

const props = withDefaults(
  defineProps<{
    error: IdentityErrorView | null;
    open: boolean;
    operator?: null | OpsOperatorListItem;
    roles: OpsRoleDetail[];
    submitting?: boolean;
  }>(),
  { operator: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  refresh: [];
  submit: [payload: UpdateOperatorPayload];
}>();

const STATUS_OPTIONS: { label: string; value: OpsOperatorStatus }[] = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

const status = ref<OpsOperatorStatus>('active');
const roleCodes = ref<string[]>([]);
const mfaRequired = ref(false);
const reason = ref('');
const localError = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (open && props.operator) {
      status.value = props.operator.status;
      roleCodes.value = props.operator.roles.map((role) => role.code);
      mfaRequired.value = props.operator.mfaRequired ?? false;
      reason.value = '';
      localError.value = null;
    }
  },
);

const mfaTrusted = computed(() =>
  props.operator ? mfaValueTrusted(props.operator) : false,
);

const version = computed<null | number>(() =>
  typeof props.operator?.version === 'number' ? props.operator.version : null,
);

const originalRoleCodes = computed<string[]>(
  () => props.operator?.roles.map((role) => role.code) ?? [],
);

const beforePermissions = computed(() =>
  permissionCodesOfRoles(props.roles, originalRoleCodes.value),
);
const afterPermissions = computed(() =>
  permissionCodesOfRoles(props.roles, roleCodes.value),
);
const permissionDiff = computed(() =>
  diffPermissions(beforePermissions.value, afterPermissions.value),
);

const roleOptions = computed(() =>
  props.roles.map((role) => ({
    disabled: role.status !== 'active',
    label: role.status === 'active' ? role.name : `${role.name}（已停用）`,
    value: role.code,
  })),
);

const noChange = computed(() => {
  const sameRoles =
    [...roleCodes.value].toSorted().join(',') ===
    [...originalRoleCodes.value].toSorted().join(',');
  const sameStatus = status.value === props.operator?.status;
  const sameMfa = mfaRequired.value === (props.operator?.mfaRequired ?? false);
  return sameRoles && sameStatus && sameMfa;
});

function onOk() {
  if (props.submitting) {
    return;
  }
  if (version.value === null) {
    localError.value =
      '后端未返回乐观锁版本（version），无法安全提交；请刷新后重试或联系后端补充该字段';
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
  if (noChange.value) {
    localError.value = '没有任何改动，无需提交';
    return;
  }
  localError.value = null;
  emit('submit', {
    mfaRequired: mfaRequired.value,
    reason: reason.value.trim(),
    roleCodes: [...roleCodes.value],
    status: status.value,
    version: version.value,
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
    ok-text="提交变更"
    :open="open"
    title="修改运营成员"
    :width="640"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div v-if="operator" class="space-y-4">
      <Descriptions bordered size="small" :column="2">
        <Descriptions.Item label="成员">
          {{ operator.displayName }}
        </Descriptions.Item>
        <Descriptions.Item label="邮箱">
          {{ operator.email }}
        </Descriptions.Item>
        <Descriptions.Item label="当前状态">
          <Tag :color="operatorStatusView(operator.status).color">
            {{ operatorStatusView(operator.status).label }}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="乐观锁版本">
          <span v-if="version !== null" class="font-mono">{{ version }}</span>
          <Tag v-else color="red">未返回</Tag>
        </Descriptions.Item>
      </Descriptions>

      <Alert
        v-if="version === null"
        message="后端未返回 version，无法提交修改"
        description="`PATCH /operators/{operatorId}` 要求 version 必填，但 `GET /operators` 列表项没有该字段，也没有详情端点。没有版本号提交等于无条件覆盖，会冲掉别人的改动，因此这里禁止提交。"
        show-icon
        type="error"
      />

      <div>
        <div class="mb-1 text-sm text-foreground">状态</div>
        <Select v-model:value="status" class="w-52" :options="STATUS_OPTIONS" />
        <p class="mt-1 text-xs text-muted-foreground">
          停用后该账号所有请求立即被拒绝（权限不缓存在 token 里，契约 §3.9）。
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">角色</span>
          <Tag color="orange">至少一个</Tag>
        </div>
        <Select
          v-model:value="roleCodes"
          class="w-full"
          mode="multiple"
          :options="roleOptions"
          option-filter-prop="label"
        />
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">强制二次认证（MFA）</div>
        <div class="flex items-center gap-3">
          <Switch v-model:checked="mfaRequired" />
          <span class="text-sm text-muted-foreground">
            {{ mfaRequired ? '要求开启' : '不强制' }}
          </span>
        </div>
        <p v-if="!mfaTrusted" class="mt-1 text-xs text-red-600">
          后端未返回当前 MFA 设置，这里显示的是默认值（不强制）。
          提交会把它写成你选择的值，修改前请与本人确认。
        </p>
        <p v-else class="mt-1 text-xs text-muted-foreground">
          MFA 策略为占位能力（PRD §4.3 / 契约
          U-09），是否真的拦截登录由后端决定。
        </p>
      </div>

      <Descriptions bordered size="small" :column="1">
        <Descriptions.Item label="权限影响">
          {{ summarizePermissionDiff(permissionDiff) }}
          <span class="text-xs text-muted-foreground">
            （按角色并集预览，实际授权以服务端判定为准）
          </span>
        </Descriptions.Item>
        <Descriptions.Item v-if="permissionDiff.added.length > 0" label="新增">
          <Tag
            v-for="code in permissionDiff.added"
            :key="code"
            color="green"
            class="mb-1"
          >
            {{ code }}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item
          v-if="permissionDiff.removed.length > 0"
          label="移除"
        >
          <Tag
            v-for="code in permissionDiff.removed"
            :key="code"
            color="red"
            class="mb-1"
          >
            {{ code }}
          </Tag>
        </Descriptions.Item>
      </Descriptions>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">变更原因</span>
          <Tag color="red">高风险动作</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="200"
          :rows="2"
          placeholder="例如：岗位调整，收回财务核销权限"
        />
      </div>

      <Alert v-if="localError" :message="localError" show-icon type="warning" />

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <p>{{ error.description }}</p>
          <p v-if="error.requestId" class="mt-1 text-xs">
            请求 ID：{{ error.requestId }}
          </p>
          <div v-if="error.shouldRefresh" class="mt-2">
            <span class="text-xs">
              版本已过期：请刷新列表拿到最新数据后重新修改，不要用旧数据覆盖。
            </span>
            <a class="ml-2 text-xs" @click="emit('refresh')">立即刷新</a>
          </div>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
