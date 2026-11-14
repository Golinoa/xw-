<script lang="ts" setup>
import type {
  ChangeRequestAction,
  RuleDecision,
} from '#/api/ops/entitlement/rules';
import type { EntitlementChangeRequest } from '#/api/ops/entitlement/types';
import type { OpsPermission } from '#/constants/permissions';

import { computed } from 'vue';

import { Button, Space, Tag, Tooltip } from 'ant-design-vue';

import {
  canApproveChangeRequest,
  canExecuteChangeRequest,
  canRetryChangeRequest,
  changeRequestActions,
  permissionLabel,
} from '#/api/ops/entitlement/rules';
import { OPS_PERMISSION } from '#/constants/permissions';

defineOptions({ name: 'EntitlementChangeRequestActions' });

/**
 * 变更申请的动作按钮组（审批 / 驳回 / 执行 / 重试 / 取消）。
 *
 * 三条硬规则：
 * 1. 只渲染当前状态允许的动作（契约 §3.5 变更申请状态机）；
 * 2. 申请人 ≠ 审批人：`requestedBy === 当前操作人` 时审批/驳回**禁用并说明原因**
 *    （契约 CHECK `approved_by <> requested_by`，服务端返回 403 SEGREGATION_OF_DUTY）；
 * 3. 未审批不能执行：`status !== 'approved'` 时执行按钮禁用（服务端 409 APPROVAL_REQUIRED）。
 */
const props = defineProps<{
  busy?: boolean;
  changeRequest: EntitlementChangeRequest;
  currentOperatorId: null | string;
  grantedCodes: readonly string[];
}>();

const emit = defineEmits<{
  action: [ChangeRequestAction];
}>();

function granted(permission: string): boolean {
  return props.grantedCodes.includes(permission);
}

const actions = computed<ChangeRequestAction[]>(() =>
  changeRequestActions(
    props.changeRequest.status,
    props.changeRequest.changeType,
  ),
);

interface ActionView {
  action: ChangeRequestAction;
  decision: RuleDecision;
}

function decisionFor(action: ChangeRequestAction): RuleDecision {
  const context = {
    changeRequest: props.changeRequest,
    currentOperatorId: props.currentOperatorId,
    hasApprovePermission: granted(OPS_PERMISSION.ENTITLEMENT_APPROVE),
    hasExecutePermission: granted(OPS_PERMISSION.ENTITLEMENT_EXECUTE),
    hasRequestPermission: granted(OPS_PERMISSION.ENTITLEMENT_REQUEST),
  };
  switch (action.key) {
    case 'execute': {
      return canExecuteChangeRequest({
        changeRequest: props.changeRequest,
        hasExecutePermission: context.hasExecutePermission,
      });
    }
    case 'retry': {
      return canRetryChangeRequest({
        changeRequest: props.changeRequest,
        hasExecutePermission: context.hasExecutePermission,
        hasTenantRetryPermission: granted(OPS_PERMISSION.TENANT_RETRY),
      });
    }
    default: {
      if (
        action.key === 'approve' ||
        action.key === 'reject' ||
        (action.key === 'cancel' &&
          props.changeRequest.status === 'pending_approval')
      ) {
        return canApproveChangeRequest(context);
      }
      const permissions: OpsPermission[] = [action.permission];
      if (action.altPermission) {
        permissions.push(action.altPermission);
      }
      const allowed = permissions.some((permission) => granted(permission));
      return allowed
        ? { allowed: true }
        : {
            allowed: false,
            code: 'permission',
            message: `缺少动作码 ${action.permission}（${permissionLabel(action.permission)}）`,
          };
    }
  }
}

const views = computed<ActionView[]>(() =>
  actions.value.map((action) => ({
    action,
    decision: decisionFor(action),
  })),
);

/**
 * 职责分离提示：仅在「本人提交 + 有待审批动作」时出现，用于解释按钮为何不可用。
 */
const segregationNote = computed<null | string>(() => {
  const pending = views.value.find((view) => view.action.key === 'approve');
  if (!pending) {
    return null;
  }
  return pending.decision.code === 'segregation_of_duty'
    ? (pending.decision.message ?? null)
    : null;
});

function testId(action: ChangeRequestAction): string {
  return `change-request-${action.key}`;
}
</script>

<template>
  <div data-testid="change-request-actions">
    <Space v-if="views.length > 0" wrap>
      <Tooltip
        v-for="view in views"
        :key="view.action.key"
        :title="view.decision.allowed ? '' : view.decision.message"
      >
        <span>
          <Button
            :danger="view.action.highRisk"
            :data-testid="testId(view.action)"
            :disabled="busy || !view.decision.allowed"
            :type="view.action.highRisk ? 'primary' : 'default'"
            size="small"
            @click="emit('action', view.action)"
          >
            {{ view.action.label }}
            <Tag v-if="view.action.highRisk" class="ml-1" color="red">
              高风险
            </Tag>
          </Button>
        </span>
      </Tooltip>
    </Space>
    <p v-else class="text-xs text-muted-foreground">当前状态无可执行动作</p>

    <p
      v-if="segregationNote"
      class="mt-2 text-xs text-orange-600"
      data-testid="change-request-approval-blocked"
    >
      {{ segregationNote }}
    </p>
    <p
      v-else-if="views.some((view) => view.action.key === 'approve')"
      class="mt-2 text-xs text-muted-foreground"
    >
      审批人必须与申请人不同（approved_by ≠ requested_by）。
    </p>
  </div>
</template>
