<script lang="ts" setup>
import type { TicketActionDef } from '#/api/ops/support';

import { computed } from 'vue';

import { Alert, Button, Empty, Tag, Tooltip } from 'ant-design-vue';

import {
  resolveTicketActions,
  ticketPermissionLabel,
  ticketStatusView,
} from '#/api/ops/support';

defineOptions({ name: 'SupportTicketStatePanel' });

/**
 * 工单状态面板：当前状态 + 当前状态允许的动作 + 每个动作所需权限码。
 *
 * 动作清单由 `resolveTicketActions(status, serverAllowedActions)` 决定，**不在模板里
 * 手写动作**——因此：
 * - 终态（`closed`）不出现任何常规处置按钮；
 * - `resolved`/`closed` 的重开只出现在「终态例外」区块（契约 §3.8 允许重开）；
 * - 服务端 `allowedActions`（他人已流转时会变）与本地状态机取交集，
 *   服务端说不能做的动作不渲染，多出来的动作只提示、不猜语义。
 *
 * 权限不足时按钮禁用并写明缺少的动作码；真正的授权仍由服务端判定。
 */
const props = withDefaults(
  defineProps<{
    busy?: boolean;
    /** 当前账号已授予的动作码（`useAccessStore().accessCodes`）。 */
    grantedCodes: readonly string[];
    /** 服务端返回的当前可用动作（契约 §5.8 详情响应 / 409 details）。 */
    serverAllowedActions?: null | string[];
    status: string;
  }>(),
  { busy: false, serverAllowedActions: null },
);

const emit = defineEmits<{ action: [TicketActionDef] }>();

const statusView = computed(() => ticketStatusView(props.status));

const actionSet = computed(() =>
  resolveTicketActions(props.status, props.serverAllowedActions),
);

const regularActions = computed(() =>
  actionSet.value.actions.filter((action) => !action.exception),
);

const exceptionActions = computed(() =>
  actionSet.value.actions.filter((action) => action.exception),
);

function allowed(action: TicketActionDef): boolean {
  return props.grantedCodes.includes(action.permission);
}

function testId(action: TicketActionDef): string {
  return `ticket-action-${action.action}`;
}
</script>

<template>
  <div data-testid="ticket-state-panel">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-muted-foreground">当前状态</span>
      <Tag :color="statusView.color" data-testid="ticket-current-status">
        {{ statusView.label }}
      </Tag>
      <span v-if="!statusView.known" class="text-xs text-red-500">
        未知状态：请刷新确认，前端不会猜测可用动作
      </span>
    </div>

    <div
      v-if="regularActions.length === 0"
      class="text-sm text-muted-foreground"
      data-testid="ticket-no-actions"
    >
      <Empty
        :description="
          statusView.known
            ? '当前状态没有可执行的处置动作（终态工单只能重开或留在原地）'
            : '未知状态：请刷新确认'
        "
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />
    </div>

    <div v-else class="space-y-2" data-testid="ticket-regular-actions">
      <div
        v-for="action in regularActions"
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
          :data-testid="testId(action)"
          :danger="action.destructive"
          :disabled="busy"
          size="small"
          :type="action.destructive ? 'primary' : 'default'"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </Button>

        <Tag :color="action.highRisk ? 'red' : 'default'">
          {{ action.highRisk ? '高风险' : '常规' }}
        </Tag>
        <span class="text-xs text-muted-foreground">
          需要 <code class="font-mono">{{ action.permission }}</code> （{{
            ticketPermissionLabel(action.permission)
          }}）
        </span>
        <span v-if="!allowed(action)" class="text-xs text-red-500">
          缺少「{{ ticketPermissionLabel(action.permission) }}」动作码
        </span>
        <span
          v-else-if="action.requiresReason"
          class="text-xs text-muted-foreground"
        >
          必须填写原因
        </span>
        <span
          v-else-if="action.requiresWaitingOn"
          class="text-xs text-muted-foreground"
        >
          必须填写等待对象
        </span>
        <span
          v-else-if="action.requiresResolution"
          class="text-xs text-muted-foreground"
        >
          必须填写解决说明
        </span>
      </div>
    </div>

    <div
      v-if="exceptionActions.length > 0"
      class="mt-3 rounded border border-dashed border-border px-3 py-2"
      data-testid="ticket-exception-actions"
    >
      <div class="mb-2 text-xs text-muted-foreground">
        终态例外：契约允许已解决/已关闭工单重开，重开会把状态退回「处理中」并累加重开次数
      </div>
      <div
        v-for="action in exceptionActions"
        :key="action.key"
        class="flex flex-wrap items-center gap-3"
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
          :data-testid="testId(action)"
          danger
          :disabled="busy"
          size="small"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </Button>
        <span class="text-xs text-muted-foreground">
          需要 <code class="font-mono">{{ action.permission }}</code>
          ，且必须填写重开原因
        </span>
      </div>
    </div>

    <Alert
      v-if="actionSet.blockedByServer.length > 0"
      class="mt-3"
      data-testid="ticket-server-blocked"
      message="部分动作已被服务端关闭"
      show-icon
      type="warning"
    >
      <template #description>
        服务端当前可用动作不含：{{ actionSet.blockedByServer.join('、') }}。
        通常是他人已流转该工单，请刷新后再操作。
      </template>
    </Alert>

    <Alert
      v-if="actionSet.unknownServerActions.length > 0"
      class="mt-3"
      message="服务端返回了本页不认识的动作"
      show-icon
      type="info"
    >
      <template #description>
        {{
          actionSet.unknownServerActions.join('、')
        }}（契约可能已升级，页面不会渲染未知动作，请升级前端）
      </template>
    </Alert>
  </div>
</template>
