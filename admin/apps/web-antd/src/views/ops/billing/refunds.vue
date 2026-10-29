<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { BillingErrorView } from '#/api/ops/billing/errors';
import type { Receipt, Refund, RefundStatus } from '#/api/ops/billing/types';

import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  actorName,
  AMOUNT_ERROR_MESSAGE,
  createRefund,
  describeBillingError,
  fetchReceipts,
  fetchRefunds,
  formatDate,
  formatMoney,
  parseAmountInput,
  REFUND_STATUS_OPTIONS,
  refundStatusView,
  transitionRefund,
} from '#/api/ops/billing';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import DevDataNotice from './components/dev-data-notice.vue';
import HighRiskModal from './components/high-risk-modal.vue';
import { useHighRiskAction } from './composables/use-high-risk-action';

defineOptions({ name: 'BillingRefunds' });

const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.RECEIVABLE_READ));
const canRefund = computed(() => hasPermission(OPS_PERMISSION.RECEIPT_REFUND));

// ------------------------------------------------------------------ 列表

const rows = ref<Refund[]>([]);
const loading = ref(false);
const loadError = shallowRef<BillingErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  customerId: '',
  status: [] as RefundStatus[],
});
const dateFrom = ref<Dayjs>();
const dateTo = ref<Dayjs>();

const columns: TableColumnsType = [
  { dataIndex: 'refundNo', key: 'refundNo', title: '退款编号', width: 170 },
  { dataIndex: 'receiptNo', key: 'receiptNo', title: '原收款', width: 170 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 200 },
  { dataIndex: 'amount', key: 'amount', title: '退款金额', width: 140 },
  { dataIndex: 'refundDate', key: 'refundDate', title: '退款日期', width: 120 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 120 },
  { dataIndex: 'handledBy', key: 'handledBy', title: '经办人', width: 120 },
  { dataIndex: 'reason', key: 'reason', title: '原因', width: 220 },
  { key: 'actions', title: '操作', width: 150 },
];

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchRefunds({
      customerId: filters.customerId.trim() || undefined,
      dateFrom: dateFrom.value?.format('YYYY-MM-DD'),
      dateTo: dateTo.value?.format('YYYY-MM-DD'),
      order: 'desc',
      page: pagination.page,
      pageSize: pagination.pageSize,
      status: filters.status.length > 0 ? filters.status : undefined,
    });
    rows.value = result.items;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    pagination.total = 0;
    loadError.value = describeBillingError(error);
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig) {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

// ------------------------------------------------------------------ 高风险：退款审核/取消

type PendingRefundAction =
  | { kind: 'approve'; refund: Refund }
  | { kind: 'cancel'; refund: Refund };

const pendingAction = ref<null | PendingRefundAction>(null);

const action = useHighRiskAction<unknown>({
  actionLabel: '退款处理',
  execute: async ({ reason }) => {
    const context = pendingAction.value;
    if (!context) {
      throw new Error('缺少待执行动作上下文');
    }
    return transitionRefund(context.refund.id, {
      action: context.kind,
      reason,
    });
  },
  onSuccess: async () => {
    message.success('退款状态已更新');
    pendingAction.value = null;
    await load();
  },
});

const actionSummary = computed(() => {
  const context = pendingAction.value;
  if (!context) {
    return null;
  }
  return {
    impact:
      context.kind === 'approve'
        ? '审核通过后退款计入退款事实；若累计已审核退款等于收款金额，原收款状态变为「已退款」。'
        : '取消只记录审计，不删除退款登记；原收款状态不变。',
    rows: [
      { label: '退款编号', value: context.refund.refundNo },
      { label: '原收款', value: context.refund.receiptNo },
      {
        emphasis: true,
        label: '退款金额',
        value: formatMoney(context.refund.amount, context.refund.currency),
      },
      { label: '客户', value: context.refund.customer.name },
      { label: '退款日期', value: formatDate(context.refund.refundDate) },
    ],
    title: context.kind === 'approve' ? '审核退款' : '取消退款',
  };
});

function requestTransition(refund: Refund, kind: 'approve' | 'cancel') {
  if (!canRefund.value) {
    message.warning('缺少 receipt.refund 权限，不能处理退款');
    return;
  }
  if (refund.status !== 'recorded') {
    message.warning('只有「已登记未审核」的退款可以审核或取消');
    return;
  }
  pendingAction.value = { kind, refund };
}

// 选中待处理退款后打开确认弹窗：弹窗只呈现摘要，请求仍由用户点「确认执行」触发
watch(pendingAction, (context) => {
  if (context && actionSummary.value) {
    action.prepare(actionSummary.value);
  }
});

// ------------------------------------------------------------------ 登记退款

const createOpen = ref(false);
const receiptOptions = ref<Receipt[]>([]);
const receiptLoading = ref(false);
const form = reactive({
  amount: '',
  externalVoucherRef: '',
  receiptId: undefined as string | undefined,
  refundDate: undefined as Dayjs | undefined,
});
const formError = ref<null | string>(null);

const selectedReceipt = computed(
  () => receiptOptions.value.find((item) => item.id === form.receiptId) ?? null,
);

async function openCreate() {
  if (!canRefund.value) {
    message.warning('缺少 receipt.refund 权限，不能登记退款');
    return;
  }
  form.amount = '';
  form.externalVoucherRef = '';
  form.receiptId = undefined;
  form.refundDate = undefined;
  formError.value = null;
  createOpen.value = true;
  receiptLoading.value = true;
  try {
    const result = await fetchReceipts({
      order: 'desc',
      page: 1,
      pageSize: 100,
      status: ['pending_reconcile', 'reconciled'],
    });
    receiptOptions.value = result.items.filter(
      (item) => item.allocatedAmount > 0,
    );
  } catch (error: unknown) {
    formError.value = describeBillingError(error).description;
    receiptOptions.value = [];
  } finally {
    receiptLoading.value = false;
  }
}

const receiptSelectOptions = computed(() =>
  receiptOptions.value.map((item) => ({
    label: `${item.receiptNo} · ${item.customer.name} · ${formatMoney(item.amount, item.currency)}`,
    value: item.id,
  })),
);

function submitCreateForm() {
  const receipt = selectedReceipt.value;
  if (!receipt) {
    formError.value = '请选择原收款';
    return;
  }
  if (!form.refundDate) {
    formError.value = '请选择退款日期';
    return;
  }
  const parsed = parseAmountInput(form.amount);
  if (!parsed.ok) {
    formError.value = AMOUNT_ERROR_MESSAGE[parsed.error];
    return;
  }
  if (parsed.value > receipt.allocatedAmount) {
    formError.value = `退款金额不能超过该收款已核销净额 ${formatMoney(receipt.allocatedAmount, receipt.currency)}`;
    return;
  }
  formError.value = null;
  createOpen.value = false;
  const voucher = form.externalVoucherRef.trim();
  const refundDate = form.refundDate.format('YYYY-MM-DD');
  pendingCreate.value = {
    amount: parsed.value,
    ...(voucher === '' ? {} : { externalVoucherRef: voucher }),
    receiptId: receipt.id,
    refundDate,
  };
  createAction.prepare({
    impact:
      '登记退款会生成独立退款记录并关联原收款（原收款金额不变）；退款需审核后才计入退款事实。',
    rows: [
      { label: '原收款', value: receipt.receiptNo },
      { label: '客户', value: receipt.customer.name },
      {
        emphasis: true,
        label: '退款金额',
        value: formatMoney(parsed.value, receipt.currency),
      },
      { label: '退款日期', value: refundDate },
      { label: '外部凭证', value: voucher === '' ? '—' : voucher },
    ],
    title: '登记退款',
  });
}

interface PendingCreate {
  amount: number;
  externalVoucherRef?: string;
  receiptId: string;
  refundDate: string;
}

const pendingCreate = ref<null | PendingCreate>(null);

const createAction = useHighRiskAction<unknown>({
  actionLabel: '登记退款',
  execute: async ({ reason }) => {
    const payload = pendingCreate.value;
    if (!payload) {
      throw new Error('缺少退款表单数据');
    }
    return createRefund({ ...payload, reason });
  },
  onSuccess: async () => {
    message.success('退款已登记，等待审核');
    pendingCreate.value = null;
    await load();
  },
});

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="billing-permission-denied"
      description="当前账号缺少 receivable.read 动作码，本页不展示任何金额。"
      message="无查看账款权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="filters.customerId"
              allow-clear
              placeholder="按客户 ID 精确筛选"
              style="width: 200px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="REFUND_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 200px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">退款日期</div>
            <Space>
              <DatePicker v-model:value="dateFrom" placeholder="起" />
              <DatePicker v-model:value="dateTo" placeholder="止" />
            </Space>
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <div class="ml-auto">
            <Tooltip
              v-if="!canRefund"
              title="缺少 receipt.refund，不能登记退款"
            >
              <span><Button disabled>登记退款</Button></span>
            </Tooltip>
            <Button v-else type="primary" ghost @click="openCreate">
              登记退款
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
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
          :row-key="(row: Refund) => row.id"
          :scroll="{ x: 1400 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'amount'">
              {{ formatMoney(record.amount, record.currency) }}
            </template>
            <template v-else-if="column.key === 'refundDate'">
              {{ formatDate(record.refundDate) }}
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="refundStatusView(record.status).color">
                {{ refundStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'handledBy'">
              {{ actorName(record.handledBy) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Space>
                <Button
                  :disabled="!canRefund || record.status !== 'recorded'"
                  size="small"
                  type="link"
                  @click="requestTransition(record as Refund, 'approve')"
                >
                  审核
                </Button>
                <Button
                  :disabled="!canRefund || record.status !== 'recorded'"
                  danger
                  size="small"
                  type="link"
                  @click="requestTransition(record as Refund, 'cancel')"
                >
                  取消
                </Button>
              </Space>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有退款记录" />
          </template>
        </Table>
      </Card>
    </template>

    <HighRiskModal
      :action-label="
        pendingAction
          ? pendingAction.kind === 'approve'
            ? '审核退款'
            : '取消退款'
          : '退款处理'
      "
      :error="action.error.value"
      :open="action.open.value"
      :reason="action.reason.value"
      :reason-error="action.reasonError.value"
      :submitting="action.submitting.value"
      :summary="actionSummary"
      @confirm="action.confirm()"
      @update:open="action.open.value = $event"
      @update:reason="action.reason.value = $event"
    />

    <HighRiskModal
      action-label="登记退款"
      :error="createAction.error.value"
      :open="createAction.open.value"
      :reason="createAction.reason.value"
      :reason-error="createAction.reasonError.value"
      :submitting="createAction.submitting.value"
      :summary="createAction.summary.value"
      confirm-text="确认登记"
      @confirm="createAction.confirm()"
      @update:open="createAction.open.value = $event"
      @update:reason="createAction.reason.value = $event"
    />

    <Modal
      v-model:open="createOpen"
      :mask-closable="false"
      ok-text="下一步：确认"
      title="登记退款"
      @ok="submitCreateForm"
    >
      <Alert
        class="mb-3"
        message="首期不调用支付渠道发起退款，只登记线下退款事实。"
        show-icon
        type="info"
      />
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            原收款（仅列出已审核且有核销净额的收款）
          </div>
          <Select
            v-model:value="form.receiptId"
            :loading="receiptLoading"
            :options="receiptSelectOptions"
            placeholder="选择原收款"
            show-search
            style="width: 100%"
          />
        </div>
        <Descriptions v-if="selectedReceipt" :column="2" size="small">
          <Descriptions.Item label="收款金额">
            {{ formatMoney(selectedReceipt.amount, selectedReceipt.currency) }}
          </Descriptions.Item>
          <Descriptions.Item label="可退款净额上限">
            {{
              formatMoney(
                selectedReceipt.allocatedAmount,
                selectedReceipt.currency,
              )
            }}
          </Descriptions.Item>
        </Descriptions>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">退款金额</div>
          <Input v-model:value="form.amount" placeholder="如 2000.00" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">退款日期</div>
          <DatePicker v-model:value="form.refundDate" style="width: 100%" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            外部退款凭证引用（可空）
          </div>
          <Input
            v-model:value="form.externalVoucherRef"
            placeholder="银行回单号等"
          />
        </div>
        <Alert v-if="formError" :message="formError" show-icon type="error" />
      </div>
    </Modal>
  </div>
</template>
