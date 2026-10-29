<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type { ChangeRequestAction } from '#/api/ops/entitlement/rules';
import type {
  ChangeRequestDetail,
  ChangeRequestStatus,
  ChangeRequestType,
  EntitlementChangeRequest,
  EntitlementSubjectType,
} from '#/api/ops/entitlement/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  message,
  Modal,
  Select,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  actorName,
  CHANGE_REQUEST_STATUS_OPTIONS,
  CHANGE_REQUEST_TYPE_OPTIONS,
  changeRequestStatusView,
  changeTypeLabel,
  describeEntitlementError,
  fetchChangeRequest,
  fetchChangeRequests,
  formatDateTime,
  SUBJECT_TYPE_OPTIONS,
  subjectTypeLabel,
  transitionChangeRequest,
} from '#/api/ops/entitlement';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import ChangeRequestActions from './components/change-request-actions.vue';
import ChangeRequestDiff from './components/change-request-diff.vue';
import HighRiskModal from './components/high-risk-modal.vue';
import { useCurrentOperator } from './composables/use-current-operator';
import { useEntitlementHighRisk } from './composables/use-entitlement-high-risk';

defineOptions({ name: 'EntitlementChangeRequests' });

/**
 * 权益变更申请列表（跨订阅/授权的统一视图）。
 *
 * 这里承担「审批 / 驳回 / 执行 / 重试 / 取消」的入口：
 * - 审批人 ≠ 申请人（`ChangeRequestActions` 负责禁用与解释）；
 * - 未审批即执行会被前端拦截并说明（服务端 409 `APPROVAL_REQUIRED`）；
 * - 所有动作都要填原因，高风险动作（审批、撤销/暂停的执行）走二次确认弹窗。
 */
const { grantedCodes, hasPermission } = useOpsPermission();
const { currentOperatorId } = useCurrentOperator();

const canRead = computed(() => hasPermission(OPS_PERMISSION.ENTITLEMENT_READ));

const rows = ref<EntitlementChangeRequest[]>([]);
const loading = ref(false);
const loadError = shallowRef<EntitlementErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  changeType: undefined as ChangeRequestType | undefined,
  requestedBy: '',
  status: [] as ChangeRequestStatus[],
  subjectType: undefined as EntitlementSubjectType | undefined,
});

const columns: TableColumnsType = [
  { dataIndex: 'changeType', key: 'changeType', title: '变更类型', width: 130 },
  { dataIndex: 'subject', key: 'subject', title: '主体', width: 190 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 130 },
  { dataIndex: 'reason', key: 'reason', title: '变更原因', width: 260 },
  { dataIndex: 'requestedBy', key: 'requestedBy', title: '申请人', width: 140 },
  { dataIndex: 'approvedBy', key: 'approvedBy', title: '审批人', width: 140 },
  { dataIndex: 'createdAt', key: 'createdAt', title: '提交时间', width: 160 },
  { key: 'actions', title: '操作', width: 280 },
];

function buildQuery() {
  return {
    changeType: filters.changeType,
    order: 'desc' as const,
    page: pagination.page,
    pageSize: pagination.pageSize,
    requestedBy: filters.requestedBy.trim() || undefined,
    sort: 'createdAt',
    status: filters.status.length > 0 ? filters.status : undefined,
    subjectType: filters.subjectType,
  };
}

async function load(): Promise<void> {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchChangeRequests(buildQuery());
    rows.value = result.items;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    pagination.total = 0;
    loadError.value = describeEntitlementError(error);
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  pagination.page = 1;
  void load();
}

function onReset(): void {
  filters.changeType = undefined;
  filters.requestedBy = '';
  filters.status = [];
  filters.subjectType = undefined;
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig): void {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

// ------------------------------------------------------------------ 详情与动作

const detailOpen = ref(false);
const detailLoading = ref(false);
const detailError = shallowRef<EntitlementErrorView | null>(null);
const detail = shallowRef<ChangeRequestDetail | null>(null);

async function openDetail(row: EntitlementChangeRequest): Promise<void> {
  detailOpen.value = true;
  detailLoading.value = true;
  detailError.value = null;
  detail.value = null;
  try {
    detail.value = await fetchChangeRequest(row.id);
  } catch (error: unknown) {
    detailError.value = describeEntitlementError(error);
  } finally {
    detailLoading.value = false;
  }
}

const ACTION_LABEL: Readonly<Record<string, string>> = {
  approve: '审批通过',
  cancel: '取消变更申请',
  execute: '执行变更并下发同步',
  reject: '驳回',
  retry: '重试执行',
};

const pending = shallowRef<null | {
  action: string;
  changeRequest: EntitlementChangeRequest;
}>(null);

const highRisk = useEntitlementHighRisk({
  actionLabel: '权益变更',
  execute: async ({ reason }) => {
    if (!pending.value) {
      throw new Error('缺少待执行动作');
    }
    return transitionChangeRequest(pending.value.changeRequest.id, {
      action: pending.value.action as
        | 'approve'
        | 'cancel'
        | 'execute'
        | 'reject'
        | 'retry',
      reason,
      version: pending.value.changeRequest.version ?? 0,
    });
  },
  onSuccess: async () => {
    message.success('操作已提交，正在刷新列表');
    await load();
    if (detailOpen.value && detail.value) {
      await openDetail(detail.value.changeRequest);
    }
  },
});

function onAction(
  changeRequest: EntitlementChangeRequest,
  action: ChangeRequestAction,
): void {
  pending.value = { action: action.key, changeRequest };
  highRisk.prepare({
    impact:
      action.key === 'execute'
        ? `执行会推进主体状态并生成租户同步命令（异步 202）。类型「${changeTypeLabel(changeRequest.changeType)}」${
            changeRequest.changeType === 'revoke' ||
            changeRequest.changeType === 'suspend'
              ? '属于高风险缩权，客户侧会立即受影响。'
              : '变更将在同步成功后生效。'
          }`
        : '该动作会写入审计；状态推进只能由服务端状态机完成。',
    rows: [
      {
        emphasis: true,
        label: '变更类型',
        value: changeTypeLabel(changeRequest.changeType),
      },
      { label: '主体', value: subjectTypeLabel(changeRequest.subjectType) },
      { label: '申请人', value: actorName(changeRequest.requestedBy) },
      {
        label: '审批人',
        value: changeRequest.approvedBy
          ? actorName(changeRequest.approvedBy)
          : '未审批',
      },
      { label: '变更原因', value: changeRequest.reason },
      { label: '动作', value: ACTION_LABEL[action.key] ?? action.key },
      { label: '所需权限', value: action.permission },
    ],
    title: ACTION_LABEL[action.key] ?? action.key,
  });
}

function onDetailAction(action: ChangeRequestAction): void {
  if (!detail.value) {
    return;
  }
  onAction(detail.value.changeRequest, action);
}

async function onHighRiskClose(open: boolean): Promise<void> {
  highRisk.open.value = open;
  if (!open && highRisk.error.value?.shouldRefresh) {
    highRisk.clearError();
    await load();
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="entitlement-permission-denied"
      description="当前账号缺少 entitlement.read 动作码，不展示任何变更申请、前后值摘要与审批信息。"
      message="无查看权益权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">主体类型</div>
            <Select
              v-model:value="filters.subjectType"
              :options="SUBJECT_TYPE_OPTIONS"
              allow-clear
              placeholder="全部主体"
              style="width: 150px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="CHANGE_REQUEST_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 230px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">变更类型</div>
            <Select
              v-model:value="filters.changeType"
              :options="CHANGE_REQUEST_TYPE_OPTIONS"
              allow-clear
              placeholder="全部类型"
              style="width: 180px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">申请人 ID</div>
            <Input
              v-model:value="filters.requestedBy"
              allow-clear
              placeholder="按申请人筛选"
              style="width: 190px"
            />
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
        </div>
      </Card>

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="entitlement-list-error"
          :message="loadError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ loadError.description }}</p>
              <Button size="small" @click="load">重试</Button>
            </div>
          </template>
        </Alert>

        <Table
          :columns="columns"
          :data-source="rows"
          :loading="loading"
          :pagination="{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
          }"
          :row-key="(row: EntitlementChangeRequest) => row.id"
          :scroll="{ x: 1450 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'changeType'">
              {{ changeTypeLabel(record.changeType) }}
            </template>
            <template v-else-if="column.key === 'subject'">
              <div>
                {{ subjectTypeLabel(record.subjectType) }}
                <div class="font-mono text-xs text-muted-foreground">
                  {{ record.subjectId }}
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="changeRequestStatusView(record.status).color">
                {{ changeRequestStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'requestedBy'">
              {{ actorName(record.requestedBy) }}
            </template>
            <template v-else-if="column.key === 'approvedBy'">
              {{ record.approvedBy ? actorName(record.approvedBy) : '未审批' }}
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <div class="space-y-1">
                <ChangeRequestActions
                  :change-request="record as EntitlementChangeRequest"
                  :current-operator-id="currentOperatorId"
                  :granted-codes="[...grantedCodes]"
                  @action="
                    (action) =>
                      onAction(record as EntitlementChangeRequest, action)
                  "
                />
                <Button
                  size="small"
                  type="link"
                  @click="openDetail(record as EntitlementChangeRequest)"
                >
                  查看差异
                </Button>
              </div>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有变更申请" />
          </template>
        </Table>
      </Card>
    </template>

    <Modal
      v-model:open="detailOpen"
      :footer="null"
      :width="960"
      title="变更申请详情"
    >
      <Spin :spinning="detailLoading">
        <Alert
          v-if="detailError"
          :message="detailError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ detailError.description }}</p>
          </template>
        </Alert>
        <template v-else-if="detail">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <Tag
              :color="
                changeRequestStatusView(detail.changeRequest.status).color
              "
            >
              {{ changeRequestStatusView(detail.changeRequest.status).label }}
            </Tag>
            <span class="text-sm">{{
              changeTypeLabel(detail.changeRequest.changeType)
            }}</span>
            <span class="text-xs text-muted-foreground">
              申请人 {{ actorName(detail.changeRequest.requestedBy) }} · 审批人
              {{
                detail.changeRequest.approvedBy
                  ? actorName(detail.changeRequest.approvedBy)
                  : '未审批'
              }}
            </span>
            <span
              v-if="detail.command"
              class="font-mono text-xs text-muted-foreground"
            >
              命令 {{ detail.command.id }} · {{ detail.command.status }}
            </span>
          </div>
          <Alert
            class="mb-2"
            :message="`变更原因：${detail.changeRequest.reason}`"
            type="info"
          />
          <ChangeRequestDiff :diff="detail.diff" />
          <div class="mt-3">
            <ChangeRequestActions
              :change-request="detail.changeRequest"
              :current-operator-id="currentOperatorId"
              :granted-codes="[...grantedCodes]"
              @action="onDetailAction"
            />
          </div>
        </template>
      </Spin>
    </Modal>

    <HighRiskModal
      :action-label="highRisk.summary.value?.title ?? '权益变更'"
      :error="highRisk.error.value"
      :open="highRisk.open.value"
      :reason="highRisk.reason.value"
      :reason-error="highRisk.reasonError.value"
      :submitting="highRisk.submitting.value"
      :summary="highRisk.summary.value"
      @confirm="highRisk.confirm()"
      @update:open="onHighRiskClose"
      @update:reason="highRisk.reason.value = $event"
    />
  </div>
</template>
