<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
import type {
  AddTicketReferenceInput,
  TicketActionDef,
  TicketDetail,
  TicketErrorView,
  TicketEvent,
  TicketRefType,
} from '#/api/ops/support';

/**
 * 工单详情（本域核心页）。
 *
 * 设计要点（对应源码参考门 §4.1/§4.3）：
 * 1. **时间线是主视图**：按时间升序展示「事件类型 + 操作者 + 时间 + 原因/备注」，
 *    状态类事件画出「旧状态 → 新状态」，因此「谁在什么时候因为什么把状态改成了什么」
 *    不用翻审计也能读出来。
 * 2. 操作区只渲染当前状态允许的动作（`rules.ts`），每个动作标注所需动作码；
 *    无权限时按钮禁用并说明缺哪个码，真正的授权仍由服务端判定。
 * 3. 终态（关闭）与重开必须填原因：校验在弹窗内完成，不通过不发请求。
 * 4. 409 冲突（他人已流转）→ 提示「数据已变化，请刷新后重试」+ 重新拉取 +
 *    明确告知**当前最新状态**，绝不用本地旧 `version` 覆盖。
 * 5. 客户联系方式默认掩码，需 `customer.sensitive.read` 才显示原值（与 customer 域同口径）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  message,
  Result,
  Select,
  Space,
  Spin,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  addTicketComment,
  addTicketReference,
  assignTicket,
  canAssignTicket,
  canCommentTicket,
  contactHint,
  describeTicketError,
  displayText,
  fetchTicket,
  fetchTicketTimeline,
  formatDateTime,
  OVERDUE_SOURCE_NOTE,
  refTypeLabel,
  TICKET_REF_TYPE_OPTIONS,
  ticketContactLines,
  ticketPriorityView,
  ticketStatusView,
  transitionTicket,
  validateTicketAction,
} from '#/api/ops/support';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import TicketAssignModal from './components/ticket-assign-modal.vue';
import TicketCommentForm from './components/ticket-comment-form.vue';
import TicketOverdueBadge from './components/ticket-overdue-badge.vue';
import TicketStatePanel from './components/ticket-state-panel.vue';
import TicketTimeline from './components/ticket-timeline.vue';
import TicketTransitionModal from './components/ticket-transition-modal.vue';
import { buildTicketTimeline } from './timeline';

defineOptions({ name: 'SupportTicketDetail' });

const route = useRoute();
const router = useRouter();
const { grantedCodes, hasPermission } = useOpsPermission();

const ticketId = computed(() => String(route.params.ticketId ?? ''));

const canRead = computed(() => hasPermission(OPS_PERMISSION.TICKET_READ));
const canReadSensitive = computed(() =>
  hasPermission(OPS_PERMISSION.CUSTOMER_SENSITIVE_READ),
);

const detail = ref<null | TicketDetail>(null);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);
/** 独立时间线（详情未内嵌 `timeline[]` 时的兜底来源）。 */
const fallbackTimeline = ref<null | TicketEvent[]>(null);
const timelineLoading = ref(false);
/** 冲突后提示「当前最新状态」，让运营知道是谁把单子推走了。 */
const staleNotice = ref<null | string>(null);

const ticket = computed(() => detail.value?.ticket ?? null);
const status = computed(() => ticket.value?.status ?? '');

const timelineEntries = computed(() =>
  buildTicketTimeline(detail.value?.timeline ?? fallbackTimeline.value ?? []),
);

async function loadTimelineFallback() {
  timelineLoading.value = true;
  try {
    const result = await fetchTicketTimeline(ticketId.value, {
      page: 1,
      pageSize: 100,
    });
    fallbackTimeline.value = result.items;
  } catch {
    // 时间线兜底失败不阻塞主详情：主视图会展示「暂无事件」并保留刷新入口。
    fallbackTimeline.value = null;
  } finally {
    timelineLoading.value = false;
  }
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchTicket(ticketId.value);
    detail.value = result;
    fallbackTimeline.value = null;
    if (!result.timeline) {
      await loadTimelineFallback();
    }
  } catch (error_) {
    error.value = toOpsApiError(error_);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

/**
 * 冲突后重新拉取并展示最新状态。
 * 只重拉数据、不重发原动作——重发会带着旧 `version` 再撞一次 409。
 */
async function refreshAfterConflict(prefix: string) {
  await load();
  const latest = ticket.value;
  staleNotice.value = latest
    ? `${prefix}。当前最新状态：${ticketStatusView(latest.status).label}（版本 v${latest.version ?? '—'}，指派人：${latest.assignee?.displayName ?? '未分派'}）。请核对后再操作。`
    : `${prefix}。当前工单可能已被移出你的可见范围，请返回列表确认。`;
}

function handleMutationError(error_: unknown, prefix: string) {
  const view = describeTicketError(error_);
  if (view.shouldRefresh) {
    void refreshAfterConflict(`${prefix}：${view.description}`);
    return view;
  }
  return view;
}

/* ---------------- 状态流转 ---------------- */

const transitionState = reactive<{
  action: null | TicketActionDef;
  error: null | TicketErrorView;
  open: boolean;
  submitting: boolean;
}>({ action: null, error: null, open: false, submitting: false });

function onAction(action: TicketActionDef) {
  if (action.endpoint === 'assign') {
    openAssign();
    return;
  }
  transitionState.action = action;
  transitionState.error = null;
  transitionState.open = true;
}

function closeTransition() {
  transitionState.open = false;
}

async function submitTransition(payload: {
  reason?: string;
  resolutionSummary?: string;
  waitingOn?: string;
}) {
  const action = transitionState.action;
  const current = ticket.value;
  if (!action || !current) {
    return;
  }

  // 双重守卫：弹窗已校验，这里再校验一次，确保任何路径都不会「不带原因关单」。
  const validated = validateTicketAction(action, payload);
  if (!validated.ok) {
    transitionState.error = {
      allowedActions: [],
      canRetry: false,
      description: Object.values(validated.errors).join('；'),
      kind: 'validation',
      shouldRefresh: false,
      title: '请先补全必填项',
    };
    return;
  }

  transitionState.submitting = true;
  transitionState.error = null;
  try {
    const result = await transitionTicket(ticketId.value, {
      action: action.action as Exclude<TicketActionDef['action'], 'assign'>,
      reason: payload.reason,
      resolutionSummary: payload.resolutionSummary,
      version: current.version ?? 0,
      waitingOn: payload.waitingOn,
    });
    transitionState.open = false;
    message.success(
      `已${action.label}，当前状态：${ticketStatusView(result.ticket.status).label}`,
    );
    await load();
  } catch (error_) {
    transitionState.error = handleMutationError(
      error_,
      `${action.label}未完成`,
    );
  } finally {
    transitionState.submitting = false;
  }
}

/* ---------------- 分派 ---------------- */

const assignState = reactive<{
  error: null | TicketErrorView;
  open: boolean;
  submitting: boolean;
}>({ error: null, open: false, submitting: false });

const assignGuard = computed(() =>
  canAssignTicket({
    hasAssignPermission: hasPermission(OPS_PERMISSION.TICKET_ASSIGN),
    status: status.value,
  }),
);

function openAssign() {
  assignState.error = null;
  assignState.open = true;
}

async function submitAssign(payload: {
  assigneeOperatorId: string;
  reason?: string;
}) {
  const current = ticket.value;
  if (!current) {
    return;
  }
  assignState.submitting = true;
  assignState.error = null;
  try {
    await assignTicket(ticketId.value, {
      assigneeOperatorId: payload.assigneeOperatorId,
      reason: payload.reason,
      version: current.version ?? 0,
    });
    assignState.open = false;
    message.success('分派已记录，时间线已追加一条分派事件');
    await load();
  } catch (error_) {
    assignState.error = handleMutationError(error_, '分派未完成');
  } finally {
    assignState.submitting = false;
  }
}

/* ---------------- 备注 ---------------- */

const commentState = reactive<{
  error: null | string;
  submitting: boolean;
}>({ error: null, submitting: false });

const commentFormRef = ref<InstanceType<typeof TicketCommentForm> | null>(null);

const commentGuard = computed(() =>
  canCommentTicket({
    hasUpdatePermission: hasPermission(OPS_PERMISSION.TICKET_UPDATE),
    status: status.value,
  }),
);

async function submitComment(body: string) {
  commentState.submitting = true;
  commentState.error = null;
  try {
    await addTicketComment(ticketId.value, { body });
    commentFormRef.value?.clear();
    message.success('备注已追加到时间线');
    await load();
  } catch (error_) {
    const view = describeTicketError(error_);
    commentState.error = view.description;
    if (view.shouldRefresh) {
      await refreshAfterConflict('备注未写入：数据已变化，请刷新后重试');
    }
  } finally {
    commentState.submitting = false;
  }
}

/* ---------------- 关联业务对象 ---------------- */

const referenceState = reactive<{
  error: null | string;
  refId: string;
  refType: TicketRefType;
  submitting: boolean;
}>({ error: null, refId: '', refType: 'tenant_command', submitting: false });

async function submitReference() {
  const refId = referenceState.refId.trim();
  if (refId === '') {
    referenceState.error = '请填写关联对象 ID';
    return;
  }
  const payload: AddTicketReferenceInput = {
    refId,
    refType: referenceState.refType,
  };
  referenceState.submitting = true;
  referenceState.error = null;
  try {
    await addTicketReference(ticketId.value, payload);
    referenceState.refId = '';
    message.success('关联已建立（时间线会追加一条关联事件）');
    await load();
  } catch (error_) {
    const view = describeTicketError(error_);
    referenceState.error = view.description;
    if (view.shouldRefresh) {
      await refreshAfterConflict('关联未建立：数据已变化，请刷新后重试');
    }
  } finally {
    referenceState.submitting = false;
  }
}

const contactLines = computed(() =>
  ticketContactLines(ticket.value?.customer, canReadSensitive.value),
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.TICKET_READ]"
      title="售后工单"
    />

    <template v-else>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Space>
          <Button @click="router.push({ name: 'SupportTicketList' })">
            返回列表
          </Button>
          <span class="text-lg font-medium">工单详情</span>
          <span class="font-mono text-xs text-muted-foreground">
            {{ ticket?.ticketNo ?? ticketId }}
          </span>
        </Space>
        <Button :loading="loading" @click="load">刷新</Button>
      </div>

      <Alert
        v-if="staleNotice"
        class="mb-3"
        closable
        data-testid="ticket-stale-notice"
        message="数据已变化，请刷新后重试"
        show-icon
        type="warning"
        @close="staleNotice = null"
      >
        <template #description>{{ staleNotice }}</template>
      </Alert>

      <Card v-if="loading && !detail" class="mb-4">
        <div class="flex justify-center py-10"><Spin /></div>
      </Card>

      <OpsErrorAlert
        v-else-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Result
        v-else-if="!detail || !ticket"
        status="404"
        title="工单不存在或无权查看"
        sub-title="可能是链接有误，或该工单不在你的数据范围内（服务端对 404 与 403 不区分）。"
      />

      <template v-else>
        <Card class="mb-4" :title="ticket.subject">
          <template #extra>
            <Space wrap>
              <Tag :color="ticketStatusView(ticket.status).color">
                {{ ticketStatusView(ticket.status).label }}
              </Tag>
              <Tag :color="ticketPriorityView(ticket.priority).color">
                优先级 {{ ticketPriorityView(ticket.priority).label }}
              </Tag>
              <TicketOverdueBadge :ticket="ticket" />
              <span class="text-xs text-muted-foreground">
                版本 v{{ ticket.version ?? '—' }}
              </span>
            </Space>
          </template>

          <Descriptions bordered :column="2" size="small">
            <Descriptions.Item label="工单号">
              <span class="font-mono">{{ ticket.ticketNo }}</span>
            </Descriptions.Item>
            <Descriptions.Item label="客户">
              {{ ticket.customer.name }}
              <span class="text-xs text-muted-foreground">
                （{{ displayText(ticket.customer.customerNo) }}）
              </span>
            </Descriptions.Item>
            <Descriptions.Item label="指派人">
              {{
                ticket.assignee?.displayName ??
                (ticket.assignee ? ticket.assignee.id : '未分派')
              }}
            </Descriptions.Item>
            <Descriptions.Item label="问题类型">
              {{ displayText(ticket.issueType) }}
            </Descriptions.Item>
            <Descriptions.Item label="到期时间（SLA 参考）">
              {{ formatDateTime(ticket.dueAt) }}
            </Descriptions.Item>
            <Descriptions.Item label="重开次数">
              {{ ticket.reopenCount ?? 0 }}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {{ formatDateTime(ticket.createdAt) }}
            </Descriptions.Item>
            <Descriptions.Item label="更新时间">
              {{ formatDateTime(ticket.updatedAt) }}
            </Descriptions.Item>
            <Descriptions.Item v-if="ticket.waitingOn" label="等待对象">
              {{ ticket.waitingOn }}
            </Descriptions.Item>
            <Descriptions.Item v-if="ticket.closedAt" label="关闭时间">
              {{ formatDateTime(ticket.closedAt) }}
            </Descriptions.Item>
          </Descriptions>

          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <div class="mb-1 text-sm font-medium">客户联系方式</div>
              <div
                v-for="line in contactLines"
                :key="line.label"
                class="text-sm"
              >
                <span class="text-muted-foreground">{{ line.label }}：</span>
                <span :class="line.masked ? 'text-muted-foreground' : ''">
                  {{ line.value }}
                </span>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ contactHint(canReadSensitive) }}
              </p>
            </div>
            <div>
              <div class="mb-1 text-sm font-medium">问题描述</div>
              <p class="whitespace-pre-wrap text-sm">
                {{ displayText(ticket.description) }}
              </p>
              <div v-if="ticket.resolutionSummary" class="mt-2">
                <div class="mb-1 text-sm font-medium">解决说明</div>
                <p class="whitespace-pre-wrap text-sm">
                  {{ ticket.resolutionSummary }}
                </p>
              </div>
            </div>
          </div>

          <p class="mt-3 text-xs text-muted-foreground">
            {{ OVERDUE_SOURCE_NOTE }}
          </p>
        </Card>

        <Card class="mb-4" title="处理动作">
          <TicketStatePanel
            :busy="transitionState.submitting || assignState.submitting"
            :granted-codes="Array.from(grantedCodes)"
            :server-allowed-actions="detail.allowedActions ?? null"
            :status="ticket.status"
            @action="onAction"
          />

          <div class="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
            <Button
              :disabled="!assignGuard.allowed"
              type="default"
              @click="openAssign"
            >
              分派 / 改派
            </Button>
            <span v-if="!assignGuard.allowed" class="text-xs text-red-500">
              {{ assignGuard.message }}
            </span>
            <span v-else class="text-xs text-muted-foreground">
              需要
              <code class="font-mono">ticket.assign</code>，分派会写入时间线
            </span>
          </div>

          <div class="mt-4 border-t pt-4">
            <TicketCommentForm
              ref="commentFormRef"
              :disabled-reason="
                commentGuard.allowed ? null : (commentGuard.message ?? null)
              "
              :error="commentState.error"
              :submitting="commentState.submitting"
              @submit="submitComment"
            />
          </div>
        </Card>

        <Card class="mb-4" title="时间线（不可覆盖）">
          <TicketTimeline
            :entries="timelineEntries"
            :loading="timelineLoading"
          />
        </Card>

        <Card title="关联业务对象">
          <div
            v-if="detail.references && detail.references.length > 0"
            class="mb-3"
          >
            <div
              v-for="reference in detail.references"
              :key="`${reference.refType}-${reference.refId}`"
              class="mb-1 text-sm"
            >
              <Tag color="purple">{{ refTypeLabel(reference.refType) }}</Tag>
              <span class="font-mono text-xs">{{ reference.refId }}</span>
              <span
                v-if="reference.refLabel"
                class="ml-2 text-muted-foreground"
              >
                {{ reference.refLabel }}
              </span>
              <span class="ml-2 text-xs text-muted-foreground">
                {{ formatDateTime(reference.createdAt) }}
              </span>
            </div>
          </div>
          <p v-else class="mb-3 text-sm text-muted-foreground">
            尚未关联租户同步任务、授权变更或部署升级记录。
          </p>

          <div class="flex flex-wrap items-end gap-2">
            <Select
              v-model:value="referenceState.refType"
              class="w-52"
              :options="TICKET_REF_TYPE_OPTIONS"
            />
            <Input
              v-model:value="referenceState.refId"
              class="w-80"
              placeholder="关联对象 ID（UUID）；必须属于同一客户"
            />
            <Button
              :loading="referenceState.submitting"
              @click="submitReference"
            >
              建立关联
            </Button>
          </div>
          <p v-if="referenceState.error" class="mt-1 text-xs text-red-500">
            {{ referenceState.error }}
          </p>
          <p class="mt-2 text-xs text-muted-foreground">
            关联记录同样只追加、不修改：引用不属于该客户时服务端返回 400
            REFERENCE_CUSTOMER_MISMATCH，重复关联返回 409。
          </p>
        </Card>
      </template>
    </template>

    <TicketTransitionModal
      :action="transitionState.action"
      :error="transitionState.error"
      :from-status-label="ticket ? ticketStatusView(ticket.status).label : ''"
      :open="transitionState.open"
      :submitting="transitionState.submitting"
      :to-status-label="
        transitionState.action
          ? ticketStatusView(transitionState.action.targetStatus).label
          : ''
      "
      @cancel="closeTransition"
      @submit="submitTransition"
    />

    <TicketAssignModal
      :current-assignee-id="ticket?.assignee?.id ?? null"
      :error="assignState.error"
      :open="assignState.open"
      :operators="detail?.assignableOperators ?? []"
      :status="ticket?.status ?? ''"
      :submitting="assignState.submitting"
      @cancel="assignState.open = false"
      @submit="submitAssign"
    />
  </div>
</template>
