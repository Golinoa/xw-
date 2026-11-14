<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { BillingErrorView } from '#/api/ops/billing/errors';
import type {
  Receivable,
  ReceivableDetail,
  ReceivableListQuery,
  ReceivableStatus,
  ReceivableSummary,
} from '#/api/ops/billing/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  AMOUNT_ERROR_MESSAGE,
  canExtendReceivable,
  createReceivablePlan,
  describeBillingError,
  extendReceivable,
  fetchReceivable,
  fetchReceivables,
  formatDate,
  formatDateTime,
  formatMoney,
  parseAmountInput,
  RECEIVABLE_STATUS_OPTIONS,
  receivableStatusView,
  validateReason,
} from '#/api/ops/billing';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import DevDataNotice from './components/dev-data-notice.vue';

defineOptions({ name: 'BillingReceivables' });

const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.RECEIVABLE_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.RECEIVABLE_WRITE));

// ------------------------------------------------------------------ 列表

const rows = ref<Receivable[]>([]);
const summary = shallowRef<null | ReceivableSummary>(null);
const loading = ref(false);
const loadError = shallowRef<BillingErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  contractId: '',
  customerId: '',
  overdueOnly: false,
  status: [] as ReceivableStatus[],
});
const dueFrom = ref<Dayjs>();
const dueTo = ref<Dayjs>();

const columns: TableColumnsType = [
  { dataIndex: 'contractNo', key: 'contractNo', title: '合同号', width: 160 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 220 },
  { dataIndex: 'periodNo', key: 'periodNo', title: '期次', width: 70 },
  { dataIndex: 'dueDate', key: 'dueDate', title: '到期日', width: 120 },
  { dataIndex: 'amount', key: 'amount', title: '应收金额', width: 140 },
  {
    dataIndex: 'allocatedAmount',
    key: 'allocatedAmount',
    title: '已核销',
    width: 140,
  },
  {
    dataIndex: 'outstanding',
    key: 'outstanding',
    title: '未收余额',
    width: 140,
  },
  { dataIndex: 'status', key: 'status', title: '状态', width: 110 },
  { key: 'actions', title: '操作', width: 150 },
];

function buildQuery(): ReceivableListQuery {
  return {
    contractId: filters.contractId.trim() || undefined,
    customerId: filters.customerId.trim() || undefined,
    dueFrom: dueFrom.value?.format('YYYY-MM-DD'),
    dueTo: dueTo.value?.format('YYYY-MM-DD'),
    order: 'asc',
    overdueOnly: filters.overdueOnly || undefined,
    page: pagination.page,
    pageSize: pagination.pageSize,
    sort: 'dueDate',
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
    const result = await fetchReceivables(buildQuery());
    rows.value = result.items;
    summary.value = result.summary ?? null;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    summary.value = null;
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
  filters.contractId = '';
  filters.customerId = '';
  filters.status = [];
  filters.overdueOnly = false;
  dueFrom.value = undefined;
  dueTo.value = undefined;
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
const detail = shallowRef<null | ReceivableDetail>(null);
const detailLoading = ref(false);
const detailError = shallowRef<BillingErrorView | null>(null);

async function openDetailById(receivableId: string) {
  detailOpen.value = true;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = true;
  try {
    detail.value = await fetchReceivable(receivableId);
  } catch (error: unknown) {
    detailError.value = describeBillingError(error);
  } finally {
    detailLoading.value = false;
  }
}

// ------------------------------------------------------------------ 展期

const extendOpen = ref(false);
const extendTarget = ref<null | Receivable>(null);
const extendDueDate = ref<Dayjs>();
const extendReason = ref('');
const extendReasonError = ref<null | string>(null);
const extendSubmitting = ref(false);
const extendError = shallowRef<BillingErrorView | null>(null);

function extendDecision(row: Receivable) {
  return canExtendReceivable({
    hasPermission: canWrite.value,
    outstanding: row.outstanding,
    status: row.status,
  });
}

async function openExtend(row: Receivable) {
  const decision = extendDecision(row);
  if (!decision.allowed) {
    message.warning(decision.message ?? '当前不可展期');
    return;
  }
  let target = row;
  // 列表可能不带 version：展期提交必须回传最新版本，否则服务端会判乐观锁冲突
  if (target.version === undefined) {
    try {
      const fresh = await fetchReceivable(row.id);
      target = fresh.receivable;
    } catch (error: unknown) {
      message.error(describeBillingError(error).description);
      return;
    }
  }
  extendTarget.value = target;
  extendDueDate.value = undefined;
  extendReason.value = '';
  extendReasonError.value = null;
  extendError.value = null;
  extendOpen.value = true;
}

async function submitExtend() {
  if (extendSubmitting.value) {
    return;
  }
  const target = extendTarget.value;
  if (!target || target.version === undefined) {
    return;
  }
  const validated = validateReason(extendReason.value);
  if (!validated.ok) {
    extendReasonError.value = validated.message ?? '请填写展期原因';
    return;
  }
  if (!extendDueDate.value) {
    extendReasonError.value = '请选择新的到期日';
    return;
  }
  const newDueDate = extendDueDate.value.format('YYYY-MM-DD');
  // ISO 日期字符串按字典序比较等价于按时间比较（YYYY-MM-DD 定长）
  if (!(newDueDate > target.dueDate)) {
    extendReasonError.value = '新到期日必须晚于当前到期日';
    return;
  }
  extendReasonError.value = null;
  extendSubmitting.value = true;
  extendError.value = null;
  try {
    await extendReceivable(target.id, {
      newDueDate,
      reason: validated.value,
      version: target.version,
    });
    message.success('展期已记录，原到期日已保留在展期历史中');
    extendOpen.value = false;
    await load();
    if (detailOpen.value && detail.value?.receivable.id === target.id) {
      void openDetailById(target.id);
    }
  } catch (error: unknown) {
    const view = describeBillingError(error);
    extendError.value = view;
    // 冲突时余额/版本已变化：重新拉取，避免用户拿旧数据重试
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    extendSubmitting.value = false;
  }
}

// ------------------------------------------------------------------ 生成计划

interface PeriodDraft {
  amount: string;
  dueDate?: Dayjs;
  note: string;
}

const createOpen = ref(false);
const createContractId = ref('');
const createPeriods = ref<PeriodDraft[]>([{ amount: '', note: '' }]);
const createSubmitting = ref(false);
const createError = shallowRef<BillingErrorView | null>(null);
const createFieldErrors = ref<Record<string, string>>({});

function openCreate() {
  createContractId.value = '';
  createPeriods.value = [{ amount: '', note: '' }];
  createFieldErrors.value = {};
  createError.value = null;
  createOpen.value = true;
}

function addPeriod() {
  createPeriods.value.push({ amount: '', note: '' });
}

function removePeriod(index: number) {
  if (createPeriods.value.length <= 1) {
    return;
  }
  createPeriods.value.splice(index, 1);
}

async function submitCreate() {
  if (createSubmitting.value) {
    return;
  }
  const fieldErrors: Record<string, string> = {};
  if (createContractId.value.trim() === '') {
    fieldErrors.contractId = '请填写合同 ID';
  }
  const periods: { amount: number; dueDate: string; note?: string }[] = [];
  createPeriods.value.forEach((period, index) => {
    if (!period.dueDate) {
      fieldErrors[`dueDate-${index}`] = '请选择计划收款日';
    }
    const parsed = parseAmountInput(period.amount);
    if (!parsed.ok) {
      fieldErrors[`amount-${index}`] = AMOUNT_ERROR_MESSAGE[parsed.error];
    }
    if (period.dueDate && parsed.ok) {
      const note = period.note.trim();
      periods.push({
        amount: parsed.value,
        dueDate: period.dueDate.format('YYYY-MM-DD'),
        ...(note === '' ? {} : { note }),
      });
    }
  });
  createFieldErrors.value = fieldErrors;
  if (Object.keys(fieldErrors).length > 0) {
    return;
  }
  createSubmitting.value = true;
  createError.value = null;
  try {
    await createReceivablePlan({
      contractId: createContractId.value.trim(),
      periods,
    });
    message.success('应收计划已生成');
    createOpen.value = false;
    await load();
  } catch (error: unknown) {
    createError.value = describeBillingError(error);
  } finally {
    createSubmitting.value = false;
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
              style="width: 220px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">合同 ID</div>
            <Input
              v-model:value="filters.contractId"
              allow-clear
              placeholder="按合同 ID 精确筛选"
              style="width: 220px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="RECEIVABLE_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 220px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">到期区间</div>
            <Space>
              <DatePicker v-model:value="dueFrom" placeholder="起" />
              <DatePicker v-model:value="dueTo" placeholder="止" />
            </Space>
          </div>
          <div class="flex items-center gap-2">
            <Button type="primary" @click="onSearch">查询</Button>
            <Button @click="onReset">重置</Button>
          </div>
          <div class="ml-auto flex items-center gap-2">
            <Tooltip
              v-if="!canWrite"
              title="缺少 receivable.write，不能生成应收计划"
            >
              <span>
                <Button disabled>生成应收计划</Button>
              </span>
            </Tooltip>
            <Button v-else type="primary" ghost @click="openCreate">
              生成应收计划
            </Button>
          </div>
        </div>
      </Card>

      <div class="mb-3 grid gap-3 md:grid-cols-4">
        <Card size="small">
          <div class="text-xs text-muted-foreground">
            应收合计（服务端汇总）
          </div>
          <div class="mt-1 text-lg font-medium">
            {{ formatMoney(summary?.totalAmount, 'CNY') }}
          </div>
        </Card>
        <Card size="small">
          <div class="text-xs text-muted-foreground">已核销合计</div>
          <div class="mt-1 text-lg font-medium">
            {{ formatMoney(summary?.settledAmount, 'CNY') }}
          </div>
        </Card>
        <Card size="small">
          <div class="text-xs text-muted-foreground">未收合计</div>
          <div class="mt-1 text-lg font-medium">
            {{ formatMoney(summary?.outstandingAmount, 'CNY') }}
          </div>
        </Card>
        <Card size="small">
          <div class="text-xs text-muted-foreground">逾期未收</div>
          <div class="mt-1 text-lg font-medium text-red-500">
            {{ formatMoney(summary?.overdueAmount, 'CNY') }}
          </div>
        </Card>
      </div>

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
          :row-key="(row: Receivable) => row.id"
          :scroll="{ x: 1200 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'dueDate'">
              {{ formatDate(record.dueDate) }}
            </template>
            <template v-else-if="column.key === 'amount'">
              {{ formatMoney(record.amount, record.currency) }}
            </template>
            <template v-else-if="column.key === 'allocatedAmount'">
              {{ formatMoney(record.allocatedAmount, record.currency) }}
            </template>
            <template v-else-if="column.key === 'outstanding'">
              {{ formatMoney(record.outstanding, record.currency) }}
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="receivableStatusView(record.status).color">
                {{ receivableStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Space>
                <Button
                  size="small"
                  type="link"
                  @click="openDetailById(record.id)"
                >
                  详情
                </Button>
                <Tooltip
                  :title="extendDecision(record as Receivable).message ?? ''"
                >
                  <span>
                    <Button
                      :disabled="!extendDecision(record as Receivable).allowed"
                      size="small"
                      type="link"
                      @click="openExtend(record as Receivable)"
                    >
                      展期
                    </Button>
                  </span>
                </Tooltip>
              </Space>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有应收记录" />
          </template>
        </Table>
      </Card>
    </template>

    <!-- 详情 -->
    <Drawer v-model:open="detailOpen" :width="760" title="应收详情">
      <Spin :spinning="detailLoading">
        <Alert
          v-if="detailError"
          :message="detailError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ detailError.description }}</p>
              <p v-if="detailError.requestId" class="text-xs">
                请求 ID：<span class="font-mono">{{
                  detailError.requestId
                }}</span>
              </p>
            </div>
          </template>
        </Alert>

        <template v-if="detail">
          <Descriptions bordered :column="2" size="small" title="应收">
            <Descriptions.Item label="合同号">
              {{ detail.receivable.contractNo }}
            </Descriptions.Item>
            <Descriptions.Item label="客户">
              {{ detail.receivable.customer.name }}
            </Descriptions.Item>
            <Descriptions.Item label="期次">
              第 {{ detail.receivable.periodNo }} 期
            </Descriptions.Item>
            <Descriptions.Item label="到期日">
              {{ formatDate(detail.receivable.dueDate) }}
            </Descriptions.Item>
            <Descriptions.Item label="应收金额">
              {{
                formatMoney(
                  detail.receivable.amount,
                  detail.receivable.currency,
                )
              }}
            </Descriptions.Item>
            <Descriptions.Item label="已核销">
              {{
                formatMoney(
                  detail.receivable.allocatedAmount,
                  detail.receivable.currency,
                )
              }}
            </Descriptions.Item>
            <Descriptions.Item label="未收余额">
              {{
                formatMoney(
                  detail.receivable.outstanding,
                  detail.receivable.currency,
                )
              }}
            </Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag
                :color="receivableStatusView(detail.receivable.status).color"
              >
                {{ receivableStatusView(detail.receivable.status).label }}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="备注" :span="2">
              {{ detail.receivable.note ?? '—' }}
            </Descriptions.Item>
          </Descriptions>

          <div class="mt-6">
            <h4 class="mb-2 font-medium">核销流水</h4>
            <Table
              :columns="[
                { dataIndex: 'receiptNo', key: 'receiptNo', title: '收款编号' },
                { dataIndex: 'amount', key: 'amount', title: '核销金额' },
                {
                  dataIndex: 'reversedAmount',
                  key: 'reversedAmount',
                  title: '已撤销',
                },
                {
                  dataIndex: 'allocatedBy',
                  key: 'allocatedBy',
                  title: '操作者',
                },
                { dataIndex: 'allocatedAt', key: 'allocatedAt', title: '时间' },
              ]"
              :data-source="detail.allocations"
              :pagination="false"
              :row-key="(row: { id: string }) => row.id"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'amount'">
                  {{ formatMoney(record.amount, detail.receivable.currency) }}
                </template>
                <template v-else-if="column.key === 'reversedAmount'">
                  {{
                    formatMoney(
                      record.reversedAmount ?? 0,
                      detail.receivable.currency,
                    )
                  }}
                </template>
                <template v-else-if="column.key === 'allocatedBy'">
                  {{
                    record.allocatedBy?.displayName ??
                    record.allocatedBy?.id ??
                    '—'
                  }}
                </template>
                <template v-else-if="column.key === 'allocatedAt'">
                  {{ formatDateTime(record.allocatedAt) }}
                </template>
                <template v-else-if="column.key === 'receiptNo'">
                  {{ record.receiptNo ?? record.receiptId }}
                </template>
              </template>
              <template #emptyText>
                <Empty description="暂无核销记录" />
              </template>
            </Table>
          </div>

          <div class="mt-6">
            <h4 class="mb-2 font-medium">展期历史（仅追加，保留原到期日）</h4>
            <Table
              :columns="[
                {
                  dataIndex: 'previousDueDate',
                  key: 'previousDueDate',
                  title: '原到期日',
                },
                {
                  dataIndex: 'newDueDate',
                  key: 'newDueDate',
                  title: '新到期日',
                },
                { dataIndex: 'reason', key: 'reason', title: '原因' },
                { dataIndex: 'createdAt', key: 'createdAt', title: '记录时间' },
              ]"
              :data-source="detail.extensions"
              :pagination="false"
              :row-key="(row: { id: string }) => row.id"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'previousDueDate'">
                  {{ formatDate(record.previousDueDate) }}
                </template>
                <template v-else-if="column.key === 'newDueDate'">
                  {{ formatDate(record.newDueDate) }}
                </template>
                <template v-else-if="column.key === 'createdAt'">
                  {{ formatDateTime(record.createdAt) }}
                </template>
              </template>
              <template #emptyText>
                <Empty description="暂无展期记录" />
              </template>
            </Table>
          </div>
        </template>
      </Spin>
    </Drawer>

    <!-- 展期 -->
    <Modal
      v-model:open="extendOpen"
      :confirm-loading="extendSubmitting"
      :mask-closable="false"
      ok-text="确认展期"
      title="应收展期"
      @ok="submitExtend"
    >
      <Alert
        class="mb-3"
        message="展期只允许未结清应收；系统会追加一条展期记录并保留原到期日，需填写原因（不额外走审批）。"
        show-icon
        type="info"
      />
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            当前到期日 / 未收余额
          </div>
          <div>
            {{ formatDate(extendTarget?.dueDate) }} /
            {{ formatMoney(extendTarget?.outstanding, extendTarget?.currency) }}
          </div>
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">新到期日</div>
          <DatePicker v-model:value="extendDueDate" style="width: 100%" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">展期原因（必填）</div>
          <Input.TextArea
            v-model:value="extendReason"
            :rows="3"
            :status="extendReasonError ? 'error' : undefined"
            placeholder="例如：客户申请顺延，已与客户书面确认"
          />
          <p v-if="extendReasonError" class="mt-1 text-xs text-red-500">
            {{ extendReasonError }}
          </p>
        </div>
        <Alert
          v-if="extendError"
          :message="extendError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ extendError.description }}</p>
            <p v-if="extendError.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{
                extendError.requestId
              }}</span>
            </p>
          </template>
        </Alert>
      </div>
    </Modal>

    <!-- 生成计划 -->
    <Modal
      v-model:open="createOpen"
      :confirm-loading="createSubmitting"
      :mask-closable="false"
      :width="720"
      ok-text="提交生成"
      title="生成应收计划"
      @ok="submitCreate"
    >
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">合同 ID</div>
          <Input
            v-model:value="createContractId"
            :status="createFieldErrors.contractId ? 'error' : undefined"
            placeholder="填写已生效合同的 ID（合同选择器待合同域联调）"
          />
          <p
            v-if="createFieldErrors.contractId"
            class="mt-1 text-xs text-red-500"
          >
            {{ createFieldErrors.contractId }}
          </p>
        </div>

        <div
          v-for="(period, index) in createPeriods"
          :key="index"
          class="rounded border border-solid border-gray-200 p-3"
        >
          <div class="mb-2 flex items-center justify-between">
            <span class="text-sm font-medium">第 {{ index + 1 }} 期</span>
            <Button
              v-if="createPeriods.length > 1"
              danger
              size="small"
              type="link"
              @click="removePeriod(index)"
            >
              删除
            </Button>
          </div>
          <div class="grid gap-2 md:grid-cols-3">
            <div>
              <div class="mb-1 text-xs text-muted-foreground">计划收款日</div>
              <DatePicker
                v-model:value="period.dueDate"
                :status="
                  createFieldErrors[`dueDate-${index}`] ? 'error' : undefined
                "
                style="width: 100%"
              />
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">金额</div>
              <Input
                v-model:value="period.amount"
                :status="
                  createFieldErrors[`amount-${index}`] ? 'error' : undefined
                "
                placeholder="如 120000.00"
              />
            </div>
            <div>
              <div class="mb-1 text-xs text-muted-foreground">备注</div>
              <Input v-model:value="period.note" placeholder="可空" />
            </div>
          </div>
          <p
            v-if="createFieldErrors[`dueDate-${index}`]"
            class="mt-1 text-xs text-red-500"
          >
            {{ createFieldErrors[`dueDate-${index}`] }}
          </p>
          <p
            v-if="createFieldErrors[`amount-${index}`]"
            class="mt-1 text-xs text-red-500"
          >
            {{ createFieldErrors[`amount-${index}`] }}
          </p>
        </div>

        <Button block type="dashed" @click="addPeriod">+ 增加一期</Button>

        <Alert
          message="合计金额由服务端按合同金额复算，前端不提交合计（合计与合同不符时服务端返回 PLAN_TOTAL_MISMATCH）。"
          show-icon
          type="info"
        />

        <Alert
          v-if="createError"
          :message="createError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ createError.description }}</p>
            <p v-if="createError.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{
                createError.requestId
              }}</span>
            </p>
          </template>
        </Alert>
      </div>
    </Modal>
  </div>
</template>
