<script lang="ts" setup>
import type { HighRiskSummary } from '../composables/use-entitlement-high-risk';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  ChangeRequestAction,
  StateAction,
} from '#/api/ops/entitlement/rules';
import type {
  ChangeRequestType,
  CreateChangeRequestResult,
  EntitlementChangeRequest,
  EntitlementSnapshot,
  EntitlementSnapshotSummary,
  EntitlementSubjectType,
  EntitlementTransitionAction,
  LicenseMode,
} from '#/api/ops/entitlement/types';

import { computed, ref, shallowRef, watch } from 'vue';

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  message,
  Modal,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  actorName,
  billingCycleLabel,
  changeRequestStatusView,
  changeTypeLabel,
  describeEntitlementError,
  fetchChangeRequest,
  fetchLicense,
  fetchSnapshot,
  fetchSnapshotHistory,
  fetchSubscription,
  formatDate,
  formatDateTime,
  licenseModeLabel,
  maintenanceNote,
  transitionChangeRequest,
  transitionLicense,
  transitionSubscription,
} from '#/api/ops/entitlement';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import { useCurrentOperator } from '../composables/use-current-operator';
import { useEntitlementHighRisk } from '../composables/use-entitlement-high-risk';
import ChangeRequestActions from './change-request-actions.vue';
import ChangeRequestCreateModal from './change-request-create-modal.vue';
import ChangeRequestDiff from './change-request-diff.vue';
import HighRiskModal from './high-risk-modal.vue';
import SnapshotHistory from './snapshot-history.vue';
import SnapshotLinesTable from './snapshot-lines-table.vue';
import StateMachinePanel from './state-machine-panel.vue';

defineOptions({ name: 'EntitlementDetailDrawer' });

/**
 * 订阅/授权详情抽屉（两个主体同构，仅少量专有字段不同）。
 *
 * 关键约束：
 * - 状态推进只走两条路：① 草稿期 `transition`（提交/审批/驳回）；② 生效后**必须**
 *   发起变更申请并完成审批+执行。界面没有「直接改状态」的入口。
 * - 快照只读：当前快照与历史快照都只能查看，编辑入口不存在。
 * - 申请人不能自批：`ChangeRequestActions` 按 `requestedBy` 判定并说明原因。
 */
const props = defineProps<{
  open: boolean;
  subjectId: null | string;
  subjectType: EntitlementSubjectType;
}>();

const emit = defineEmits<{
  changed: [];
  'update:open': [boolean];
}>();

const { grantedCodes, hasPermission } = useOpsPermission();
const { currentOperatorId } = useCurrentOperator();

const canRead = computed(() => hasPermission(OPS_PERMISSION.ENTITLEMENT_READ));

interface SubjectView {
  autoRenewIntent?: boolean;
  billingCycle?: string;
  changeRequests: EntitlementChangeRequest[];
  contractItemId?: null | string;
  customerName: string;
  deploymentName?: null | string;
  endsOn?: null | string;
  licenseMode?: LicenseMode;
  maintenanceUntil?: null | string;
  no: string;
  productName?: null | string;
  snapshot: EntitlementSnapshot | null;
  snapshots: EntitlementSnapshotSummary[];
  startsOn?: null | string;
  status: string;
  validFrom?: null | string;
  validTo?: null | string;
  version?: number;
}

const detail = shallowRef<null | SubjectView>(null);
const loading = ref(false);
const loadError = shallowRef<EntitlementErrorView | null>(null);
const historyDegraded = ref(false);

async function load(): Promise<void> {
  if (!props.subjectId || !canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  historyDegraded.value = false;
  try {
    if (props.subjectType === 'subscription') {
      const result = await fetchSubscription(props.subjectId);
      const snapshots = await resolveHistory(
        result.snapshots,
        result.subscription.customer.id,
        result.subscription.contractItemId ?? null,
      );
      detail.value = {
        autoRenewIntent: result.subscription.autoRenewIntent,
        billingCycle: result.subscription.billingCycle,
        changeRequests: result.changeRequests ?? [],
        contractItemId: result.subscription.contractItemId ?? null,
        customerName: result.subscription.customer.name,
        endsOn: result.subscription.endsOn ?? null,
        no: result.subscription.subscriptionNo,
        productName: result.subscription.product?.name ?? null,
        snapshot: result.snapshot,
        snapshots,
        startsOn: result.subscription.startsOn,
        status: result.subscription.status,
        version: result.subscription.version,
      };
    } else {
      const result = await fetchLicense(props.subjectId);
      const snapshots = await resolveHistory(
        result.snapshots,
        result.license.customer.id,
        result.license.contractItemId ?? null,
      );
      detail.value = {
        changeRequests: result.changeRequests ?? [],
        contractItemId: result.license.contractItemId ?? null,
        customerName: result.license.customer.name,
        deploymentName: result.deployment?.name ?? null,
        licenseMode: result.license.licenseMode,
        maintenanceUntil: result.license.maintenanceUntil ?? null,
        no: result.license.licenseNo,
        snapshot: result.snapshot,
        snapshots,
        status: result.license.status,
        validFrom: result.license.validFrom,
        validTo: result.license.validTo ?? null,
        version: result.license.version,
      };
    }
  } catch (error: unknown) {
    detail.value = null;
    loadError.value = describeEntitlementError(error);
  } finally {
    loading.value = false;
  }
}

/**
 * 快照历史：优先用详情响应里的 `snapshots[]`；没有时调用契约推导航点
 * `GET /entitlement-snapshots`。两者都拿不到时明确降级，不伪造历史。
 */
async function resolveHistory(
  provided: EntitlementSnapshotSummary[] | undefined,
  customerId: string,
  contractItemId: null | string,
): Promise<EntitlementSnapshotSummary[]> {
  if (provided && provided.length > 0) {
    return provided;
  }
  try {
    const result = await fetchSnapshotHistory({
      customerId,
      pageSize: 50,
      ...(contractItemId ? { sourceId: contractItemId } : {}),
    });
    return result.items;
  } catch {
    historyDegraded.value = true;
    return [];
  }
}

watch(
  () => [props.open, props.subjectId, props.subjectType] as const,
  ([open]) => {
    if (open) {
      void load();
    }
  },
  { immediate: true },
);

const permanentLicenseNote = computed<null | string>(() => {
  if (detail.value?.licenseMode !== 'perpetual') {
    return null;
  }
  return maintenanceNote({
    licenseMode: 'perpetual',
    maintenanceUntil: detail.value.maintenanceUntil ?? null,
  });
});

// ------------------------------------------------------------------ 高风险确认

interface PendingAction {
  action: string;
  changeRequest?: EntitlementChangeRequest;
  kind: 'change' | 'subject';
}

const pendingAction = shallowRef<null | PendingAction>(null);

const highRisk = useEntitlementHighRisk({
  actionLabel: '权益变更',
  execute: async ({ reason }) => {
    const pending = pendingAction.value;
    if (!pending) {
      throw new Error('缺少待执行动作');
    }
    if (pending.kind === 'subject' && props.subjectId && detail.value) {
      const action = pending.action as EntitlementTransitionAction;
      const result =
        props.subjectType === 'subscription'
          ? await transitionSubscription(props.subjectId, {
              action,
              reason,
              version: detail.value.version ?? 0,
            })
          : await transitionLicense(props.subjectId, {
              action,
              reason,
              version: detail.value.version ?? 0,
            });
      return result;
    }
    if (pending.kind === 'change' && pending.changeRequest) {
      return transitionChangeRequest(pending.changeRequest.id, {
        action: pending.action as
          | 'approve'
          | 'cancel'
          | 'execute'
          | 'reject'
          | 'retry',
        reason,
        version: pending.changeRequest.version ?? 0,
      });
    }
    throw new Error('缺少待执行动作');
  },
  onSuccess: async () => {
    message.success('操作已提交，正在刷新最新状态');
    await load();
    emit('changed');
  },
});

function subjectActionLabel(action: string): string {
  switch (action) {
    case 'approve': {
      return '审批通过（订阅/授权生效）';
    }
    case 'reject': {
      return '驳回（退回草稿）';
    }
    default: {
      return '提交审批';
    }
  }
}

function impactOfStateAction(action: string): string {
  if (action === 'approve') {
    return '审批通过后订阅/授权立即生效，权益快照成为当前生效快照。';
  }
  if (action === 'reject') {
    return '驳回后记录退回草稿，需要修改后重新提交；不会下发任何同步命令。';
  }
  return '提交后进入待审批，审批人必须与提交人不同。';
}

function onStateAction(action: StateAction): void {
  if (!detail.value) {
    return;
  }
  if (action.changeType) {
    openCreate(action.changeType);
    return;
  }
  pendingAction.value = { action: action.key, kind: 'subject' };
  const summary: HighRiskSummary = {
    impact: impactOfStateAction(action.key),
    rows: [
      { emphasis: true, label: '对象', value: detail.value.no },
      { label: '客户', value: detail.value.customerName },
      { label: '当前状态', value: detail.value.status },
      { label: '动作', value: subjectActionLabel(action.key) },
      { label: '所需权限', value: action.permission },
    ],
    title: subjectActionLabel(action.key),
  };
  highRisk.prepare(summary);
}

const CHANGE_ACTION_LABEL: Readonly<Record<string, string>> = {
  approve: '审批通过',
  cancel: '取消变更申请',
  execute: '执行变更并下发同步',
  reject: '驳回变更申请',
  retry: '重试执行',
};

function impactOfChangeAction(
  action: string,
  changeRequest: EntitlementChangeRequest,
): string {
  const type = changeTypeLabel(changeRequest.changeType);
  switch (action) {
    case 'approve': {
      return `审批通过后状态变为「已审批待执行」，仍需执行才下发同步命令；本次变更类型：${type}。`;
    }
    case 'execute': {
      return `执行会推进订阅/授权状态并生成租户同步命令（异步，202）。变更类型「${type}」${
        changeRequest.changeType === 'revoke'
          ? '会立即回收权益，属于高风险缩权'
          : ''
      }${changeRequest.changeType === 'suspend' ? '会暂停客户使用，属于高风险缩权' : ''}。`;
    }
    case 'reject': {
      return '驳回后该申请不会再被执行，需要重新发起新的变更申请。';
    }
    case 'retry': {
      return '重试会复用同一幂等键重新下发同步命令，不会重复生效。';
    }
    default: {
      return '取消后该申请作废，历史记录保留。';
    }
  }
}

function onChangeRequestAction(
  changeRequest: EntitlementChangeRequest,
  action: ChangeRequestAction,
): void {
  if (!detail.value) {
    return;
  }
  pendingAction.value = {
    action: action.key,
    changeRequest,
    kind: 'change',
  };
  highRisk.prepare({
    impact: impactOfChangeAction(action.key, changeRequest),
    rows: [
      {
        emphasis: true,
        label: '变更类型',
        value: changeTypeLabel(changeRequest.changeType),
      },
      { label: '对象', value: detail.value.no },
      { label: '客户', value: detail.value.customerName },
      { label: '申请人', value: actorName(changeRequest.requestedBy) },
      {
        label: '审批人',
        value: changeRequest.approvedBy
          ? actorName(changeRequest.approvedBy)
          : '未审批',
      },
      { label: '变更原因', value: changeRequest.reason },
      { label: '动作', value: CHANGE_ACTION_LABEL[action.key] ?? action.key },
      { label: '所需权限', value: action.permission },
    ],
    title: CHANGE_ACTION_LABEL[action.key] ?? action.key,
  });
}

/** 409 冲突必须刷新后重试：弹窗关闭后重新拉取，不用本地值覆盖。 */
async function onHighRiskClose(open: boolean): Promise<void> {
  highRisk.open.value = open;
  if (!open && highRisk.error.value?.shouldRefresh) {
    highRisk.clearError();
    await load();
    emit('changed');
  }
}

// ------------------------------------------------------------------ 差异 / 快照查看

const diffOpen = ref(false);
const diffLoading = ref(false);
const diffError = shallowRef<EntitlementErrorView | null>(null);
const diffData = shallowRef<Awaited<
  ReturnType<typeof fetchChangeRequest>
> | null>(null);

function enabledFeatureCount(snapshot: EntitlementSnapshot): number {
  return snapshot.lines.filter((line) => line.enabled).length;
}

function onDiffAction(action: ChangeRequestAction): void {
  if (!diffData.value) {
    return;
  }
  diffOpen.value = false;
  onChangeRequestAction(diffData.value.changeRequest, action);
}

async function openDiff(
  changeRequest: EntitlementChangeRequest,
): Promise<void> {
  diffOpen.value = true;
  diffLoading.value = true;
  diffError.value = null;
  diffData.value = null;
  try {
    diffData.value = await fetchChangeRequest(changeRequest.id);
  } catch (error: unknown) {
    diffError.value = describeEntitlementError(error);
  } finally {
    diffLoading.value = false;
  }
}

const snapshotOpen = ref(false);
const snapshotLoading = ref(false);
const snapshotError = shallowRef<EntitlementErrorView | null>(null);
const snapshotData = shallowRef<EntitlementSnapshot | null>(null);

async function viewSnapshot(snapshotId: string): Promise<void> {
  snapshotOpen.value = true;
  snapshotLoading.value = true;
  snapshotError.value = null;
  snapshotData.value = null;
  try {
    snapshotData.value = await fetchSnapshot(snapshotId);
  } catch (error: unknown) {
    snapshotError.value = describeEntitlementError(error);
  } finally {
    snapshotLoading.value = false;
  }
}

// ------------------------------------------------------------------ 变更申请创建

const createOpen = ref(false);
const createType = ref<ChangeRequestType | null>(null);

function openCreate(changeType?: ChangeRequestType): void {
  createType.value = changeType ?? null;
  createOpen.value = true;
}

async function onCreate(result: CreateChangeRequestResult): Promise<void> {
  createOpen.value = false;
  await load();
  emit('changed');
  await openDiff(result.changeRequest);
}

const changeColumns = [
  { dataIndex: 'changeType', key: 'changeType', title: '类型', width: 130 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 130 },
  { dataIndex: 'reason', key: 'reason', title: '原因', width: 260 },
  { dataIndex: 'requestedBy', key: 'requestedBy', title: '申请人', width: 130 },
  { dataIndex: 'approvedBy', key: 'approvedBy', title: '审批人', width: 130 },
  { dataIndex: 'createdAt', key: 'createdAt', title: '提交时间', width: 160 },
  { key: 'actions', title: '操作', width: 260 },
];

const canCreateChange = computed(
  () =>
    hasPermission(OPS_PERMISSION.ENTITLEMENT_REQUEST) &&
    (detail.value?.status === 'active' || detail.value?.status === 'suspended'),
);
</script>

<template>
  <Drawer
    :open="open"
    :title="`${subjectType === 'subscription' ? 'SaaS 订阅' : '私有授权'}详情`"
    :width="960"
    @close="emit('update:open', false)"
  >
    <Alert
      v-if="!canRead"
      data-testid="entitlement-detail-permission-denied"
      description="当前账号缺少 entitlement.read，按最小可见原则不展示任何权益明细、快照或变更历史。"
      message="无权查看权益明细"
      show-icon
      type="error"
    />

    <template v-else>
      <Spin :spinning="loading">
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="entitlement-detail-error"
          :message="loadError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ loadError.description }}</p>
            <Button class="mt-1" size="small" @click="load">重新加载</Button>
          </template>
        </Alert>

        <template v-if="detail">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <span class="text-base font-medium">{{ detail.no }}</span>
            <Tag :color="changeRequestStatusView(detail.status).color">
              {{ changeRequestStatusView(detail.status).label }}
            </Tag>
            <Tag v-if="detail.licenseMode" color="blue">
              {{ licenseModeLabel(detail.licenseMode) }}
            </Tag>
            <span class="text-xs text-muted-foreground">
              版本 v{{ detail.version ?? '—' }}
            </span>
          </div>

          <Alert
            v-if="permanentLicenseNote"
            class="mb-3"
            data-testid="entitlement-perpetual-note"
            :message="permanentLicenseNote"
            show-icon
            type="info"
          />

          <Card class="mb-3" size="small" title="基本信息">
            <Descriptions :column="2" bordered size="small">
              <Descriptions.Item label="客户">
                {{ detail.customerName }}
              </Descriptions.Item>
              <Descriptions.Item
                v-if="subjectType === 'subscription'"
                label="产品"
              >
                {{ detail.productName ?? '—' }}
              </Descriptions.Item>
              <Descriptions.Item v-else label="部署实例">
                {{ detail.deploymentName ?? '—' }}
              </Descriptions.Item>

              <Descriptions.Item
                v-if="subjectType === 'subscription'"
                label="计费周期"
              >
                {{ billingCycleLabel(detail.billingCycle) }}
              </Descriptions.Item>
              <Descriptions.Item v-else label="授权方式">
                {{ licenseModeLabel(detail.licenseMode) }}
              </Descriptions.Item>

              <Descriptions.Item
                v-if="subjectType === 'subscription'"
                label="订阅期间"
              >
                {{ formatDate(detail.startsOn) }} ~
                {{ detail.endsOn ? formatDate(detail.endsOn) : '未定' }}
              </Descriptions.Item>
              <Descriptions.Item v-else label="授权有效期">
                {{ formatDate(detail.validFrom) }} ~
                {{
                  detail.validTo
                    ? formatDate(detail.validTo)
                    : '永久（无到期日）'
                }}
              </Descriptions.Item>

              <Descriptions.Item
                v-if="subjectType === 'subscription'"
                label="自动续订意向"
              >
                {{ detail.autoRenewIntent ? '有（仅记录，不自动扣费）' : '无' }}
              </Descriptions.Item>
              <Descriptions.Item v-else label="维护期至">
                {{ formatDate(detail.maintenanceUntil ?? null) }}
              </Descriptions.Item>

              <Descriptions.Item label="来源合同条目">
                <span class="font-mono text-xs">{{
                  detail.contractItemId ?? '—'
                }}</span>
              </Descriptions.Item>
            </Descriptions>

            <p
              v-if="subjectType === 'license'"
              class="mt-2 text-xs text-muted-foreground"
            >
              永久授权仅表示软件使用无到期日；版本更新与技术支持以维护期为准，二者不得互相推导。
            </p>
          </Card>

          <Card class="mb-3" size="small" title="状态与可用动作">
            <StateMachinePanel
              :busy="highRisk.submitting.value"
              :granted-codes="[...grantedCodes]"
              :status="detail.status"
              @action="onStateAction"
            />
            <div v-if="canCreateChange" class="mt-3">
              <Button ghost size="small" type="primary" @click="openCreate()">
                发起权益变更申请
              </Button>
              <span class="ml-2 text-xs text-muted-foreground">
                暂停 / 恢复 / 撤销 / 到期 / 延期 / 升降级 /
                额度变更都必须通过变更申请
              </span>
            </div>
          </Card>

          <Card class="mb-3" size="small" title="当前权益快照（只读）">
            <template v-if="detail.snapshot">
              <div
                class="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
              >
                <span class="font-mono">{{ detail.snapshot.contentHash }}</span>
                <span>
                  {{ detail.snapshot.lines.length }} 个功能键 ·
                  {{ enabledFeatureCount(detail.snapshot) }} 项启用
                </span>
                <span class="text-xs">
                  生成于 {{ formatDateTime(detail.snapshot.createdAt) }}
                </span>
              </div>
              <SnapshotLinesTable :lines="detail.snapshot.lines" />
            </template>
            <Empty
              v-else
              description="尚无生效快照（草稿审批通过后才会成为当前快照）"
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
            />
          </Card>

          <Card class="mb-3" size="small" title="快照历史（只读）">
            <Alert
              v-if="historyDegraded"
              class="mb-2"
              message="未获取到快照历史（后端快照列表端点待确认），此处仅展示当前快照；历史快照本身不会被改写。"
              show-icon
              type="warning"
            />
            <SnapshotHistory
              :current-snapshot-id="detail.snapshot?.id ?? null"
              :snapshots="detail.snapshots"
              @view="viewSnapshot"
            />
          </Card>

          <Card size="small" title="变更申请">
            <Table
              :columns="changeColumns"
              :data-source="detail.changeRequests"
              :pagination="false"
              :row-key="(row: EntitlementChangeRequest) => row.id"
              :scroll="{ x: 1100 }"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'changeType'">
                  {{ changeTypeLabel(record.changeType) }}
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
                  {{
                    record.approvedBy ? actorName(record.approvedBy) : '未审批'
                  }}
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
                          onChangeRequestAction(
                            record as EntitlementChangeRequest,
                            action,
                          )
                      "
                    />
                    <Button
                      size="small"
                      type="link"
                      @click="openDiff(record as EntitlementChangeRequest)"
                    >
                      查看差异
                    </Button>
                  </div>
                </template>
              </template>
              <template #emptyText>
                <Empty
                  description="暂无变更申请"
                  :image="Empty.PRESENTED_IMAGE_SIMPLE"
                />
              </template>
            </Table>
            <p class="mt-2 text-xs text-muted-foreground">
              审批人必须与申请人不同；未审批的申请不能执行（服务端 409
              APPROVAL_REQUIRED）。
            </p>
          </Card>
        </template>
      </Spin>
    </template>

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

    <ChangeRequestCreateModal
      v-model:open="createOpen"
      :current-features="detail?.snapshot?.lines ?? []"
      :initial-change-type="createType"
      :subject-id="subjectId ?? ''"
      :subject-no="detail?.no ?? ''"
      :subject-type="subjectType"
      @created="onCreate"
    />

    <Modal
      v-model:open="diffOpen"
      :footer="null"
      :width="960"
      title="权益差异（服务端前后值摘要）"
    >
      <Spin :spinning="diffLoading">
        <Alert
          v-if="diffError"
          :message="diffError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ diffError.description }}</p>
          </template>
        </Alert>
        <template v-else-if="diffData">
          <div
            class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            <Tag
              :color="
                changeRequestStatusView(diffData.changeRequest.status).color
              "
            >
              {{ changeRequestStatusView(diffData.changeRequest.status).label }}
            </Tag>
            <span>
              {{ changeTypeLabel(diffData.changeRequest.changeType) }}
            </span>
            <span class="text-xs">
              申请人：{{ actorName(diffData.changeRequest.requestedBy) }}
            </span>
            <span v-if="diffData.command" class="font-mono">
              命令 {{ diffData.command.id }} · {{ diffData.command.status }}
            </span>
          </div>
          <Alert
            class="mb-2"
            :message="`变更原因：${diffData.changeRequest.reason}`"
            type="info"
          />
          <ChangeRequestDiff :diff="diffData.diff" />
          <div class="mt-3">
            <ChangeRequestActions
              :change-request="diffData.changeRequest"
              :current-operator-id="currentOperatorId"
              :granted-codes="[...grantedCodes]"
              @action="onDiffAction"
            />
          </div>
        </template>
        <Empty v-else description="正在加载差异…" />
      </Spin>
    </Modal>

    <Modal
      v-model:open="snapshotOpen"
      :footer="null"
      :width="820"
      title="历史快照明细（只读）"
    >
      <Spin :spinning="snapshotLoading">
        <Alert
          v-if="snapshotError"
          :message="snapshotError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ snapshotError.description }}</p>
          </template>
        </Alert>
        <template v-else-if="snapshotData">
          <p class="mb-2 text-xs text-muted-foreground">
            哈希 <span class="font-mono">{{ snapshotData.contentHash }}</span> ·
            生成于 {{ formatDateTime(snapshotData.createdAt) }} ·
            历史快照不可修改，任何调整只能新增变更申请
          </p>
          <SnapshotLinesTable :lines="snapshotData.lines" />
        </template>
      </Spin>
    </Modal>
  </Drawer>
</template>
