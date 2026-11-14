<script lang="ts" setup>
import { ref } from 'vue';

import { Alert, Button, Input, Tag } from 'ant-design-vue';

defineOptions({ name: 'SupportTicketCommentForm' });

/**
 * 追加内部说明 / 对客沟通摘要（契约 §5.8 `POST /tickets/{id}/events`）。
 *
 * 时间线是「谁、什么时候、因为什么」的记录，因此备注本身也要求非空：
 * 空白备注只会污染时间线。校验不通过时**不发请求**。
 *
 * 已关闭工单不再接受备注（契约 §5.8：`closed` 只允许 `reopen`），
 * 由父组件按 `canCommentTicket()` 结果传 `disabled` 并说明原因。
 */
const props = withDefaults(
  defineProps<{
    /** 不可用原因（无权限/已关闭）；非空即禁用输入。 */
    disabledReason?: null | string;
    error?: null | string;
    submitting?: boolean;
  }>(),
  { disabledReason: null, error: null, submitting: false },
);

const emit = defineEmits<{ submit: [body: string] }>();

const body = ref('');
const localError = ref<null | string>(null);

function submit() {
  if (props.disabledReason || props.submitting) {
    return;
  }
  const value = body.value.trim();
  if (value === '') {
    localError.value = '请填写备注内容';
    return;
  }
  localError.value = null;
  emit('submit', value);
}

/** 提交成功后由父组件清空输入（失败时保留，便于重试）。 */
function clear() {
  body.value = '';
  localError.value = null;
}

defineExpose({ clear });
</script>

<template>
  <div data-testid="ticket-comment-form">
    <div class="mb-1 flex items-center gap-2">
      <span class="text-sm">添加备注（内部说明 / 对客沟通摘要）</span>
      <Tag color="orange">必填</Tag>
    </div>

    <Alert
      v-if="disabledReason"
      :message="disabledReason"
      class="mb-2"
      data-testid="ticket-comment-disabled"
      show-icon
      type="info"
    />

    <Input.TextArea
      v-model:value="body"
      :disabled="Boolean(disabledReason)"
      :maxlength="1000"
      :rows="3"
      placeholder="例如：已电话联系客户，确认下周提供导出模板（备注会追加到时间线，不可修改）"
      show-count
      :status="localError ? 'error' : undefined"
    />
    <p v-if="localError" class="mt-1 text-xs text-red-500">{{ localError }}</p>
    <p v-if="error" class="mt-1 text-xs text-red-500">{{ error }}</p>

    <div class="mt-2">
      <Button
        :disabled="Boolean(disabledReason)"
        :loading="submitting"
        size="small"
        type="primary"
        @click="submit"
      >
        追加到时间线
      </Button>
    </div>
  </div>
</template>
