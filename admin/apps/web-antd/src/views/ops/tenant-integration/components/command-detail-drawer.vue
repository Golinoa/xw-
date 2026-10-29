<script lang="ts" setup>
import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type {
  TenantCommandAttempt,
  TenantCommandDetail,
} from '#/api/ops/tenant/types';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  attemptOutcomeLabel,
  canCancelCommand,
  cancelCommand,
  canRetryCommand,
  commandPermission,
  commandStatusView,
  commandTypeLabel,
  createCommandIdempotencyKey,
  describeTenantError,
  errorCategoryView,
  fetchCommand,
  fetchCommandAttempts,
  formatDateTime,
  retryCommand,
  validateReason,
} from '#/api/ops/tenant';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import { describeRetryAccepted } from '../command-feedback';

defineOptions({ name: 'TenantCommandDetailDrawer' });

/**
 * 命令详情抽屉 —— 本域的**审计核心**。
 *
 * 必须完整可读：命令体（类型/状态/尝试次数/错误码与类别/requestId/下次重试时间）
 * + 每次尝试（attempt_no / outcome / http_status / error_category / request_id / 时间）。
 * 尝试记录由服务端**仅 INSERT**，页面不提供任何编辑入口。
 *
 * 「失败不得装成成功」的两条落点：
 * 1. 永久性错误（`last_error_category='permanent'`）时重试按钮禁用并说明原因；
 * 2. 重试返回 202 时只显示「已受理，结果待确认」，不显示成功。
 */
const props = defineProps<{
  commandId: null | string;
  open: boolean;
}>();

const emit = defineEmits<{
  changed: [];
  'update:open': [boolean];
}>();

const { hasPermission } = useOpsPermission();

const detail = ref<null | TenantCommandDetail>(null);
const loading = ref(false);
const error = ref<null | TenantErrorView>(null);
/** 202 受理提示（不是成功提示）。 */
const acceptedNotice = ref<null | string>(null);

const command = computed(() => detail.value?.command ?? null);
const attempts = computed<TenantCommandAttempt[]>(
  () => detail.value?.attempts ?? [],
);

async function load() {
  if (!props.commandId) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    detail.value = await fetchCommand(props.commandId);
  } catch (error_: unknown) {
    detail.value = null;
    error.value = describeTenantError(error_);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.commandId] as const,
  ([open]) => {
    if (open) {
      acceptedNotice.value = null;
      void load();
    }
  },
  { immediate: true },
);

// ------------------------------------------------------------------ 尝试记录刷新

const attemptsRefreshing = ref(false);

/**
 * 单独刷新尝试记录（契约 §5.7 独立端点）。
 * 用途：命令仍在执行时轮询审计流水，避免整抽屉重载丢失滚动位置。
 */
async function refreshAttempts() {
  if (!props.commandId || attemptsRefreshing.value) {
    return;
  }
  attemptsRefreshing.value = true;
  try {
    const list = await fetchCommandAttempts(props.commandId);
    if (detail.value) {
      detail.value = { ...detail.value, attempts: list };
    }
  } catch (error_: unknown) {
    error.value = describeTenantError(error_);
  } finally {
    attemptsRefreshing.value = false;
  }
}

// ------------------------------------------------------------------ 动作可用性
const retryDecision = computed(() =>
  canRetryCommand({
    hasPermission: hasPermission(OPS_PERMISSION.TENANT_RETRY),
    lastErrorCategory: command.value?.lastErrorCategory,
    serverRetryable: detail.value?.retryable,
    status: command.value?.status ?? 'pending',
  }),
);

const canCancelThisCommand = computed(() =>
  command.value
    ? hasPermission(commandPermission(command.value.commandType))
    : false,
);

const cancelDecision = computed(() =>
  canCancelCommand({
    attemptCount: command.value?.attemptCount ?? 0,
    hasPermission: canCancelThisCommand.value,
    status: command.value?.status ?? 'pending',
  }),
);

/** 永久性错误必须显著提示，避免运营把「业务拒绝」当成「网络抖动」。 */
const permanentError = computed(
  () => command.value?.lastErrorCategory === 'permanent',
);

// ------------------------------------------------------------------ 重试

const retryOpen = ref(false);
const retryReason = ref('');
const retryReasonError = ref<null | string>(null);
const retrySubmitting = ref(false);
const retryError = ref<null | TenantErrorView>(null);

function requestRetry() {
  if (!retryDecision.value.allowed) {
    message.warning(retryDecision.value.message ?? '当前不可重试');
    return;
  }
  retryReason.value = '';
  retryReasonError.value = null;
  retryError.value = null;
  retryOpen.value = true;
}

async function submitRetry() {
  const current = command.value;
  if (!current || retrySubmitting.value) {
    return;
  }
  const validated = validateReason(retryReason.value);
  if (!validated.ok) {
    retryReasonError.value = validated.message ?? '请填写操作原因';
    return;
  }
  if (current.version === undefined) {
    retryError.value = {
      accepted: false,
      canRetry: false,
      description:
        '命令缺少乐观锁版本（version），无法安全重试，请刷新后重试。',
      kind: 'validation',
      shouldRefresh: true,
      title: '缺少版本号',
    };
    return;
  }
  retrySubmitting.value = true;
  retryError.value = null;
  try {
    // 重试复用原命令的幂等键（在 `retryCommand` 内取 `command.idempotencyKey`）。
    await retryCommand(current, {
      reason: validated.value,
      version: current.version,
    });
    retryOpen.value = false;
    // 202：只表示已受理，结果仍需查询。
    acceptedNotice.value = describeRetryAccepted(current.commandNo);
    message.info('重试已受理，结果待确认');
    await load();
    emit('changed');
  } catch (error_: unknown) {
    const view = describeTenantError(error_);
    retryError.value = view;
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    retrySubmitting.value = false;
  }
}

// ------------------------------------------------------------------ 取消

const cancelOpen = ref(false);
const cancelReason = ref('');
const cancelReasonError = ref<null | string>(null);
const cancelSubmitting = ref(false);
const cancelError = ref<null | TenantErrorView>(null);
/** 取消请求的幂等键：一次弹窗一个，重复点击复用。 */
const cancelIdempotencyKey = ref<null | string>(null);

function requestCancel() {
  if (!cancelDecision.value.allowed) {
    message.warning(cancelDecision.value.message ?? '当前不可取消');
    return;
  }
  cancelReason.value = '';
  cancelReasonError.value = null;
  cancelError.value = null;
  cancelIdempotencyKey.value = createCommandIdempotencyKey();
  cancelOpen.value = true;
}

async function submitCancel() {
  const current = command.value;
  const key = cancelIdempotencyKey.value;
  if (!current || !key || cancelSubmitting.value) {
    return;
  }
  const validated = validateReason(cancelReason.value);
  if (!validated.ok) {
    cancelReasonError.value = validated.message ?? '请填写操作原因';
    return;
  }
  if (current.version === undefined) {
    cancelError.value = {
      accepted: false,
      canRetry: false,
      description:
        '命令缺少乐观锁版本（version），无法安全取消，请刷新后重试。',
      kind: 'validation',
      shouldRefresh: true,
      title: '缺少版本号',
    };
    return;
  }
  cancelSubmitting.value = true;
  cancelError.value = null;
  try {
    await cancelCommand(
      current.id,
      { reason: validated.value, version: current.version },
      key,
    );
    cancelOpen.value = false;
    message.success(`命令 ${current.commandNo} 已取消（未发生任何尝试）`);
    await load();
    emit('changed');
  } catch (error_: unknown) {
    const view = describeTenantError(error_);
    cancelError.value = view;
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    cancelSubmitting.value = false;
  }
}

// ------------------------------------------------------------------ 列

const attemptColumns = [
  { dataIndex: 'attemptNo', key: 'attemptNo', title: '第 N 次', width: 84 },
  { dataIndex: 'outcome', key: 'outcome', title: '结果', width: 130 },
  { dataIndex: 'httpStatus', key: 'httpStatus', title: 'HTTP', width: 84 },
  {
    dataIndex: 'errorCategory',
    key: 'errorCategory',
    title: '错误类别',
    width: 130,
  },
  { dataIndex: 'requestId', key: 'requestId', title: '请求 ID', width: 180 },
  { dataIndex: 'startedAt', key: 'startedAt', title: '开始时间', width: 150 },
  { dataIndex: 'finishedAt', key: 'finishedAt', title: '结束时间', width: 150 },
];

function summaryText(
  value: null | Record<string, unknown> | undefined,
): string {
  if (!value) {
    return '—';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '—';
  }
}

function closeDrawer() {
  emit('update:open', false);
}
</script>

<template>
  <Drawer
    :open="open"
    :width="980"
    title="命令详情与尝试记录"
    @close="closeDrawer"
  >
    <Spin :spinning="loading">
      <Alert
        v-if="error"
        data-testid="tenant-command-error"
        :message="error.title"
        show-icon
        type="error"
      >
        <template #description>
          <div class="space-y-1">
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
            </p>
            <Button size="small" @click="load">重试</Button>
          </div>
        </template>
      </Alert>

      <Alert
        v-if="acceptedNotice"
        class="mb-3"
        data-testid="tenant-accepted-notice"
        :message="acceptedNotice"
        show-icon
        type="info"
      />

      <template v-if="command">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Tag
            :color="commandStatusView(command.status).color"
            data-testid="tenant-command-status"
          >
            {{ commandStatusView(command.status).label }}
          </Tag>
          <Tag v-if="command.lastErrorCategory" color="red">
            {{ errorCategoryView(command.lastErrorCategory).label }}
          </Tag>
          <span class="text-sm text-muted-foreground">
            已尝试 {{ command.attemptCount }} 次
          </span>
        </div>

        <Alert
          v-if="permanentError"
          class="mb-3"
          data-testid="tenant-permanent-error"
          message="永久性错误不可重试"
          show-icon
          type="error"
        >
          <template #description>
            该命令被上游判定为永久性业务错误（{{
              command.lastErrorCode ?? '未返回错误码'
            }}）。 重试不会改变结果，请修正数据后重新发起命令。
          </template>
        </Alert>

        <Alert
          v-else-if="command.status === 'failed'"
          class="mb-3"
          message="命令执行失败，运营侧状态未被标记为成功"
          show-icon
          type="warning"
        >
          <template #description>
            错误类别：{{
              errorCategoryView(command.lastErrorCategory ?? 'unknown').label
            }}。
            请在确认幂等条件后按需重试；重试会复用原幂等键，不会重复开通或重复应用权益。
          </template>
        </Alert>

        <Descriptions bordered :column="2" size="small" title="命令体">
          <Descriptions.Item label="命令编号">
            {{ command.commandNo }}
          </Descriptions.Item>
          <Descriptions.Item label="命令类型">
            {{ commandTypeLabel(command.commandType) }}
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            {{ commandStatusView(command.status).label }}
          </Descriptions.Item>
          <Descriptions.Item label="尝试次数">
            {{ command.attemptCount }}
          </Descriptions.Item>
          <Descriptions.Item label="错误码">
            {{ command.lastErrorCode ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="错误类别">
            {{
              command.lastErrorCategory
                ? errorCategoryView(command.lastErrorCategory).label
                : '—'
            }}
          </Descriptions.Item>
          <Descriptions.Item label="请求 ID">
            <span class="font-mono text-xs">{{
              command.requestId ?? '—'
            }}</span>
          </Descriptions.Item>
          <Descriptions.Item label="下次重试时间">
            {{ formatDateTime(command.nextRetryAt) }}
          </Descriptions.Item>
          <Descriptions.Item label="期望同步版本">
            {{ command.expectedSyncVersion ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {{ formatDateTime(command.createdAt) }}
          </Descriptions.Item>
          <Descriptions.Item label="完成时间">
            {{ formatDateTime(command.completedAt) }}
          </Descriptions.Item>
          <Descriptions.Item label="幂等键">
            <span class="font-mono text-xs">
              {{ command.idempotencyKey ?? '—' }}
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="操作原因" :span="2">
            {{ command.reason }}
          </Descriptions.Item>
        </Descriptions>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <Tooltip :title="retryDecision.message ?? ''">
            <span>
              <Button
                :disabled="!retryDecision.allowed"
                data-testid="tenant-retry-button"
                type="primary"
                @click="requestRetry"
              >
                重试命令
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="cancelDecision.message ?? ''">
            <span>
              <Button
                :disabled="!cancelDecision.allowed"
                danger
                data-testid="tenant-cancel-button"
                @click="requestCancel"
              >
                取消命令
              </Button>
            </span>
          </Tooltip>
          <span class="text-xs text-muted-foreground">
            成功执行的命令不可取消、不可删除
          </span>
        </div>
        <p
          v-if="
            !retryDecision.allowed && retryDecision.code === 'permanent_error'
          "
          class="mt-2 text-xs text-red-500"
          data-testid="tenant-retry-blocked"
        >
          {{ retryDecision.message }}
        </p>
        <p
          v-else-if="!retryDecision.allowed && retryDecision.message"
          class="mt-2 text-xs text-muted-foreground"
        >
          {{ retryDecision.message }}
        </p>
        <p
          v-if="!cancelDecision.allowed && cancelDecision.code === 'attempted'"
          class="mt-1 text-xs text-orange-600"
          data-testid="tenant-cancel-blocked"
        >
          {{ cancelDecision.message }}
        </p>
        <p
          v-else-if="!cancelDecision.allowed && cancelDecision.message"
          class="mt-1 text-xs text-muted-foreground"
        >
          {{ cancelDecision.message }}
        </p>

        <div class="mt-6">
          <div class="mb-2 flex items-center gap-2">
            <h4 class="font-medium">尝试记录（仅追加，不可编辑）</h4>
            <Button
              :loading="attemptsRefreshing"
              class="ml-auto"
              size="small"
              @click="refreshAttempts"
            >
              刷新尝试记录
            </Button>
          </div>
          <Table
            :columns="attemptColumns"
            :data-source="attempts"
            :pagination="false"
            :row-key="(row: TenantCommandAttempt) => String(row.attemptNo)"
            data-testid="tenant-command-attempts"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'attemptNo'">
                #{{ record.attemptNo }}
              </template>
              <template v-else-if="column.key === 'outcome'">
                <Tag
                  :color="
                    record.outcome === 'succeeded'
                      ? 'green'
                      : record.outcome === 'timeout'
                        ? 'orange'
                        : 'red'
                  "
                >
                  {{ attemptOutcomeLabel(record.outcome) }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'httpStatus'">
                {{ record.httpStatus ?? '—' }}
              </template>
              <template v-else-if="column.key === 'errorCategory'">
                {{
                  record.errorCategory
                    ? errorCategoryView(record.errorCategory).label
                    : '—'
                }}
              </template>
              <template v-else-if="column.key === 'requestId'">
                <span class="font-mono text-xs">{{
                  record.requestId ?? '—'
                }}</span>
              </template>
              <template v-else-if="column.key === 'startedAt'">
                {{ formatDateTime(record.startedAt) }}
              </template>
              <template v-else-if="column.key === 'finishedAt'">
                {{ formatDateTime(record.finishedAt) }}
              </template>
            </template>
            <template #emptyText>
              <Empty description="该命令尚未发生任何执行尝试" />
            </template>
          </Table>
        </div>

        <div class="mt-6 grid gap-4 md:grid-cols-2">
          <div>
            <h4 class="mb-2 font-medium">请求摘要（安全字段）</h4>
            <pre class="rounded bg-muted p-2 text-xs">{{
              summaryText(detail?.requestSummary)
            }}</pre>
          </div>
          <div>
            <h4 class="mb-2 font-medium">响应摘要（安全字段）</h4>
            <pre class="rounded bg-muted p-2 text-xs">{{
              summaryText(detail?.responseSummary)
            }}</pre>
          </div>
        </div>
      </template>
      <Empty v-else-if="!loading && !error" description="未找到命令" />
    </Spin>

    <!-- 重试：复用原幂等键 -->
    <Modal
      v-model:open="retryOpen"
      :confirm-loading="retrySubmitting"
      :mask-closable="false"
      ok-text="确认重试"
      title="重试命令 · 二次确认"
      @ok="submitRetry"
    >
      <div class="space-y-3">
        <Alert
          message="重试会复用原命令的幂等键，服务端不会重复创建租户或重复应用权益。"
          show-icon
          type="info"
        >
          <template #description>
            <span class="font-mono text-xs">
              {{ command?.idempotencyKey ?? '—' }}
            </span>
          </template>
        </Alert>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">重试原因（必填）</div>
          <Input.TextArea
            v-model:value="retryReason"
            :maxlength="500"
            :rows="3"
            :status="retryReasonError ? 'error' : undefined"
            show-count
          />
          <p v-if="retryReasonError" class="mt-1 text-xs text-red-500">
            {{ retryReasonError }}
          </p>
        </div>
        <Alert
          v-if="retryError"
          :message="retryError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ retryError.description }}</p>
          </template>
        </Alert>
      </div>
    </Modal>

    <!-- 取消：仅零次尝试 -->
    <Modal
      v-model:open="cancelOpen"
      :confirm-loading="cancelSubmitting"
      :mask-closable="false"
      ok-text="确认取消命令"
      :ok-button-props="{ danger: true }"
      title="取消命令 · 二次确认"
      @ok="submitCancel"
    >
      <div class="space-y-3">
        <Alert
          message="取消后该命令不会再执行；已发生尝试的命令不能取消。"
          show-icon
          type="warning"
        />
        <div>
          <div class="mb-1 text-xs text-muted-foreground">取消原因（必填）</div>
          <Input.TextArea
            v-model:value="cancelReason"
            :maxlength="500"
            :rows="3"
            :status="cancelReasonError ? 'error' : undefined"
            show-count
          />
          <p v-if="cancelReasonError" class="mt-1 text-xs text-red-500">
            {{ cancelReasonError }}
          </p>
        </div>
        <Alert
          v-if="cancelError"
          :message="cancelError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ cancelError.description }}</p>
          </template>
        </Alert>
      </div>
    </Modal>
  </Drawer>
</template>
