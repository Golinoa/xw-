<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { BillingErrorView } from '#/api/ops/billing/errors';
import type {
  Receipt,
  ReceiptListQuery,
  ReceiptStatus,
} from '#/api/ops/billing/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
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
  createReceipt,
  describeBillingError,
  fetchReceipts,
  formatDate,
  formatMoney,
  methodLabel,
  parseAmountInput,
  RECEIPT_METHOD_OPTIONS,
  RECEIPT_STATUS_OPTIONS,
  receiptStatusView,
} from '#/api/ops/billing';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import DevDataNotice from './components/dev-data-notice.vue';
import ReceiptDetailDrawer from './components/receipt-detail-drawer.vue';

defineOptions({ name: 'BillingReceipts' });

const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.RECEIVABLE_READ));
const canRecord = computed(() => hasPermission(OPS_PERMISSION.RECEIPT_RECORD));

// ------------------------------------------------------------------ 列表

const rows = ref<Receipt[]>([]);
const loading = ref(false);
const loadError = shallowRef<BillingErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  customerId: '',
  methodCode: undefined as string | undefined,
  status: [] as ReceiptStatus[],
});
const dateFrom = ref<Dayjs>();
const dateTo = ref<Dayjs>();

const columns: TableColumnsType = [
  { dataIndex: 'receiptNo', key: 'receiptNo', title: '收款编号', width: 170 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 210 },
  {
    dataIndex: 'transactionDate',
    key: 'transactionDate',
    title: '交易日期',
    width: 120,
  },
  { dataIndex: 'amount', key: 'amount', title: '金额', width: 140 },
  { dataIndex: 'method', key: 'method', title: '方式', width: 110 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 140 },
  {
    dataIndex: 'allocatedAmount',
    key: 'allocatedAmount',
    title: '已核销净额',
    width: 140,
  },
  { dataIndex: 'recordedBy', key: 'recordedBy', title: '登记人', width: 130 },
  { dataIndex: 'approvedBy', key: 'approvedBy', title: '审核人', width: 130 },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): ReceiptListQuery {
  return {
    customerId: filters.customerId.trim() || undefined,
    dateFrom: dateFrom.value?.format('YYYY-MM-DD'),
    dateTo: dateTo.value?.format('YYYY-MM-DD'),
    methodCode: filters.methodCode || undefined,
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    status: filters.status.length > 0 ? filters.status : undefined,
  };
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchReceipts(buildQuery());
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

function onReset() {
  filters.customerId = '';
  filters.methodCode = undefined;
  filters.status = [];
  dateFrom.value = undefined;
  dateTo.value = undefined;
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig) {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

// ------------------------------------------------------------------ 详情

const detailOpen = ref(false);
const activeReceiptId = ref<null | string>(null);

function openDetail(row: Receipt) {
  activeReceiptId.value = row.id;
  detailOpen.value = true;
}

// ------------------------------------------------------------------ 登记收款

const recordOpen = ref(false);
const recordForm = reactive({
  amount: '',
  contractId: '',
  currency: 'CNY',
  customerId: '',
  methodCode: 'bank_transfer',
  referenceNo: '',
  transactionDate: undefined as Dayjs | undefined,
  voucherRef: '',
});
const recordErrors = ref<Record<string, string>>({});
const recordSubmitting = ref(false);
const recordError = shallowRef<BillingErrorView | null>(null);
const duplicateWarnings = ref<string[]>([]);

const currencyOptions = [
  { label: 'CNY 人民币', value: 'CNY' },
  { label: 'USD 美元', value: 'USD' },
  { label: 'HKD 港币', value: 'HKD' },
];

function openRecord() {
  recordForm.amount = '';
  recordForm.contractId = '';
  recordForm.currency = 'CNY';
  recordForm.customerId = filters.customerId.trim();
  recordForm.methodCode = 'bank_transfer';
  recordForm.referenceNo = '';
  recordForm.transactionDate = undefined;
  recordForm.voucherRef = '';
  recordErrors.value = {};
  recordError.value = null;
  duplicateWarnings.value = [];
  recordOpen.value = true;
}

async function submitRecord() {
  if (recordSubmitting.value) {
    return;
  }
  const errors: Record<string, string> = {};
  if (recordForm.customerId.trim() === '') {
    errors.customerId = '请填写客户 ID（客户选择器待客户域联调）';
  }
  if (!recordForm.transactionDate) {
    errors.transactionDate = '请选择交易日期';
  }
  if (recordForm.methodCode === '') {
    errors.methodCode = '请选择收款方式';
  }
  const parsed = parseAmountInput(recordForm.amount);
  if (!parsed.ok) {
    errors.amount = AMOUNT_ERROR_MESSAGE[parsed.error];
  }
  recordErrors.value = errors;
  if (
    Object.keys(errors).length > 0 ||
    !parsed.ok ||
    !recordForm.transactionDate
  ) {
    return;
  }

  recordSubmitting.value = true;
  recordError.value = null;
  try {
    const contractId = recordForm.contractId.trim();
    const referenceNo = recordForm.referenceNo.trim();
    const voucherRef = recordForm.voucherRef.trim();
    const result = await createReceipt({
      amount: parsed.value,
      currency: recordForm.currency,
      customerId: recordForm.customerId.trim(),
      methodCode: recordForm.methodCode,
      transactionDate: recordForm.transactionDate.format('YYYY-MM-DD'),
      ...(contractId === '' ? {} : { contractId }),
      ...(referenceNo === '' ? {} : { referenceNo }),
      ...(voucherRef === '' ? {} : { voucherRef }),
    });
    duplicateWarnings.value = result.duplicateWarnings ?? [];
    message.success(
      `收款 ${result.receipt.receiptNo} 已登记，等待登记人以外的运营人员审核后才计入实收`,
    );
    recordOpen.value = false;
    await load();
  } catch (error: unknown) {
    const view = describeBillingError(error);
    recordError.value = view;
    // 409（同流水号重复登记）需要刷新，避免用旧列表判断是否已存在
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    recordSubmitting.value = false;
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
      data-testid="billing-permission-denied"
      description="当前账号缺少 receivable.read 动作码。为避免敏感金额泄漏，本页不展示任何金额与明细。如需开通请联系运营管理员。"
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
              :options="RECEIPT_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 210px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">收款方式</div>
            <Select
              v-model:value="filters.methodCode"
              :options="RECEIPT_METHOD_OPTIONS"
              allow-clear
              placeholder="全部方式"
              style="width: 160px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">交易日期</div>
            <Space>
              <DatePicker v-model:value="dateFrom" placeholder="起" />
              <DatePicker v-model:value="dateTo" placeholder="止" />
            </Space>
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
          <div class="ml-auto">
            <Tooltip
              v-if="!canRecord"
              title="缺少 receipt.record，不能登记收款"
            >
              <span>
                <Button disabled>登记线下收款</Button>
              </span>
            </Tooltip>
            <Button v-else type="primary" ghost @click="openRecord">
              登记线下收款
            </Button>
          </div>
        </div>
      </Card>

      <Alert
        v-if="duplicateWarnings.length > 0"
        class="mb-3"
        :message="`检测到可能重复的收款流水号：${duplicateWarnings.join('；')}`"
        closable
        show-icon
        type="warning"
        @close="duplicateWarnings = []"
      />

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="billing-list-error"
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
          :row-key="(row: Receipt) => row.id"
          :scroll="{ x: 1400 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'transactionDate'">
              {{ formatDate(record.transactionDate) }}
            </template>
            <template v-else-if="column.key === 'amount'">
              {{ formatMoney(record.amount, record.currency) }}
            </template>
            <template v-else-if="column.key === 'method'">
              {{ methodLabel(record.method) }}
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="receiptStatusView(record.status).color">
                {{ receiptStatusView(record.status).label }}
              </Tag>
              <div class="mt-1 text-xs text-muted-foreground">
                {{ record.status === 'recorded' ? '不计入实收' : '计入实收' }}
              </div>
            </template>
            <template v-else-if="column.key === 'allocatedAmount'">
              {{ formatMoney(record.allocatedAmount, record.currency) }}
            </template>
            <template v-else-if="column.key === 'recordedBy'">
              {{ actorName(record.recordedBy) }}
            </template>
            <template v-else-if="column.key === 'approvedBy'">
              {{ record.approvedBy ? actorName(record.approvedBy) : '未审核' }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as Receipt)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有收款记录" />
          </template>
        </Table>
      </Card>
    </template>

    <ReceiptDetailDrawer
      v-model:open="detailOpen"
      :receipt-id="activeReceiptId"
      @changed="load"
    />

    <Modal
      v-model:open="recordOpen"
      :confirm-loading="recordSubmitting"
      :mask-closable="false"
      :width="720"
      ok-text="登记收款"
      title="登记线下收款"
      @ok="submitRecord"
    >
      <Alert
        class="mb-3"
        message="登记后状态为「已登记未审核」，不计入实收；必须由登记人以外的运营人员使用 receipt.approve 审核。"
        show-icon
        type="info"
      />
      <div class="space-y-3">
        <div class="grid gap-3 md:grid-cols-2">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="recordForm.customerId"
              :status="recordErrors.customerId ? 'error' : undefined"
              placeholder="填写软件客户 ID"
            />
            <p v-if="recordErrors.customerId" class="mt-1 text-xs text-red-500">
              {{ recordErrors.customerId }}
            </p>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">
              合同 ID（可空）
            </div>
            <Input
              v-model:value="recordForm.contractId"
              placeholder="未指定合同时留空"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">交易日期</div>
            <DatePicker
              v-model:value="recordForm.transactionDate"
              :status="recordErrors.transactionDate ? 'error' : undefined"
              style="width: 100%"
            />
            <p
              v-if="recordErrors.transactionDate"
              class="mt-1 text-xs text-red-500"
            >
              {{ recordErrors.transactionDate }}
            </p>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">金额</div>
            <Input
              v-model:value="recordForm.amount"
              :status="recordErrors.amount ? 'error' : undefined"
              placeholder="如 86000.00"
            />
            <p v-if="recordErrors.amount" class="mt-1 text-xs text-red-500">
              {{ recordErrors.amount }}
            </p>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">币种</div>
            <Select
              v-model:value="recordForm.currency"
              :options="currencyOptions"
              style="width: 100%"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">收款方式</div>
            <Select
              v-model:value="recordForm.methodCode"
              :options="RECEIPT_METHOD_OPTIONS"
              style="width: 100%"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">流水号</div>
            <Input
              v-model:value="recordForm.referenceNo"
              placeholder="银行流水号等"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">凭证引用</div>
            <Input
              v-model:value="recordForm.voucherRef"
              placeholder="回单/凭证编号"
            />
          </div>
        </div>
        <Alert
          v-if="recordError"
          :message="recordError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ recordError.description }}</p>
            <p v-if="recordError.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{
                recordError.requestId
              }}</span>
            </p>
          </template>
        </Alert>
      </div>
    </Modal>
  </div>
</template>
