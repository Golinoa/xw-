<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
import type {
  ContractAttachment,
  ContractDetail,
  ContractEntitlementPreview,
  ContractItem,
  ContractTransitionAction,
  ContractVersionEntry,
} from '#/api/ops/contract';
import type { OpsPermission } from '#/constants/permissions';

/**
 * 合同详情：头颅信息、条目、版本快照、附件、应收与权益预览，以及状态迁移。
 *
 * 高风险动作口径（`contract.approve`，`isHighRiskPermission` 判定为 true）：
 * 二次确认弹窗 + 影响摘要 + 必填原因 + 显式勾选确认，未确认不发请求。
 * 中风险动作（提交/撤回，`contract.write`）同样要确认，但原因选填。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  message,
  Modal,
  Result,
  Space,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createContractRenewal,
  fetchContract,
  fetchContractAttachments,
  fetchContractEntitlementPreview,
  fetchContractVersions,
  transitionContract,
} from '#/api/ops/contract';
import { isHighRiskPermission, OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import HighRiskConfirm from './components/high-risk-confirm.vue';
import {
  BILLING_TYPE_LABEL,
  CONTRACT_ACTION_DATE_FIELD,
  CONTRACT_ACTION_HINT,
  CONTRACT_ACTION_LABEL,
  CONTRACT_APPROVE_ACTIONS,
  CONTRACT_STATUS_COLOR,
  CONTRACT_STATUS_LABEL,
  enumLabel,
  formatBytes,
  formatDate,
  formatDateTime,
  formatMoney,
  SALES_MODE_LABEL,
} from './format';

defineOptions({ name: 'ContractDetail' });

const route = useRoute();
const router = useRouter();
const { hasPermission } = useOpsPermission();

const contractId = computed(() => String(route.params.contractId ?? ''));
const canRead = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_WRITE));
const canApprove = computed(() =>
  hasPermission(OPS_PERMISSION.CONTRACT_APPROVE),
);

const detail = ref<ContractDetail | null>(null);
const versions = ref<ContractVersionEntry[]>([]);
const attachments = ref<ContractAttachment[]>([]);
const preview = ref<ContractEntitlementPreview | null>(null);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const [detailResult, versionResult, attachmentResult, previewResult] =
      await Promise.all([
        fetchContract(contractId.value),
        fetchContractVersions(contractId.value),
        fetchContractAttachments(contractId.value),
        fetchContractEntitlementPreview(contractId.value),
      ]);
    detail.value = detailResult;
    versions.value = versionResult.items;
    attachments.value = attachmentResult.items;
    preview.value = previewResult;
  } catch (error_) {
    error.value = toOpsApiError(error_);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

/** 服务端返回的 allowedActions 是唯一真源；权限不足时按钮不渲染。 */
const visibleActions = computed<ContractTransitionAction[]>(() =>
  (detail.value?.allowedActions ?? []).filter((action) =>
    CONTRACT_APPROVE_ACTIONS.has(action) ? canApprove.value : canWrite.value,
  ),
);

/** 因权限不足而被隐藏的动作，用于给用户明确说明（不影响服务端判定）。 */
const blockedActions = computed<ContractTransitionAction[]>(() =>
  (detail.value?.allowedActions ?? []).filter((action) =>
    CONTRACT_APPROVE_ACTIONS.has(action) ? !canApprove.value : !canWrite.value,
  ),
);

const approvedPermission = computed<OpsPermission>(
  () => OPS_PERMISSION.CONTRACT_APPROVE,
);
const highRisk = computed(() => isHighRiskPermission(approvedPermission.value));

const itemsColumns = [
  {
    dataIndex: 'itemNameSnapshot',
    key: 'itemNameSnapshot',
    title: '条目',
    width: 220,
  },
  { dataIndex: 'salesMode', key: 'salesMode', title: '销售方式', width: 110 },
  {
    dataIndex: 'billingType',
    key: 'billingType',
    title: '计费类型',
    width: 140,
  },
  { dataIndex: 'quantity', key: 'quantity', title: '数量', width: 80 },
  { dataIndex: 'unitPrice', key: 'unitPrice', title: '单价', width: 150 },
  { dataIndex: 'amount', key: 'amount', title: '金额', width: 150 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 100,
  },
  { key: 'priceVersion', title: '价格版本快照', width: 200 },
];

/* ---------------- 状态迁移 ---------------- */

const transition = reactive<{
  action: ContractTransitionAction;
  errorMessage: null | string;
  open: boolean;
  submitting: boolean;
}>({
  action: 'submit',
  errorMessage: null,
  open: false,
  submitting: false,
});

const transitionDate = ref('');

const isApproveAction = computed(() =>
  CONTRACT_APPROVE_ACTIONS.has(transition.action),
);
const dateField = computed(
  () => CONTRACT_ACTION_DATE_FIELD[transition.action] ?? null,
);

/** 影响摘要：来自已加载的详情（服务端在 migrate 响应里另给 impact，这里用于确认前预览）。 */
const impactItems = computed(() => {
  const current = detail.value;
  if (!current) {
    return [];
  }
  return [
    {
      label: '合同金额',
      value: formatMoney(
        current.contract.totalAmount,
        current.contract.currency,
      ),
    },
    { label: '条目数量', value: `${current.items.length} 条` },
    { label: '应收期数', value: `${current.receivables.length} 期` },
    { label: '订阅', value: `${current.subscriptions.length} 个` },
    { label: '授权', value: `${current.licenses.length} 个` },
    { label: '附件', value: `${attachments.value.length} 个` },
  ];
});

function openTransition(action: ContractTransitionAction) {
  transition.open = true;
  transition.action = action;
  transition.errorMessage = null;
  transitionDate.value = '';
}

async function submitTransition(reason: string) {
  const current = detail.value;
  if (!current) {
    return;
  }
  if (dateField.value && transitionDate.value === '') {
    transition.errorMessage =
      dateField.value === 'signedOn' ? '请填写签约日期' : '请填写生效日期';
    return;
  }
  transition.submitting = true;
  transition.errorMessage = null;
  try {
    const result = await transitionContract(contractId.value, {
      action: transition.action,
      confirmImpact: transition.action === 'terminate' ? true : undefined,
      effectiveOn:
        dateField.value === 'effectiveOn' ? transitionDate.value : undefined,
      reason: reason || undefined,
      signedOn:
        dateField.value === 'signedOn' ? transitionDate.value : undefined,
      version: current.contract.version,
    });
    transition.open = false;
    message.success(
      `已执行：${CONTRACT_ACTION_LABEL[transition.action]}${
        result.createdVersionNo
          ? `（生成版本 v${result.createdVersionNo}）`
          : ''
      }`,
    );
    await load();
  } catch (error_) {
    // 403/409 保留弹窗内输入，便于用户看到原因后重试
    transition.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    transition.submitting = false;
  }
}

/* ---------------- 续约 ---------------- */

const renewal = reactive<{
  effectiveOn: string;
  errorMessage: null | string;
  expiresOn: string;
  open: boolean;
  reason: string;
  submitting: boolean;
}>({
  effectiveOn: '',
  errorMessage: null,
  expiresOn: '',
  open: false,
  reason: '',
  submitting: false,
});

function openRenewal() {
  renewal.open = true;
  renewal.errorMessage = null;
  renewal.reason = '';
  renewal.effectiveOn = '';
  renewal.expiresOn = '';
}

function renewalItems() {
  const current = detail.value;
  if (!current) {
    return [];
  }
  return current.items.map((item: ContractItem) => ({
    // 续约默认沿用原条目的价格版本与单价；改价应在续约前先新增价格版本
    packageId: item.packageId ?? '',
    priceVersionId: item.packagePriceVersionId ?? '',
    productId: item.productId ?? '',
    quantity: item.quantity,
    termMonths: item.termMonths ?? undefined,
    unitPrice: item.unitPrice,
  }));
}

async function submitRenewal() {
  if (renewal.effectiveOn === '' || renewal.expiresOn === '') {
    renewal.errorMessage = '请填写续约后的生效日与到期日';
    return;
  }
  if (renewal.reason.trim() === '') {
    renewal.errorMessage = '续约必须填写原因';
    return;
  }
  renewal.submitting = true;
  renewal.errorMessage = null;
  try {
    const result = await createContractRenewal(contractId.value, {
      effectiveOn: renewal.effectiveOn,
      expiresOn: renewal.expiresOn,
      items: renewalItems(),
      reason: renewal.reason.trim(),
    });
    renewal.open = false;
    message.success(`续约合同已创建：${result.contract.contractNo}`);
    void router.push({
      name: 'ContractDetail',
      params: { contractId: result.contract.id },
    });
  } catch (error_) {
    // 409 RENEWAL_NOT_DUE / PACKAGE_RETIRED 等：保留输入
    renewal.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    renewal.submitting = false;
  }
}

const versionColumns = [
  { dataIndex: 'versionNo', key: 'versionNo', title: '版本', width: 100 },
  {
    dataIndex: 'changeReason',
    key: 'changeReason',
    title: '变更原因',
    width: 260,
  },
  {
    dataIndex: 'snapshotSummary',
    key: 'snapshotSummary',
    title: '快照摘要',
    width: 240,
  },
  { dataIndex: 'createdBy', key: 'createdBy', title: '创建人', width: 140 },
  { dataIndex: 'createdAt', key: 'createdAt', title: '创建时间', width: 170 },
];

const attachmentColumns = [
  { dataIndex: 'fileName', key: 'fileName', title: '文件名', width: 280 },
  { dataIndex: 'contentType', key: 'contentType', title: '类型', width: 200 },
  { dataIndex: 'byteSize', key: 'byteSize', title: '大小', width: 110 },
  { dataIndex: 'uploadedBy', key: 'uploadedBy', title: '上传人', width: 140 },
  { dataIndex: 'uploadedAt', key: 'uploadedAt', title: '上传时间', width: 170 },
];

const previewColumns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 200 },
  {
    dataIndex: 'displayName',
    key: 'displayName',
    title: '显示名称',
    width: 180,
  },
  { dataIndex: 'enabled', key: 'enabled', title: '启用', width: 90 },
  { dataIndex: 'quota', key: 'quota', title: '额度', width: 120 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 110,
  },
  { dataIndex: 'appliesTo', key: 'appliesTo', title: '适用范围', width: 160 },
];

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CONTRACT_READ]"
      title="合同详情"
    />

    <template v-else>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Space>
          <Button @click="router.push({ name: 'ContractList' })">
            返回合同列表
          </Button>
          <span class="text-lg font-medium">合同详情</span>
        </Space>
        <Space v-if="detail">
          <Button
            v-for="action in visibleActions"
            :key="action"
            :danger="action === 'terminate'"
            @click="openTransition(action)"
          >
            {{ CONTRACT_ACTION_LABEL[action] }}
          </Button>
          <Button
            v-if="
              canWrite &&
              (detail.contract.status === 'active' ||
                detail.contract.status === 'expired')
            "
            @click="openRenewal"
          >
            发起续约
          </Button>
        </Space>
      </div>

      <Alert
        v-if="detail && blockedActions.length > 0"
        class="mb-3"
        type="info"
        show-icon
        message="部分动作需要更高权限"
        :description="`${blockedActions.map((action) => CONTRACT_ACTION_LABEL[action]).join('、')} 需要 contract.approve。授权以服务端判定为准，界面隐藏不构成授权。`"
      />

      <Card v-if="loading" class="mb-4">
        <div class="flex justify-center py-10"><Spin /></div>
      </Card>

      <OpsErrorAlert
        v-else-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Result
        v-else-if="!detail"
        status="404"
        title="合同不存在或已被移除"
        sub-title="请确认链接，或返回合同列表重新选择。"
      />

      <template v-else>
        <Card
          class="mb-4"
          :title="`${detail.contract.contractNo} · ${detail.contract.customer.name}`"
        >
          <template #extra>
            <Tag
              :color="
                CONTRACT_STATUS_COLOR[
                  detail.contract.status as keyof typeof CONTRACT_STATUS_COLOR
                ]
              "
            >
              {{ enumLabel(CONTRACT_STATUS_LABEL, detail.contract.status) }}
            </Tag>
          </template>

          <div
            class="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 xl:grid-cols-3"
          >
            <div>
              <span class="text-muted-foreground">合同金额：</span>
              <span class="font-medium">
                {{
                  formatMoney(
                    detail.contract.totalAmount,
                    detail.contract.currency,
                  )
                }}
              </span>
            </div>
            <div>
              <span class="text-muted-foreground">销售方式：</span>
              {{ enumLabel(SALES_MODE_LABEL, detail.contract.salesMode) }}
            </div>
            <div>
              <span class="text-muted-foreground">销售负责人：</span>
              {{ detail.contract.salesOwner?.displayName ?? '—' }}
            </div>
            <div>
              <span class="text-muted-foreground">签约日：</span>
              {{ formatDate(detail.contract.signedOn) }}
            </div>
            <div>
              <span class="text-muted-foreground">生效 / 到期：</span>
              {{ formatDate(detail.contract.effectiveOn) }} ~
              {{ formatDate(detail.contract.expiresOn) }}
            </div>
            <div>
              <span class="text-muted-foreground">当前版本：</span>
              v{{ detail.contract.currentVersionNo }}
              <span class="ml-2 text-xs text-muted-foreground">
                （乐观锁版本 v{{ detail.contract.version }}）
              </span>
            </div>
            <div class="md:col-span-2 xl:col-span-3">
              <span class="text-muted-foreground">付款条款：</span>
              {{ detail.contract.paymentTerms ?? '—' }}
            </div>
            <div class="md:col-span-2 xl:col-span-3">
              <span class="text-muted-foreground">含税口径：</span>
              {{ detail.contract.taxNote ?? '—' }}
            </div>
            <div
              v-if="detail.contract.statusReason"
              class="md:col-span-2 xl:col-span-3"
            >
              <span class="text-muted-foreground">状态原因：</span>
              {{ detail.contract.statusReason }}
            </div>
            <div
              v-if="detail.contract.renewedFromContractId"
              class="md:col-span-2 xl:col-span-3"
            >
              <span class="text-muted-foreground">续约来源：</span>
              {{ detail.contract.renewedFromContractId }}（续约不改写原合同）
            </div>
          </div>
          <p class="mt-3 text-xs text-muted-foreground">
            合同签署 ≠ 已收款；收款状态在账款域独立计算（PRD §6.4）。
          </p>
        </Card>

        <Card class="mb-4" title="合同条目">
          <Table
            size="small"
            row-key="id"
            :columns="itemsColumns"
            :data-source="detail.items"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'salesMode'">
                {{ enumLabel(SALES_MODE_LABEL, record.salesMode) }}
              </template>
              <template v-else-if="column.key === 'billingType'">
                {{ enumLabel(BILLING_TYPE_LABEL, record.billingType) }}
              </template>
              <template v-else-if="column.key === 'unitPrice'">
                {{ formatMoney(record.unitPrice, detail.contract.currency) }}
              </template>
              <template v-else-if="column.key === 'amount'">
                {{ formatMoney(record.amount, detail.contract.currency) }}
              </template>
              <template v-else-if="column.key === 'termMonths'">
                {{ record.termMonths ?? '—' }}
              </template>
              <template v-else-if="column.key === 'priceVersion'">
                <span class="font-mono text-xs">{{
                  record.packagePriceVersionId ?? '—'
                }}</span>
                <p class="text-xs text-muted-foreground">
                  签署时快照，不随套餐改价变化
                </p>
              </template>
            </template>
          </Table>
        </Card>

        <div class="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="版本记录（只读快照）">
            <Table
              size="small"
              row-key="versionNo"
              :columns="versionColumns"
              :data-source="versions"
              :pagination="false"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'versionNo'">
                  v{{ record.versionNo }}
                </template>
                <template v-else-if="column.key === 'snapshotSummary'">
                  <span
                    v-if="record.snapshotSummary?.totalAmount !== undefined"
                  >
                    {{
                      formatMoney(
                        record.snapshotSummary.totalAmount,
                        record.snapshotSummary.currency ??
                          detail.contract.currency,
                      )
                    }}
                    · {{ record.snapshotSummary.itemCount ?? '—' }} 条
                  </span>
                  <span v-else class="text-xs text-muted-foreground">—</span>
                </template>
                <template v-else-if="column.key === 'createdBy'">
                  {{ record.createdBy ?? '—' }}
                </template>
                <template v-else-if="column.key === 'createdAt'">
                  {{ formatDateTime(record.createdAt) }}
                </template>
              </template>
              <template #emptyText>
                <div class="py-6 text-center text-sm text-muted-foreground">
                  尚无版本快照。合同生效时会写入第 1 个快照（契约 §3.3）。
                </div>
              </template>
            </Table>
          </Card>

          <Card title="应收摘要">
            <Table
              size="small"
              row-key="id"
              :data-source="detail.receivables"
              :pagination="false"
              :columns="[
                {
                  dataIndex: 'periodNo',
                  key: 'periodNo',
                  title: '期次',
                  width: 80,
                },
                {
                  dataIndex: 'dueDate',
                  key: 'dueDate',
                  title: '计划日期',
                  width: 130,
                },
                {
                  dataIndex: 'amount',
                  key: 'amount',
                  title: '金额',
                  width: 140,
                },
                {
                  dataIndex: 'outstanding',
                  key: 'outstanding',
                  title: '未收',
                  width: 140,
                },
                {
                  dataIndex: 'status',
                  key: 'status',
                  title: '状态',
                  width: 110,
                },
              ]"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'amount'">
                  {{
                    formatMoney(
                      record.amount,
                      record.currency ?? detail.contract.currency,
                    )
                  }}
                </template>
                <template v-else-if="column.key === 'outstanding'">
                  {{
                    formatMoney(
                      record.outstanding,
                      record.currency ?? detail.contract.currency,
                    )
                  }}
                </template>
              </template>
              <template #emptyText>
                <div class="py-6 text-center text-sm text-muted-foreground">
                  尚未生成应收计划（由账款域按付款条款创建）。
                </div>
              </template>
            </Table>
          </Card>
        </div>

        <Card class="mb-4" title="合同附件">
          <Table
            size="small"
            row-key="id"
            :columns="attachmentColumns"
            :data-source="attachments"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'byteSize'">
                {{ formatBytes(record.byteSize) }}
              </template>
              <template v-else-if="column.key === 'uploadedBy'">
                {{ record.uploadedBy ?? '—' }}
              </template>
              <template v-else-if="column.key === 'uploadedAt'">
                {{ formatDateTime(record.uploadedAt) }}
              </template>
            </template>
            <template #emptyText>
              <div class="py-6 text-center text-sm text-muted-foreground">
                暂无附件。附件只存元数据与安全访问引用，不通过公开 URL 暴露（PRD
                §6.4）。
              </div>
            </template>
          </Table>
          <p class="mt-2 text-xs text-muted-foreground">
            上传入口待存储契约（两段式签名 URL，契约 §11
            U-13）落地后开放；本期仅展示既有附件元数据。
          </p>
        </Card>

        <Card title="权益预览">
          <Alert
            v-for="warning in preview?.warnings ?? []"
            :key="warning"
            class="mb-2"
            type="warning"
            show-icon
            :message="warning"
          />
          <Table
            size="small"
            row-key="featureKey"
            :columns="previewColumns"
            :data-source="preview?.features ?? []"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'enabled'">
                <Tag :color="record.enabled ? 'green' : 'default'">
                  {{ record.enabled ? '启用' : '关闭' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'quota'">
                {{ record.quota ?? '—' }}
              </template>
              <template v-else-if="column.key === 'termMonths'">
                {{ record.termMonths ?? '—' }}
              </template>
            </template>
            <template #emptyText>
              <div class="py-6 text-center text-sm text-muted-foreground">
                该合同尚无可预览的权益。
              </div>
            </template>
          </Table>
        </Card>
      </template>
    </template>

    <HighRiskConfirm
      :open="transition.open"
      :title="`${CONTRACT_ACTION_LABEL[transition.action]} · ${detail?.contract.contractNo ?? ''}`"
      :action-label="CONTRACT_ACTION_LABEL[transition.action]"
      :permission-label="
        isApproveAction
          ? OPS_PERMISSION.CONTRACT_APPROVE
          : OPS_PERMISSION.CONTRACT_WRITE
      "
      :hint="CONTRACT_ACTION_HINT[transition.action]"
      :impact-items="impactItems"
      :reason-required="isApproveAction"
      :submitting="transition.submitting"
      :error-message="transition.errorMessage"
      :ok-text="CONTRACT_ACTION_LABEL[transition.action]"
      :danger="transition.action === 'terminate'"
      @cancel="transition.open = false"
      @confirm="submitTransition"
    >
      <div v-if="dateField" class="mb-3">
        <p class="mb-1 text-sm">
          {{ dateField === 'signedOn' ? '签约日期' : '生效日期' }}（必填）
        </p>
        <DatePicker v-model:value="transitionDate" value-format="YYYY-MM-DD" />
      </div>
      <p class="mb-2 text-xs text-muted-foreground">
        当前合同高风险动作判定：{{
          highRisk
            ? 'contract.approve 属高风险，需二次确认 + 原因'
            : '中风险动作'
        }}
      </p>
    </HighRiskConfirm>

    <Modal
      v-model:open="renewal.open"
      title="发起续约（新建合同，不改写原合同）"
      ok-text="创建续约合同"
      cancel-text="取消"
      :confirm-loading="renewal.submitting"
      @ok="submitRenewal"
    >
      <OpsErrorAlert
        v-if="renewal.errorMessage"
        :message="renewal.errorMessage"
        :retryable="false"
      />

      <div class="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <p class="mb-1 text-sm">续约生效日</p>
          <DatePicker
            v-model:value="renewal.effectiveOn"
            class="w-full"
            value-format="YYYY-MM-DD"
          />
        </div>
        <div>
          <p class="mb-1 text-sm">续约到期日</p>
          <DatePicker
            v-model:value="renewal.expiresOn"
            class="w-full"
            value-format="YYYY-MM-DD"
          />
        </div>
      </div>

      <p class="mb-1 text-sm">沿用条目（价格版本与单价取自原合同快照）</p>
      <ul class="mb-3 list-inside list-disc text-xs text-muted-foreground">
        <li v-for="item in detail?.items ?? []" :key="item.id">
          {{ item.itemNameSnapshot }} × {{ item.quantity }} ·
          {{ formatMoney(item.unitPrice, detail?.contract.currency ?? 'CNY') }}
        </li>
      </ul>

      <label class="mb-1 block text-sm" for="renewal-reason"
        >续约原因（必填）</label
      >
      <Input.TextArea
        id="renewal-reason"
        v-model:value="renewal.reason"
        :maxlength="200"
        :rows="3"
        placeholder="说明续约背景、期限与价格调整依据"
      />
      <p class="mt-2 text-xs text-muted-foreground">
        原合同未到期且未终止时，服务端会返回 409
        RENEWAL_NOT_DUE，需要业务显式确认后再续约。
      </p>
    </Modal>
  </div>
</template>
