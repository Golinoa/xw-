<script lang="ts" setup>
import type { DeploymentErrorView } from '#/api/ops/deployment';

import { ref, watch } from 'vue';

import {
  Alert,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Tag,
} from 'ant-design-vue';

import { validateDeploymentReason } from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentTransitionConfirm' });

/**
 * 状态动作的二次确认（破坏性 / 高风险动作的唯一入口）。
 *
 * 硬约束（PRD §1.3、§4.3；契约 §3.7 状态机）：
 * 1. **不能**一次点击直接生效：必须先看影响摘要并显式勾选确认；
 * 2. `retire` 必须填写原因（写入审计，后端同样校验 `reason`）；
 * 3. 未确认时**不发请求**——校验全部在本组件内完成，通过后才 `emit('confirm')`；
 * 4. `highRisk` 由页面用 `isHighRiskPermission('deployment.write')` 计算后传入，
 *    本组件不判断权限码，避免出现第二份高风险清单。
 */
const props = withDefaults(
  defineProps<{
    actionLabel: string;
    /** 服务端/规则返回的可读错误，失败时弹窗不关闭（保留已填原因）。 */
    error?: DeploymentErrorView | null;
    highRisk?: boolean;
    /** 影响摘要（来自 `deploymentStatusActions()`，页面不手写文案）。 */
    impact: string;
    okText?: string;
    open: boolean;
    /** 契约要求该动作必填原因（`retire`）。 */
    requiresReason?: boolean;
    submitting?: boolean;
    /** 影响摘要里的只读行，例如实例编号、当前状态、当前版本。 */
    summaryRows?: { label: string; value: string }[];
  }>(),
  {
    error: null,
    highRisk: false,
    okText: '确认执行',
    requiresReason: true,
    submitting: false,
    summaryRows: () => [],
  },
);

const emit = defineEmits<{
  confirm: [reason: string];
  'update:open': [boolean];
}>();

const reason = ref('');
const acknowledged = ref(false);
const localError = ref('');

watch(
  () => props.open,
  (open) => {
    if (open) {
      reason.value = '';
      acknowledged.value = false;
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

/** 只有全部校验通过才发事件；调用方（页面）在此之后才发请求。 */
function onOk() {
  localError.value = '';
  if (props.requiresReason) {
    const validated = validateDeploymentReason(reason.value);
    if (!validated.ok) {
      localError.value = validated.message ?? '请填写操作原因';
      return;
    }
  }
  if (!acknowledged.value) {
    localError.value = '请先确认已阅读影响摘要';
    return;
  }
  emit('confirm', reason.value.trim());
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    :ok-text="okText"
    :open="open"
    :title="`${actionLabel} · 二次确认`"
    :width="640"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="本次操作将立即生效并写入审计，不可由你单方面撤回。"
        show-icon
        type="warning"
      >
        <template #description>
          <span>{{ impact }}</span>
        </template>
      </Alert>

      <Descriptions
        v-if="summaryRows.length > 0"
        bordered
        :column="1"
        size="small"
      >
        <Descriptions.Item
          v-for="row in summaryRows"
          :key="row.label"
          :label="row.label"
        >
          {{ row.value }}
        </Descriptions.Item>
      </Descriptions>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">操作原因</span>
          <Tag :color="requiresReason ? 'red' : 'default'">
            {{ requiresReason ? '必填' : '选填' }}
          </Tag>
          <Tag v-if="highRisk" color="red">高风险动作</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="500"
          :rows="3"
          :status="localError && requiresReason ? 'error' : undefined"
          placeholder="请说明本次操作原因，例如：客户已停止使用、合同终止后退役实例等（会写入审计）"
          show-count
        />
      </div>

      <Checkbox v-model:checked="acknowledged">
        我已阅读上述影响摘要，确认执行该动作
      </Checkbox>

      <p
        v-if="localError"
        class="text-xs text-red-500"
        data-testid="deployment-confirm-error"
      >
        {{ localError }}
      </p>

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
