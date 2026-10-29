<script lang="ts" setup>
/**
 * 查询失败提示（error 状态）。
 *
 * 只展示适配层映射后的中文文案 + `requestId`（便于与后端日志对账）；
 * **不展示**后端 `message`、堆栈或原始响应（契约 §6.1）。
 */
import { Alert, Button } from 'ant-design-vue';

defineOptions({ name: 'OpsErrorAlert' });

withDefaults(
  defineProps<{
    message: string;
    requestId?: string;
    /** 是否显示「重试」按钮（只读查询才建议显示） */
    retryable?: boolean;
  }>(),
  { requestId: undefined, retryable: true },
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <Alert class="mb-4" type="error" show-icon :message="message">
    <template #description>
      <div class="flex flex-wrap items-center gap-3">
        <span v-if="requestId" class="text-xs">
          请求 ID：{{ requestId }}（反馈问题时请附上）
        </span>
        <Button v-if="retryable" size="small" @click="emit('retry')">
          重试
        </Button>
      </div>
    </template>
  </Alert>
</template>
