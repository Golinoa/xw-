<script lang="ts" setup>
import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type { TenantCommandType } from '#/api/ops/tenant/types';

import {
  Alert,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import { commandPermission, commandTypeLabel } from '#/api/ops/tenant';

defineOptions({ name: 'TenantCommandFormModal' });

/**
 * 命令下发 / 重试的确认弹窗。
 *
 * 只负责呈现与收集：幂等键、期望版本、提交状态全部由
 * `useCommandSubmission` 持有，弹窗自身**不**发请求。
 *
 * 关键文案约束：命令是异步的，弹窗从不说「成功」，只说「提交后等待受理」。
 */
const props = defineProps<{
  acknowledged: boolean;
  acknowledgedError: null | string;
  /** 命令类型（用于展示权限码与影响说明）。 */
  commandType: TenantCommandType;
  error: null | TenantErrorView;
  expectedSyncVersion: null | number | undefined;
  highRisk: boolean;
  /** 本次意图的幂等键（只读展示，便于事后与后端日志对账）。 */
  idempotencyKey: null | string;
  label: string;
  mappingNo?: string;
  open: boolean;
  reason: string;
  reasonError: null | string;
  submitting: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  'update:acknowledged': [boolean];
  'update:open': [boolean];
  'update:reason': [string];
}>();

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('update:open', false);
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    :ok-button-props="{ disabled: submitting }"
    :open="open"
    :title="`${label} · 二次确认`"
    :width="680"
    destroy-on-close
    ok-text="确认下发"
    @cancel="onCancel"
    @ok="emit('confirm')"
  >
    <div class="space-y-4">
      <Alert
        message="命令为异步下发：确认后仅表示「已受理」，最终结果以命令状态与尝试记录为准。"
        show-icon
        type="info"
      >
        <template #description>
          受理后请在本页查看命令状态；失败不会自动变成成功，也不会回滚已下发的业务事实。
        </template>
      </Alert>

      <Descriptions bordered :column="1" size="small">
        <Descriptions.Item label="租户映射">
          {{ mappingNo ?? '—' }}
        </Descriptions.Item>
        <Descriptions.Item label="命令类型">
          {{ commandTypeLabel(commandType) }}
          <Tag class="ml-2" color="default">
            {{ commandPermission(commandType) }}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="期望同步版本">
          <span v-if="typeof expectedSyncVersion === 'number'">
            v{{ expectedSyncVersion }}
          </span>
          <span v-else class="text-red-500">未取到（提交会被阻止）</span>
          <span class="ml-2 text-xs text-muted-foreground">
            取自映射详情，服务端不一致会拒绝本次下发
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="幂等键">
          <Tooltip :title="idempotencyKey ?? ''">
            <span class="font-mono text-xs">{{ idempotencyKey ?? '—' }}</span>
          </Tooltip>
          <div class="text-xs text-muted-foreground">
            同一表单重复点击、失败后重试都复用此键，不会重复开通
          </div>
        </Descriptions.Item>
      </Descriptions>

      <div v-if="highRisk">
        <Alert message="高风险动作" show-icon type="warning">
          <template #description>
            该动作码在契约 §4
            中属高风险：会写入审计、立即影响租户可用性，需二次确认并填写原因。
          </template>
        </Alert>
        <Checkbox
          :checked="acknowledged"
          class="mt-2"
          data-testid="tenant-command-ack"
          @update:checked="emit('update:acknowledged', $event)"
        >
          我已了解本次操作对租户的影响，并确认继续
        </Checkbox>
        <p v-if="acknowledgedError" class="mt-1 text-xs text-red-500">
          {{ acknowledgedError }}
        </p>
      </div>

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
          placeholder="例如：合同 HT-2026-000201 已生效，按交付计划开通；或客户逾期暂停服务"
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
