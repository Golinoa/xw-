<script lang="ts" setup>
import type {
  CreateVersionRecordInput,
  DeploymentDetail,
  DeploymentErrorView,
  DeploymentInstance,
  DeploymentLicenseRef,
  DeploymentStateAction,
  DeploymentTransitionInput,
  UpdateDeploymentInput,
} from '#/api/ops/deployment';

import { computed, onMounted, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  message,
  Result,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  actorName,
  createVersionRecord,
  deploymentTypeLabel,
  describeDeploymentError,
  fetchDeployment,
  formatDate,
  formatDateTime,
  guardDeploymentAction,
  instanceStatusView,
  licenseModeLabel,
  maintenanceStateView,
  transitionDeployment,
  updateDeployment,
  versionText,
} from '#/api/ops/deployment';
import { isHighRiskPermission, OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import EditInstanceModal from './components/edit-instance-modal.vue';
import MaintenanceBanner from './components/maintenance-banner.vue';
import StatePanel from './components/state-panel.vue';
import TransitionConfirmModal from './components/transition-confirm-modal.vue';
import VersionHistory from './components/version-history.vue';
import VersionRecordModal from './components/version-record-modal.vue';
import { useServerToday } from './composables/use-server-today';

defineOptions({ name: 'DeploymentInstanceDetail' });

/**
 * 部署实例详情（PRD §6.8 / 契约 §3.7、§5.8）。
 *
 * 页面边界：
 * 1. **只登记事实**：升级是「登记已执行结果」，不触发远程安装，也没有任何环境凭据入口；
 * 2. 状态推进只能走 `transition`（面板动作 + 二次确认），没有直接改状态的控件；
 * 3. 版本历史只读：`deployment_version_records` 仅 INSERT，页面无编辑/删除入口；
 * 4. 维护期单独、显式展示，「永久授权 ≠ 永久更新」在维护期横幅里明示。
 */
const route = useRoute();
const router = useRouter();
const { grantedCodes, hasPermission } = useOpsPermission();

const deploymentId = computed(() => String(route.params.deploymentId ?? ''));
const canRead = computed(() => hasPermission(OPS_PERMISSION.DEPLOYMENT_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.DEPLOYMENT_WRITE));

/** 回到列表：用命名路由而不是 `back()`，直接打开详情链接时也能回到台账。 */
function goList(): void {
  void router.push({ name: 'DeploymentInstances' });
}

const detail = shallowRef<DeploymentDetail | null>(null);
const loading = ref(false);
const loadError = shallowRef<DeploymentErrorView | null>(null);

const {
  failed: serverTodayFailed,
  load: loadServerToday,
  today,
} = useServerToday();

async function load(): Promise<void> {
  if (!canRead.value || deploymentId.value === '') {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    detail.value = await fetchDeployment(deploymentId.value);
  } catch (error: unknown) {
    detail.value = null;
    loadError.value = describeDeploymentError(error);
  } finally {
    loading.value = false;
  }
}

const instance = computed<DeploymentInstance | null>(
  () => detail.value?.deployment ?? null,
);

const statusView = computed(() =>
  instanceStatusView(instance.value?.status ?? 'unknown'),
);

const maintenance = computed(() =>
  maintenanceStateView({
    maintenanceUntil: instance.value?.maintenanceUntil,
    referenceDate: today.value,
  }),
);

/** 关联的永久授权号：用于维护期横幅里的「永久授权 ≠ 永久更新」说明。 */
const perpetualLicenseNos = computed(() =>
  (detail.value?.licenses ?? [])
    .filter((item) => item.licenseMode === 'perpetual')
    .map((item) => item.licenseNo),
);

const canRegisterVersion = computed(
  () =>
    canWrite.value &&
    instance.value !== null &&
    instance.value.status !== 'retired',
);

const licenseColumns = [
  { key: 'licenseNo', title: '授权号', width: 200 },
  { key: 'licenseMode', title: '授权方式', width: 110 },
  { key: 'valid', title: '授权有效期', width: 220 },
  { key: 'maintenanceUntil', title: '维护期至', width: 130 },
  { key: 'status', title: '状态', width: 100 },
];

const ticketColumns = [
  { key: 'ticketNo', title: '工单号', width: 160 },
  { key: 'subject', title: '主题', width: 300 },
  { key: 'status', title: '状态', width: 110 },
  { key: 'priority', title: '优先级', width: 100 },
];

function isPerpetualMaintenancePassed(item: DeploymentLicenseRef): boolean {
  if (item.licenseMode !== 'perpetual') {
    return false;
  }
  return (
    maintenanceStateView({
      maintenanceUntil: item.maintenanceUntil,
      referenceDate: today.value,
    }).state !== 'healthy'
  );
}

// ------------------------------------------------------------------ 状态动作

const pendingAction = shallowRef<DeploymentStateAction | null>(null);
const confirmOpen = ref(false);
const confirming = ref(false);
const confirmError = shallowRef<DeploymentErrorView | null>(null);

/** 高风险标记来自权限目录（当前 `deployment.write` 不在高风险清单，标记为 false）。 */
const actionHighRisk = computed(() =>
  isHighRiskPermission(OPS_PERMISSION.DEPLOYMENT_WRITE),
);

function onStateAction(action: DeploymentStateAction): void {
  if (!instance.value) {
    return;
  }
  // 前置守卫（契约 §3.7）：例如 go_live 缺 go_live_on、或状态已不被允许
  const decision = guardDeploymentAction(action.key, instance.value);
  if (!decision.allowed) {
    message.warning(decision.message ?? '当前状态不允许该动作');
    return;
  }
  pendingAction.value = action;
  confirmError.value = null;
  confirmOpen.value = true;
}

/**
 * 只有用户在确认弹窗里通过校验（原因 + 勾选）后才会到这里，即**未确认不发请求**。
 */
async function onTransitionConfirm(reason: string): Promise<void> {
  const action = pendingAction.value;
  if (!action || !instance.value) {
    return;
  }
  confirming.value = true;
  confirmError.value = null;
  const payload: DeploymentTransitionInput = {
    action: action.key,
    reason: action.requiresReason ? reason : reason || undefined,
    version: instance.value.version ?? 0,
  };
  try {
    await transitionDeployment(instance.value.id, payload);
    confirmOpen.value = false;
    message.success('状态已更新，正在刷新最新数据');
    await load();
  } catch (error: unknown) {
    confirmError.value = describeDeploymentError(error);
    // 409 冲突必须刷新后重试：重新拉取，不用本地值覆盖
    if (confirmError.value.shouldRefresh) {
      await load();
    }
  } finally {
    confirming.value = false;
  }
}

function onConfirmOpenChange(open: boolean): void {
  confirmOpen.value = open;
  if (!open) {
    pendingAction.value = null;
  }
}

// ------------------------------------------------------------------ 升级登记

const versionModalOpen = ref(false);
const submittingVersion = ref(false);
const versionError = shallowRef<DeploymentErrorView | null>(null);

async function onVersionSubmit(input: CreateVersionRecordInput): Promise<void> {
  if (!instance.value) {
    return;
  }
  submittingVersion.value = true;
  versionError.value = null;
  try {
    await createVersionRecord(instance.value.id, input);
    versionModalOpen.value = false;
    message.success('升级结果已登记（仅追加，不会修改历史记录）');
    await load();
  } catch (error: unknown) {
    versionError.value = describeDeploymentError(error);
    if (versionError.value.shouldRefresh) {
      await load();
    }
  } finally {
    submittingVersion.value = false;
  }
}

// ------------------------------------------------------------------ 编辑

const editOpen = ref(false);
const savingEdit = ref(false);
const editError = shallowRef<DeploymentErrorView | null>(null);

async function onEditSubmit(input: UpdateDeploymentInput): Promise<void> {
  if (!instance.value) {
    return;
  }
  savingEdit.value = true;
  editError.value = null;
  try {
    await updateDeployment(instance.value.id, input);
    editOpen.value = false;
    message.success('实例信息已保存');
    await load();
  } catch (error: unknown) {
    editError.value = describeDeploymentError(error);
    if (editError.value.shouldRefresh) {
      await load();
    }
  } finally {
    savingEdit.value = false;
  }
}

onMounted(() => {
  void loadServerToday();
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="deployment-detail-permission-denied"
      description="当前账号缺少 deployment.read，按最小可见原则不展示任何实例信息、版本历史或授权关联。"
      message="无权查看实例详情"
      show-icon
      type="error"
    />

    <template v-else>
      <div class="mb-3">
        <Button size="small" type="link" @click="goList()">
          ← 返回实例列表
        </Button>
      </div>

      <Spin :spinning="loading">
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="deployment-detail-error"
          :message="loadError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ loadError.description }}</p>
              <p v-if="loadError.requestId" class="text-xs">
                请求 ID：<span class="font-mono">{{
                  loadError.requestId
                }}</span>
              </p>
              <Button size="small" @click="load">重新加载</Button>
            </div>
          </template>
        </Alert>

        <Result
          v-if="!loading && !loadError && !instance"
          status="404"
          sub-title="该实例不存在，或已不在你可查看的范围内。"
          title="未找到部署实例"
        >
          <template #extra>
            <Button type="primary" @click="goList()">返回列表</Button>
          </template>
        </Result>

        <template v-if="instance">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <span class="text-base font-medium">{{ instance.instanceNo }}</span>
            <span class="text-sm text-muted-foreground">{{
              instance.name
            }}</span>
            <Tag
              :color="statusView.color"
              data-testid="deployment-detail-status"
            >
              {{ statusView.label }}
            </Tag>
            <Tag color="blue">
              当前版本
              <span class="ml-1 font-mono">{{
                versionText(instance.currentVersion)
              }}</span>
            </Tag>
            <span class="text-xs text-muted-foreground">
              记录版本 v{{ instance.version ?? '—' }}
            </span>
          </div>

          <Alert
            v-if="serverTodayFailed"
            class="mb-3"
            data-testid="deployment-server-date-missing"
            message="未取到服务端业务日期，维护期状态暂不判定（不使用本机时钟推断到期）。"
            show-icon
            type="warning"
          />

          <MaintenanceBanner
            class="mb-3"
            :maintenance-until="instance.maintenanceUntil ?? null"
            :perpetual-license-nos="perpetualLicenseNos"
            :reference-date="today"
          />

          <Card class="mb-3" size="small" title="基本信息">
            <template #extra>
              <Tooltip v-if="!canWrite" title="缺少 deployment.write">
                <span><Button disabled size="small">编辑基础信息</Button></span>
              </Tooltip>
              <Button
                v-else
                :disabled="instance.status === 'retired'"
                size="small"
                @click="editOpen = true"
              >
                编辑基础信息
              </Button>
            </template>
            <Descriptions :column="2" bordered size="small">
              <Descriptions.Item label="客户">
                {{ instance.customer?.name ?? '—' }}
              </Descriptions.Item>
              <Descriptions.Item label="部署类型">
                {{ deploymentTypeLabel(instance.deploymentType) }}
              </Descriptions.Item>
              <Descriptions.Item label="客户环境标识">
                <!-- 只展示人工可读标识：台账不保存主机名/IP/凭据 -->
                {{ instance.environmentRef || '未登记' }}
              </Descriptions.Item>
              <Descriptions.Item label="上线日期">
                {{ formatDate(instance.goLiveOn) }}
              </Descriptions.Item>
              <Descriptions.Item label="维护期至">
                <Tag :color="maintenance.color" class="mr-1">
                  {{ maintenance.label }}
                </Tag>
                {{ formatDate(instance.maintenanceUntil) }}
              </Descriptions.Item>
              <Descriptions.Item label="负责人">
                {{ actorName(instance.owner ?? null) }}
              </Descriptions.Item>
              <Descriptions.Item label="关联合同">
                <span class="font-mono text-xs">
                  {{ instance.contractId || '未关联' }}
                </span>
              </Descriptions.Item>
              <Descriptions.Item label="最后上报时间">
                <Tooltip
                  title="契约 §3.7 无心跳/上报列：此处为最近一条版本升级记录的登记时间（契约推导）"
                >
                  {{ formatDateTime(instance.lastVersionRecordAt) }}
                </Tooltip>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card class="mb-3" size="small" title="状态与可用动作">
            <StatePanel
              :busy="confirming"
              :granted-codes="[...grantedCodes]"
              :status="instance.status"
              @action="onStateAction"
            />
            <p class="mt-2 text-xs text-muted-foreground">
              环境状态不自动改变合同或授权状态（PRD
              §8）；退役是终态，不提供删除。
            </p>
          </Card>

          <Card class="mb-3" size="small" title="版本升级登记">
            <div class="mb-3 flex flex-wrap items-center gap-3">
              <Tag color="blue">
                当前版本
                <span class="ml-1 font-mono">
                  {{ versionText(instance.currentVersion) }}
                </span>
              </Tag>
              <Tooltip
                v-if="!canWrite"
                title="缺少 deployment.write，不能登记升级结果"
              >
                <span><Button disabled size="small">登记升级结果</Button></span>
              </Tooltip>
              <Button
                v-else
                :disabled="!canRegisterVersion"
                ghost
                size="small"
                type="primary"
                @click="versionModalOpen = true"
              >
                登记升级结果
              </Button>
              <span class="text-xs text-muted-foreground">
                仅登记已由人工在客户环境完成的升级；后台不执行远程安装、不保存环境凭据
              </span>
            </div>

            <VersionHistory
              :loading="loading"
              :records="detail?.versionRecords ?? []"
            />
          </Card>

          <Card class="mb-3" size="small" title="关联授权（私有授权号）">
            <Table
              v-if="(detail?.licenses ?? []).length > 0"
              :columns="licenseColumns"
              :data-source="detail?.licenses ?? []"
              :pagination="false"
              :row-key="(row: DeploymentLicenseRef) => row.id"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'licenseNo'">
                  <span class="font-mono text-xs">{{ record.licenseNo }}</span>
                </template>
                <template v-else-if="column.key === 'licenseMode'">
                  {{ licenseModeLabel(record.licenseMode) }}
                </template>
                <template v-else-if="column.key === 'valid'">
                  {{ formatDate(record.validFrom) }} ~
                  {{
                    record.validTo
                      ? formatDate(record.validTo)
                      : '永久（无到期日）'
                  }}
                </template>
                <template v-else-if="column.key === 'maintenanceUntil'">
                  <span
                    :class="
                      isPerpetualMaintenancePassed(
                        record as DeploymentLicenseRef,
                      )
                        ? 'font-medium text-red-500'
                        : ''
                    "
                  >
                    {{ formatDate(record.maintenanceUntil) }}
                  </span>
                </template>
                <template v-else-if="column.key === 'status'">
                  <Tag>{{ record.status || '—' }}</Tag>
                </template>
              </template>
            </Table>
            <Empty
              v-else
              description="未关联私有授权；无授权时不得对外承诺版本更新与技术支持"
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
            />
            <p class="mt-2 text-xs text-muted-foreground">
              永久授权只表示软件使用无到期日，不代表包含永久更新；能否升级以维护期为准（PRD
              §6.6）。
            </p>
          </Card>

          <Card size="small" title="关联工单">
            <Table
              v-if="(detail?.tickets ?? []).length > 0"
              :columns="ticketColumns"
              :data-source="detail?.tickets ?? []"
              :pagination="false"
              :row-key="(row: { id: string }) => row.id"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'ticketNo'">
                  <span class="font-mono text-xs">{{
                    record.ticketNo || record.id
                  }}</span>
                </template>
                <template v-else-if="column.key === 'subject'">
                  {{ record.subject || '—' }}
                </template>
                <template v-else-if="column.key === 'status'">
                  <Tag>{{ record.status || '—' }}</Tag>
                </template>
                <template v-else-if="column.key === 'priority'">
                  {{ record.priority || '—' }}
                </template>
              </template>
            </Table>
            <Empty
              v-else
              description="该实例暂无关联工单"
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
            />
          </Card>
        </template>
      </Spin>
    </template>

    <TransitionConfirmModal
      v-model:open="confirmOpen"
      :action-label="pendingAction?.label ?? '状态变更'"
      :error="confirmError"
      :high-risk="actionHighRisk"
      :impact="pendingAction?.impact ?? ''"
      :requires-reason="pendingAction?.requiresReason ?? false"
      :submitting="confirming"
      :summary-rows="[
        { label: '实例编号', value: instance?.instanceNo ?? '—' },
        { label: '实例名称', value: instance?.name ?? '—' },
        { label: '客户', value: instance?.customer?.name ?? '—' },
        { label: '当前状态', value: statusView.label },
        { label: '当前版本', value: versionText(instance?.currentVersion) },
        {
          label: '所需动作码',
          value: pendingAction?.permission ?? OPS_PERMISSION.DEPLOYMENT_WRITE,
        },
      ]"
      @confirm="onTransitionConfirm"
      @update:open="onConfirmOpenChange"
    />

    <VersionRecordModal
      v-model:open="versionModalOpen"
      :current-version="instance?.currentVersion ?? null"
      :error="versionError"
      :submitting="submittingVersion"
      @submit="onVersionSubmit"
    />

    <EditInstanceModal
      v-model:open="editOpen"
      :error="editError"
      :instance="instance"
      :submitting="savingEdit"
      @submit="onEditSubmit"
    />
  </div>
</template>
