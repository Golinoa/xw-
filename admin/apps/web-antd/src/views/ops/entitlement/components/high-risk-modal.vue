<script lang="ts" setup>
import type { HighRiskSummary } from '../composables/use-entitlement-high-risk';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';

import { Alert, Descriptions, Input, Modal, Tag } from 'ant-design-vue';

defineOptions({ name: 'EntitlementHighRiskModal' });

/**
 * 权益高风险动作的二次确认弹窗（契约 §4 / PRD §1.3）。
 *
 * 只负责呈现与收集：校验与提交由 `useEntitlementHighRisk` 负责，弹窗自身**不**发请求。
 * 必须展示「对象 / 影响」摘要 + 必填原因；原因会写入审计。
 */
const props = withDefaults(
  defineProps<{
    actionLabel: string;
    confirmText?: string;
    error: EntitlementErrorView | null;
    open: boolean;
    reason: string;
    reasonError: null | string;
    submitting: boolean;
    summary: HighRiskSummary | null;
  }>(),
  { confirmText: '确认执行' },
);

const emit = defineEmits<{
  confirm: [];
  'update:open': [boolean];
  'update:reason': [string];
}>();

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('update:open', false);
}

function onOk() {
  emit('confirm');
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    :ok-text="confirmText"
    :open="open"
    :title="`${actionLabel} · 二次确认`"
    :width="640"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="本次操作会立即写入审计，并可能生成或推进租户同步命令，无法由你单方面撤回。"
        show-icon
        type="warning"
      >
        <template #description>
          <span>{{ summary?.impact ?? '' }}</span>
        </template>
      </Alert>

      <Descriptions v-if="summary" bordered :column="1" size="small">
        <Descriptions.Item
          v-for="row in summary.rows"
          :key="row.label"
          :label="row.label"
        >
          <span v-if="row.emphasis" class="font-medium text-foreground">
            {{ row.value }}
          </span>
          <span v-else>{{ row.value }}</span>
        </Descriptions.Item>
      </Descriptions>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">操作原因</span>
          <Tag color="red">必填</Tag>
        </div>
        <Input.TextArea
          :maxlength="500"
          :rows="3"
          :status="reasonError ? 'error' : undefined"
          :value="reason"
          placeholder="请说明本次动作原因，例如：客户欠费暂停服务、合同终止需回收授权（会写入审计）"
          show-count
          @update:value="emit('update:reason', $event)"
        />
        <p v-if="reasonError" class="mt-1 text-xs text-red-500">
          {{ reasonError }}
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
