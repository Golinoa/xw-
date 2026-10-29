<script lang="ts" setup>
import type {
  DeploymentInstanceStatus,
  DeploymentStateAction,
} from '#/api/ops/deployment';

import { computed } from 'vue';

import { Alert, Button, Empty, Tag, Tooltip } from 'ant-design-vue';

import {
  deploymentStatusActions,
  instanceStatusView,
  permissionLabel,
} from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentStatePanel' });

/**
 * 实例状态面板：当前态 + 契约允许的动作 + 每个动作所需动作码。
 *
 * 动作清单由 `deploymentStatusActions(status)` 决定（契约 §3.7），**不**在这里手写：
 * 终态 `retired` 自然没有按钮；`active` 不会出现「登记上线」。
 * 权限不足时按钮禁用并说明缺少哪个动作码；是否真被授权仍由服务端判定。
 */
const props = defineProps<{
  busy?: boolean;
  /** 当前账号已授予的动作码（`useAccessStore().accessCodes`）。 */
  grantedCodes: readonly string[];
  status: DeploymentInstanceStatus;
}>();

const emit = defineEmits<{
  action: [DeploymentStateAction];
}>();

const statusView = computed(() => instanceStatusView(props.status));

const actions = computed<DeploymentStateAction[]>(() => {
  if (!statusView.value.known) {
    return [];
  }
  return deploymentStatusActions(props.status);
});

function allowed(action: DeploymentStateAction): boolean {
  return props.grantedCodes.includes(action.permission);
}

function testId(action: DeploymentStateAction): string {
  return `deployment-action-${action.key}`;
}
</script>

<template>
  <div data-testid="deployment-state-panel">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-muted-foreground">当前状态</span>
      <Tag :color="statusView.color" data-testid="deployment-current-status">
        {{ statusView.label }}
      </Tag>
      <span class="text-xs text-muted-foreground">
        环境状态只能通过状态动作推进；界面不提供直接改写状态的入口，也不会自动联动合同或授权
      </span>
    </div>

    <Empty
      v-if="actions.length === 0"
      :description="
        statusView.known
          ? '当前状态为终态，无可用动作（历史记录仍可查看）'
          : '未知状态：请刷新确认，前端不会猜测可用动作'
      "
      :image="Empty.PRESENTED_IMAGE_SIMPLE"
    />

    <div v-else class="space-y-2">
      <div
        v-for="action in actions"
        :key="action.key"
        class="flex flex-wrap items-center gap-3 rounded border border-border px-3 py-2"
      >
        <Tooltip
          v-if="!allowed(action)"
          :title="`缺少动作码 ${action.permission}`"
        >
          <span>
            <Button :data-testid="testId(action)" :disabled="true" size="small">
              {{ action.label }}
            </Button>
          </span>
        </Tooltip>
        <Button
          v-else
          :danger="action.destructive"
          :data-testid="testId(action)"
          :disabled="busy"
          :type="action.destructive ? 'primary' : 'default'"
          size="small"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </Button>

        <Tag :color="action.destructive ? 'red' : 'default'">
          {{ action.destructive ? '破坏性' : '常规' }}
        </Tag>
        <Tag v-if="action.highRisk" color="red">高风险</Tag>
        <span class="text-xs text-muted-foreground">
          需要 <code class="font-mono">{{ action.permission }}</code> （{{
            permissionLabel(action.permission)
          }}）
        </span>
        <span v-if="!allowed(action)" class="text-xs text-red-500">
          当前账号缺少该动作码
        </span>
        <span
          v-else-if="action.requiresReason"
          class="text-xs text-muted-foreground"
        >
          需填写原因
        </span>
      </div>

      <Alert
        class="mt-2"
        message="破坏性动作（退役）需要二次确认、影响摘要与必填原因；提交后服务端会写审计，不能单方面撤回。"
        show-icon
        type="info"
      />
    </div>
  </div>
</template>
