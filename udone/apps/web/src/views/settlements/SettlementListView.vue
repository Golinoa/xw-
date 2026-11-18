<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type Permission,
  type SettlementBatch,
  type SettlementBatchDetail,
  type SettlementStatus,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { lookup } from '../../lib/display';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { useSupplierOptions, filterSupplierOption } from '../suppliers/supplier-options';
import { PAYMENT_METHOD_LABELS } from '../finance/finance-application-display';
import SettlementCreateModal from './SettlementCreateModal.vue';
import {
  SETTLEMENT_STATUS_COLORS,
  SETTLEMENT_STATUS_LABELS,
  cancelNeedsReason,
  formatPeriodMonth,
} from './settlement-display';

/**
 * 批量结算（R-SETTLE-01）。
 *
 * 页面只做三件事：列出批次、建草稿、确认/作废。金额一律用服务端返回值，
 * 页面不重算「还能结多少」——那个数字依赖累计已确认结算，自己算就会重复结算。
 */
const auth = useAuthStore();
const suppliers = useSupplierOptions();

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.FINANCE_WRITE));

const supplierFilter = ref<string | undefined>();
const statusFilter = ref<SettlementStatus | undefined>();
const page = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);

const items = ref<SettlementBatch[]>([]);
const total = ref(0);
const listStatus = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const listError = ref('');
let requestSeq = 0;

const createOpen = ref(false);
const detailOpen = ref(false);
const detail = ref<SettlementBatchDetail | null>(null);
const detailLoading = ref(false);
const actingId = ref<string>('');

const cancelTarget = ref<SettlementBatchDetail | SettlementBatch | null>(null);
const cancelReason = ref('');
const cancelling = ref(false);

const statusOptions = (['draft', 'confirmed', 'cancelled'] as const).map((status) => ({
  value: status,
  label: SETTLEMENT_STATUS_LABELS[status],
}));

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    listStatus.value = 'forbidden';
    listError.value = '当前账号没有财务办理权限，无法查看结算批次。';
    return;
  }
  const seq = ++requestSeq;
  listStatus.value = 'loading';
  listError.value = '';
  try {
    const result = await auth.api.call('listSettlements', {
      body: {
        page: page.value,
        pageSize: pageSize.value,
        sort: 'createdAt',
        order: 'desc',
        ...(supplierFilter.value ? { supplierId: supplierFilter.value } : {}),
        ...(statusFilter.value ? { status: statusFilter.value } : {}),
      },
    });
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
    listStatus.value = 'ready';
  } catch (cause) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    if (
      cause instanceof ApiClientError &&
      (cause.code === 'FORBIDDEN' || cause.code === 'TENANT_SCOPE_DENIED')
    ) {
      listStatus.value = 'forbidden';
      listError.value = cause.message;
      return;
    }
    // 失败不等于空列表：必须让用户看到「没加载成功」，否则会以为这个月没结算过。
    listStatus.value = 'error';
    listError.value = cause instanceof ApiClientError ? cause.message : '结算列表加载失败';
  }
}

watch(
  () => auth.currentOrganization.value?.organizationId,
  () => {
    page.value = 1;
    void load();
    void suppliers.load();
  },
);

onMounted(() => {
  void load();
  void suppliers.load();
});

function onPageChange(nextPage: number, nextPageSize: number) {
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void load();
}

function applyFilters() {
  page.value = 1;
  void load();
}

function resetFilters() {
  supplierFilter.value = undefined;
  statusFilter.value = undefined;
  page.value = 1;
  void load();
}

async function openDetail(row: SettlementBatch) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const result = await auth.api.call('getSettlement', { params: { batchId: row.id } });
    detail.value = result.settlement;
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '批次明细加载失败');
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

async function confirmBatch(row: SettlementBatch | SettlementBatchDetail) {
  actingId.value = row.id;
  try {
    const result = await auth.api.call('confirmSettlement', { params: { batchId: row.id } });
    message.success(`已确认，锁定金额 ${formatMoney(result.totalAmount)}`);
    if (detail.value?.id === row.id) await openDetail(row);
    await load();
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '确认批次失败');
  } finally {
    actingId.value = '';
  }
}

function askCancel(row: SettlementBatch | SettlementBatchDetail) {
  cancelTarget.value = row;
  cancelReason.value = '';
}

async function submitCancel() {
  const target = cancelTarget.value;
  if (!target) return;
  if (cancelNeedsReason(target.status) && cancelReason.value.trim() === '') {
    message.warning('作废已确认的批次必须填写原因');
    return;
  }
  cancelling.value = true;
  try {
    await auth.api.call('cancelSettlement', {
      params: { batchId: target.id },
      body: { ...(cancelReason.value.trim() ? { reason: cancelReason.value.trim() } : {}) },
    });
    message.success('已作废，锁定的额度已释放');
    cancelTarget.value = null;
    if (detail.value?.id === target.id) await openDetail(target);
    await load();
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '作废批次失败');
  } finally {
    cancelling.value = false;
  }
}

function onCreated(created: SettlementBatchDetail) {
  // 新建后直接打开详情做「二次确认」：草稿不锁额度，确认才锁。
  detail.value = created;
  detailOpen.value = true;
  page.value = 1;
  void load();
}

const columns = [
  { title: '供应商', dataIndex: 'supplierName', key: 'supplierName' },
  { title: '结算月份', dataIndex: 'periodMonth', key: 'periodMonth', width: 130 },
  { title: '方式', dataIndex: 'method', key: 'method', width: 110 },
  { title: '金额', dataIndex: 'totalAmount', key: 'totalAmount', width: 130 },
  { title: '笔数', dataIndex: 'itemCount', key: 'itemCount', width: 80 },
  { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
  { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: '操作', key: 'actions', width: 200 },
];

const detailColumns = [
  { title: '订单号', dataIndex: 'orderNumber', key: 'orderNumber', width: 160 },
  { title: '应付项目', dataIndex: 'payableName', key: 'payableName' },
  { title: '金额', dataIndex: 'amount', key: 'amount', width: 130 },
  { title: '锁定', dataIndex: 'confirmed', key: 'confirmed', width: 90 },
];

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 个批次`;
</script>

<template>
  <section class="settlements-page" aria-labelledby="settlements-title">
    <header class="page-header">
      <div>
        <a-typography-title id="settlements-title" :level="3" class="page-title"
          >批量结算</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          按供应商和自然月合并应付明细；草稿不锁额度，确认后才锁定。实际付款仍走付款申请与审批。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="listStatus === 'loading'" @click="load">刷新</a-button>
        <a-button v-if="canRead" type="primary" @click="createOpen = true">新建结算批次</a-button>
      </a-space>
    </header>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-select
          v-model:value="supplierFilter"
          class="supplier-filter"
          placeholder="全部供应商"
          allow-clear
          show-search
          :filter-option="filterSupplierOption"
          :options="suppliers.options.value"
          :loading="suppliers.loading.value"
        />
        <a-select
          v-model:value="statusFilter"
          class="status-filter"
          placeholder="全部状态"
          allow-clear
          :options="statusOptions"
        />
        <a-button type="primary" @click="applyFilters">筛选</a-button>
        <a-button @click="resetFilters">重置</a-button>
        <span v-if="listStatus === 'ready'" class="result-count" role="status"
          >共 {{ total }} 个批次</span
        >
      </div>
    </a-card>

    <a-alert
      v-if="listStatus === 'error'"
      type="error"
      show-icon
      :message="listError"
      description="列表请求没有成功，当前页面没有任何结算批次；这不代表系统中没有结算记录。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="listStatus === 'forbidden'"
      status="403"
      title="无权限查看结算批次"
      :sub-title="listError"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="listStatus === 'loading' && items.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载结算批次…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="items"
          :loading="listStatus === 'loading' && items.length > 0"
          :pagination="false"
          :locale="{ emptyText: '还没有结算批次，点击右上角「新建结算批次」开始' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'periodMonth'">
              {{ formatPeriodMonth(record.periodMonth) }}
            </template>
            <template v-else-if="column.key === 'method'">
              {{ lookup(PAYMENT_METHOD_LABELS, record.method) }}
            </template>
            <template v-else-if="column.key === 'totalAmount'">
              {{ formatMoney(record.totalAmount) }}
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :bordered="false" :color="lookup(SETTLEMENT_STATUS_COLORS, record.status)">
                {{ lookup(SETTLEMENT_STATUS_LABELS, record.status) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space>
                <a-button size="small" @click="openDetail(record)">明细</a-button>
                <a-popconfirm
                  v-if="record.status === 'draft'"
                  title="确认后额度将锁定，确定吗？"
                  ok-text="确认"
                  cancel-text="再想想"
                  @confirm="confirmBatch(record)"
                >
                  <a-button size="small" type="primary" :loading="actingId === record.id"
                    >确认</a-button
                  >
                </a-popconfirm>
                <a-button
                  v-if="record.status !== 'cancelled'"
                  size="small"
                  danger
                  @click="askCancel(record)"
                  >作废</a-button
                >
              </a-space>
            </template>
          </template>
        </a-table>
        <a-pagination
          v-if="total > 0"
          class="pagination"
          :current="page"
          :page-size="pageSize"
          :total="total"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          show-size-changer
          @change="onPageChange"
        />
      </template>
    </a-card>

    <SettlementCreateModal v-model:open="createOpen" @created="onCreated" />

    <a-drawer v-model:open="detailOpen" title="结算批次明细" width="720px" :destroy-on-close="true">
      <a-spin v-if="detailLoading" />
      <template v-else-if="detail">
        <a-descriptions :column="2" size="small" bordered>
          <a-descriptions-item label="供应商">{{ detail.supplierName }}</a-descriptions-item>
          <a-descriptions-item label="结算月份">{{
            formatPeriodMonth(detail.periodMonth)
          }}</a-descriptions-item>
          <a-descriptions-item label="方式">{{
            lookup(PAYMENT_METHOD_LABELS, detail.method)
          }}</a-descriptions-item>
          <a-descriptions-item label="状态">
            <a-tag :bordered="false" :color="SETTLEMENT_STATUS_COLORS[detail.status]">
              {{ lookup(SETTLEMENT_STATUS_LABELS, detail.status) }}
            </a-tag>
          </a-descriptions-item>
          <a-descriptions-item label="金额">{{
            formatMoney(detail.totalAmount)
          }}</a-descriptions-item>
          <a-descriptions-item label="确认时间">{{
            detail.confirmedAt ? formatDateTime(detail.confirmedAt) : '—'
          }}</a-descriptions-item>
          <a-descriptions-item label="备注" :span="2">{{ detail.note ?? '—' }}</a-descriptions-item>
          <a-descriptions-item v-if="detail.cancelReason" label="作废原因" :span="2">
            {{ detail.cancelReason }}
          </a-descriptions-item>
        </a-descriptions>

        <a-table
          class="detail-table"
          row-key="id"
          size="small"
          :columns="detailColumns"
          :data-source="detail.items"
          :pagination="false"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'amount'">{{ formatMoney(record.amount) }}</template>
            <template v-else-if="column.key === 'confirmed'">
              <a-tag :bordered="false" :color="record.confirmed ? 'green' : 'default'">
                {{ record.confirmed ? '已锁定' : '未锁定' }}
              </a-tag>
            </template>
          </template>
        </a-table>

        <div class="drawer-actions">
          <a-popconfirm
            v-if="detail.status === 'draft'"
            title="确认后额度将锁定，确定吗？"
            ok-text="确认"
            cancel-text="再想想"
            @confirm="confirmBatch(detail)"
          >
            <a-button type="primary" :loading="actingId === detail.id">确认批次</a-button>
          </a-popconfirm>
          <a-button v-if="detail.status !== 'cancelled'" danger @click="askCancel(detail)"
            >作废批次</a-button
          >
        </div>
      </template>
    </a-drawer>

    <a-modal
      :open="cancelTarget !== null"
      title="作废结算批次"
      :confirm-loading="cancelling"
      ok-text="作废"
      cancel-text="取消"
      @ok="submitCancel"
      @cancel="cancelTarget = null"
    >
      <a-alert
        v-if="cancelTarget && cancelNeedsReason(cancelTarget.status)"
        class="cancel-note"
        type="warning"
        show-icon
        message="这批已经确认，作废会释放已锁定的额度。"
      />
      <a-form layout="vertical">
        <a-form-item
          label="作废原因"
          :required="cancelTarget ? cancelNeedsReason(cancelTarget.status) : false"
        >
          <a-input
            v-model:value="cancelReason"
            :maxlength="500"
            placeholder="写给日后看这条记录的人"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </section>
</template>

<style scoped>
.settlements-page {
  display: grid;
  gap: var(--space-16);
  margin: var(--space-32);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-16);
}

.page-title {
  margin-bottom: var(--space-4);
}

.page-subtitle {
  margin-bottom: 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.filter-card :deep(.ant-card-body) {
  padding: var(--space-16);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
}

.supplier-filter {
  width: 240px;
}

.status-filter {
  width: 160px;
}

.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.table-card :deep(.ant-card-body) {
  padding: var(--space-8) var(--space-16) var(--space-16);
}

.list-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-12);
  padding: var(--space-48) 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}

.detail-table {
  margin-top: var(--space-16);
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-12);
  margin-top: var(--space-24);
}

.cancel-note {
  margin-bottom: var(--space-16);
}
</style>
