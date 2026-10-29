<script lang="ts" setup>
import type { StateAction } from '#/api/ops/entitlement/rules';
import type { EntitlementStatus } from '#/api/ops/entitlement/types';

import { computed } from 'vue';

import { Alert, Button, Empty, Tag, Tooltip } from 'ant-design-vue';

import { entitlementStatusView } from '#/api/ops/entitlement/format';
import {
  entitlementStatusActions,
  permissionLabel,
} from '#/api/ops/entitlement/rules';

defineOptions({ name: 'EntitlementStateMachinePanel' });

/**
 * 状态机可视化：当前态 + 当前态允许的动作 + 每个动作所需权限码。
 *
 * 动作清单由 `entitlementStatusActions(status)` 决定（契约 §3.5），**不**在这里
 * 手写动作——因此终态（expired/revoked）自然不会出现任何按钮。
 * 权限不足时按钮禁用并说明缺少哪个动作码；是否真的被授权仍由服务端判定。
 */
const props = defineProps<{
  busy?: boolean;
  /** 当前账号已授予的动作码（`useAccessStore().accessCodes`）。 */
  grantedCodes: readonly string[];
  status: string;
}>();

const emit = defineEmits<{
  action: [StateAction];
}>();

const statusView = computed(() => entitlementStatusView(props.status));

const actions = computed<StateAction[]>(() => {
  if (!statusView.value.known) {
    return [];
  }
  return entitlementStatusActions(props.status as EntitlementStatus);
});

function allowed(action: StateAction): boolean {
  return props.grantedCodes.includes(action.permission);
}

function testId(action: StateAction): string {
  return `state-action-${action.key.replaceAll(':', '-')}`;
}
</script>

<template>
  <div data-testid="entitlement-state-machine">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-muted-foreground">当前状态</span>
      <Tag :color="statusView.color" data-testid="entitlement-current-status">
        {{ statusView.label }}
      </Tag>
      <span class="text-xs text-muted-foreground">
        状态由「变更申请 → 审批 → 执行」推进，界面不提供直接改写状态的入口
      </span>
    </div>

    <div v-if="actions.length === 0" class="text-sm text-muted-foreground">
      <Empty
        :description="
          statusView.known
            ? '当前状态为终态，无可用动作（如需继续服务请新建订阅/授权）'
            : '未知状态：请刷新确认，前端不会猜测可用动作'
        "
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
      />
    </div>

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
          :data-testid="testId(action)"
          :disabled="busy"
          :type="action.highRisk ? 'primary' : 'default'"
          :danger="action.highRisk"
          size="small"
          @click="emit('action', action)"
        >
          {{ action.label }}
        </Button>

        <Tag :color="action.highRisk ? 'red' : 'default'">
          {{ action.highRisk ? '高风险' : '常规' }}
        </Tag>
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
        message="暂停、撤销、到期、降级等动作都需要「先提交变更申请，再由他人审批，最后执行下发」；执行未审批的申请会被服务端拒绝（409 APPROVAL_REQUIRED）。"
        show-icon
        type="info"
      />
    </div>
  </div>
</template>
