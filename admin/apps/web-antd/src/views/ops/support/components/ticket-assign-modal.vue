<script lang="ts" setup>
import type { TicketAssigneeRef, TicketErrorView } from '#/api/ops/support';

import { computed, ref, watch } from 'vue';

import { Alert, Input, Modal, Select, Tag } from 'ant-design-vue';

defineOptions({ name: 'SupportTicketAssignModal' });

/**
 * 分派/改派对话框（契约 §5.8 `POST /tickets/{id}/assign`）。
 *
 * 成员来源的诚实降级：
 * `GET /operators` 需要 `operator.read`，而预置的售后支持角色没有该动作码
 * （契约 §3.9 角色表），因此这里**不**硬依赖成员下拉：
 * - 详情返回 `assignableOperators`（契约推导 U-08）时用下拉；
 * - 没返回时退化为「填写成员 ID」输入框，并在界面上写明原因，避免看起来像故障。
 *
 * 已关闭工单不允许分派（契约 §5.8 409 `STATE_CONFLICT`），按钮在状态面板已不渲染；
 * 这里再做一次本地拦截，防止弹窗被复用时绕过。
 */
const props = withDefaults(
  defineProps<{
    currentAssigneeId?: null | string;
    error: null | TicketErrorView;
    open: boolean;
    operators?: TicketAssigneeRef[];
    status: string;
    submitting?: boolean;
  }>(),
  {
    currentAssigneeId: null,
    operators: () => [],
    submitting: false,
  },
);

const emit = defineEmits<{
  cancel: [];
  submit: [payload: { assigneeOperatorId: string; reason?: string }];
}>();

const assignee = ref<string | undefined>(undefined);
const reason = ref('');
const errorMessage = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (open) {
      assignee.value = props.currentAssigneeId ?? undefined;
      reason.value = '';
      errorMessage.value = null;
    }
  },
);

const hasOperatorList = computed(() => props.operators.length > 0);

const options = computed(() =>
  props.operators.map((operator) => ({
    label:
      operator.displayName && operator.displayName.trim() !== ''
        ? `${operator.displayName}（${operator.id.slice(0, 8)}…）`
        : operator.id,
    value: operator.id,
  })),
);

function onOk() {
  if (props.submitting) {
    return;
  }
  const value = assignee.value?.trim() ?? '';
  if (props.status === 'closed') {
    errorMessage.value = '已关闭的工单不能直接分派，请先重开';
    return;
  }
  if (value === '') {
    errorMessage.value = '请选择或填写要分派的运营成员';
    return;
  }
  errorMessage.value = null;
  emit('submit', {
    assigneeOperatorId: value,
    reason: reason.value.trim() === '' ? undefined : reason.value.trim(),
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
    ok-text="确认分派"
    :open="open"
    title="分派 / 改派工单"
    :width="520"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">指派给</span>
          <Tag color="orange">必填</Tag>
        </div>

        <Select
          v-if="hasOperatorList"
          v-model:value="assignee"
          class="w-full"
          data-testid="ticket-assignee-select"
          :options="options"
          placeholder="选择运营成员"
          show-search
        />
        <template v-else>
          <Input
            v-model:value="assignee"
            data-testid="ticket-assignee-input"
            placeholder="填写运营成员 ID（UUID）"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            当前详情未返回可分派成员列表（契约推导 U-08；`GET /operators` 需要
            operator.read，售后角色默认没有），因此需要直接填写成员
            ID。分派后时间线会记录分派人、被分派人、时间与原因。
          </p>
        </template>
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">分派原因（选填）</div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="200"
          :rows="2"
          placeholder="例如：按区域分工改派、原负责人休假"
        />
      </div>

      <Alert
        v-if="errorMessage"
        :message="errorMessage"
        show-icon
        type="warning"
      />

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <p>{{ error.description }}</p>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
