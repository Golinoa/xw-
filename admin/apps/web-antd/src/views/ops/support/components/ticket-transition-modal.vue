<script lang="ts" setup>
import type { TicketActionDef, TicketErrorView } from '#/api/ops/support';

import { computed, ref, watch } from 'vue';

import { Alert, Checkbox, Input, Modal, Tag } from 'ant-design-vue';

import { validateTicketAction } from '#/api/ops/support';

defineOptions({ name: 'SupportTicketTransitionModal' });

/**
 * 状态流转对话框（唯一的状态写入入口）。
 *
 * 关键守卫：**校验不通过就不 emit `submit`**，页面因此不会发请求。
 * 这比「发出去等服务端 400」更早拦住错误，也正是源码参考门 §4.1 的要求：
 * 终态（关闭）与重开必须填原因，未填时前端先拒。
 *
 * 三种守卫按契约 §3.8：
 * - `wait` → 必填 `waitingOn`（等待对象，否则「等待中」无法解释在等谁）；
 * - `resolve` → 必填 `resolutionSummary`（关闭摘要的来源）；
 * - `close`/`reopen` → 必填 `reason`，且需要勾选确认（destructive-confirm）。
 *
 * 弹窗自身不发请求：提交、错误呈现、刷新都由详情页负责。
 */
const props = withDefaults(
  defineProps<{
    action: null | TicketActionDef;
    error: null | TicketErrorView;
    /** 当前状态展示名，用于说清「从哪个状态变到哪个状态」。 */
    fromStatusLabel?: string;
    open: boolean;
    submitting?: boolean;
    /** 目标状态展示名。 */
    toStatusLabel?: string;
  }>(),
  {
    fromStatusLabel: '',
    submitting: false,
    toStatusLabel: '',
  },
);

const emit = defineEmits<{
  cancel: [];
  submit: [
    payload: {
      reason?: string;
      resolutionSummary?: string;
      waitingOn?: string;
    },
  ];
}>();

const reason = ref('');
const waitingOn = ref('');
const resolutionSummary = ref('');
const confirmed = ref(false);
const errors = ref<
  Partial<
    Record<'confirm' | 'reason' | 'resolutionSummary' | 'waitingOn', string>
  >
>({});

function reset() {
  reason.value = '';
  waitingOn.value = '';
  resolutionSummary.value = '';
  confirmed.value = false;
  errors.value = {};
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
    }
  },
);

const destructive = computed(() => props.action?.destructive ?? false);

const needsReason = computed(() => props.action?.requiresReason ?? false);

/**
 * 提交：先本地校验，不通过在当前弹窗标红并 return —— **不触发任何请求**。
 */
function onOk() {
  const action = props.action;
  if (!action || props.submitting) {
    return;
  }

  const result = validateTicketAction(action, {
    reason: reason.value,
    resolutionSummary: resolutionSummary.value,
    waitingOn: waitingOn.value,
  });

  const nextErrors: typeof errors.value = { ...result.errors };
  if (destructive.value && !confirmed.value) {
    nextErrors.confirm = '请先勾选确认：该动作不可由你单方面撤回';
  }

  if (Object.keys(nextErrors).length > 0) {
    errors.value = nextErrors;
    return;
  }

  errors.value = {};
  emit('submit', {
    reason: reason.value.trim() === '' ? undefined : reason.value.trim(),
    resolutionSummary:
      resolutionSummary.value.trim() === ''
        ? undefined
        : resolutionSummary.value.trim(),
    waitingOn:
      waitingOn.value.trim() === '' ? undefined : waitingOn.value.trim(),
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
    :ok-text="action?.label ?? '确认'"
    :open="open"
    :title="`${action?.label ?? '状态流转'} · ${fromStatusLabel || '当前状态'} → ${toStatusLabel || action?.targetStatus || ''}`"
    :width="600"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        v-if="destructive"
        data-testid="ticket-destructive-warning"
        message="该动作会改变工单的对外结论，并写入不可覆盖的时间线"
        show-icon
        type="warning"
      >
        <template #description>
          <span>
            关闭后工单不可删除、不可编辑，只能「重开」并记录原因；重开会把状态退回处理中。
          </span>
        </template>
      </Alert>

      <div v-if="action?.requiresWaitingOn">
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">等待对象</span>
          <Tag color="orange">必填</Tag>
        </div>
        <Input
          v-model:value="waitingOn"
          data-testid="ticket-waiting-on"
          :maxlength="200"
          placeholder="例如：等待客户提供导出模板、等待第三方升级窗口"
          :status="errors.waitingOn ? 'error' : undefined"
        />
        <p v-if="errors.waitingOn" class="mt-1 text-xs text-red-500">
          {{ errors.waitingOn }}
        </p>
      </div>

      <div v-if="action?.requiresResolution">
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">解决说明</span>
          <Tag color="orange">必填</Tag>
        </div>
        <Input.TextArea
          v-model:value="resolutionSummary"
          data-testid="ticket-resolution-summary"
          :maxlength="500"
          :rows="3"
          placeholder="写清处理结论，这条说明会成为关闭摘要的来源"
          show-count
          :status="errors.resolutionSummary ? 'error' : undefined"
        />
        <p v-if="errors.resolutionSummary" class="mt-1 text-xs text-red-500">
          {{ errors.resolutionSummary }}
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">原因</span>
          <Tag v-if="needsReason" color="red">必填</Tag>
          <Tag v-else>选填</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          data-testid="ticket-transition-reason"
          :maxlength="500"
          :rows="3"
          :placeholder="
            needsReason
              ? '关闭/重开必须说明原因（会写入时间线，便于事后追溯）'
              : '可补充本次操作背景（选填）'
          "
          show-count
          :status="errors.reason ? 'error' : undefined"
        />
        <p v-if="errors.reason" class="mt-1 text-xs text-red-500">
          {{ errors.reason }}
        </p>
      </div>

      <div v-if="destructive">
        <Checkbox
          v-model:checked="confirmed"
          data-testid="ticket-confirm-check"
        >
          我已确认上述影响，并已核对工单当前状态
        </Checkbox>
        <p v-if="errors.confirm" class="mt-1 text-xs text-red-500">
          {{ errors.confirm }}
        </p>
      </div>

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <div class="space-y-1">
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
              （请提供给后端对账）
            </p>
          </div>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
