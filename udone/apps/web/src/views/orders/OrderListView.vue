<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import {
  DEFAULT_PAGE_SIZE,
  ORDER_SORT_FIELDS,
  ORDER_STATUSES,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type OrderDetail,
  type OrderListItem,
  type OrderStatus,
  type OrderType,
  type Permission,
  type SortOrder,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import OrderDetailDrawer from './OrderDetailDrawer.vue';
import OrderFormModal from './OrderFormModal.vue';
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_OPTIONS,
  ORDER_STATUS_TAG_COLORS,
  ORDER_TYPE_LABELS,
  ORDER_TYPE_OPTIONS,
} from './order-display';
import { useCustomerOptions } from './customer-options';

type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];

interface ListState {
  page: number;
  pageSize: number;
  sort: OrderSortField;
  order: SortOrder;
  keyword: string;
  status: OrderStatus | undefined;
  orderType: OrderType | undefined;
  customerId: string | undefined;
  departureFrom: string | undefined;
  departureTo: string | undefined;
}

interface TableSorter {
  columnKey?: string | number;
  order?: 'ascend' | 'descend' | null;
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ORDER_READ));
/** 隐藏入口只影响体验：服务端仍按 order.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.ORDER_WRITE));
/** 发起收付款申请是另一道权限：能改订单不等于能报款。 */
const canApply = computed(() => permissions.value.includes(PERMISSIONS.FINANCE_WRITE));

const {
  options: customerOptions,
  loading: customersLoading,
  error: customersError,
  load: loadCustomers,
  search: searchCustomers,
  ensure: ensureCustomer,
  select: selectCustomer,
} = useCustomerOptions();

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function isSortField(value: string): value is OrderSortField {
  return ORDER_SORT_FIELDS.some((field) => field === value);
}

function isStatus(value: string): value is OrderStatus {
  return ORDER_STATUSES.some((status) => status === value);
}

function isOrderType(value: string): value is OrderType {
  return value === 'booking' || value === 'active';
}

function toPage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function toPageSize(value: string | undefined): number {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(value: string | undefined): string | undefined {
  return value && ISO_DATE.test(value) ? value : undefined;
}

/** URL 是列表状态的唯一来源：刷新、前进后退、直接分享链接都还原到同一页。 */
function readState(): ListState {
  const sortValue = firstQueryValue(route.query.sort);
  const orderValue = firstQueryValue(route.query.order);
  const statusValue = firstQueryValue(route.query.status);
  const typeValue = firstQueryValue(route.query.orderType);
  const customerId = firstQueryValue(route.query.customerId);
  return {
    page: toPage(firstQueryValue(route.query.page)),
    pageSize: toPageSize(firstQueryValue(route.query.pageSize)),
    sort: sortValue && isSortField(sortValue) ? sortValue : 'createdAt',
    order: orderValue === 'asc' ? 'asc' : 'desc',
    keyword: (firstQueryValue(route.query.keyword) ?? '').slice(0, 100),
    status: statusValue && isStatus(statusValue) ? statusValue : undefined,
    orderType: typeValue && isOrderType(typeValue) ? typeValue : undefined,
    customerId: customerId ? customerId : undefined,
    departureFrom: toIsoDate(firstQueryValue(route.query.departureFrom)),
    departureTo: toIsoDate(firstQueryValue(route.query.departureTo)),
  };
}

function stateQuery(current: ListState): Record<string, string> {
  const query: Record<string, string> = {
    page: String(current.page),
    pageSize: String(current.pageSize),
    sort: current.sort,
    order: current.order,
  };
  if (current.keyword) query.keyword = current.keyword;
  if (current.status) query.status = current.status;
  if (current.orderType) query.orderType = current.orderType;
  if (current.customerId) query.customerId = current.customerId;
  if (current.departureFrom && current.departureTo) {
    query.departureFrom = current.departureFrom;
    query.departureTo = current.departureTo;
  }
  return query;
}

function isSameState(current: ListState, next: ListState): boolean {
  return (
    current.page === next.page &&
    current.pageSize === next.pageSize &&
    current.sort === next.sort &&
    current.order === next.order &&
    current.keyword === next.keyword &&
    current.status === next.status &&
    current.orderType === next.orderType &&
    current.customerId === next.customerId &&
    current.departureFrom === next.departureFrom &&
    current.departureTo === next.departureTo
  );
}

const state = reactive<ListState>(readState());
const keywordInput = ref(state.keyword);
const statusFilter = ref<OrderStatus | undefined>(state.status);
const typeFilter = ref<OrderType | undefined>(state.orderType);

watch(
  () => state.keyword,
  (keyword) => {
    keywordInput.value = keyword;
  },
);
watch(
  () => state.status,
  (status) => {
    statusFilter.value = status;
  },
);
watch(
  () => state.orderType,
  (orderType) => {
    typeFilter.value = orderType;
  },
);
/** 地址栏里只有客户 id，进入页面或刷新时补出客户名，避免下拉里显示裸 id。 */
watch(
  () => state.customerId,
  (customerId) => {
    if (customerId) void ensureCustomer(customerId);
    else selectCustomer(undefined);
  },
  { immediate: true },
);

const items = ref<OrderListItem[]>([]);
const total = ref(0);
const listStatus = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const listError = ref('');
let requestSeq = 0;

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    listStatus.value = 'forbidden';
    listError.value = '当前账号没有订单查看权限，请联系管理员开通。';
    return;
  }
  const seq = ++requestSeq;
  listStatus.value = 'loading';
  listError.value = '';
  try {
    const body: {
      page: number;
      pageSize: number;
      sort: OrderSortField;
      order: SortOrder;
      keyword?: string;
      status?: OrderStatus;
      orderType?: OrderType;
      customerId?: string;
      departureFrom?: string;
      departureTo?: string;
    } = {
      page: state.page,
      pageSize: state.pageSize,
      sort: state.sort,
      order: state.order,
      ...(state.keyword ? { keyword: state.keyword } : {}),
      ...(state.status ? { status: state.status } : {}),
      ...(state.orderType ? { orderType: state.orderType } : {}),
      ...(state.customerId ? { customerId: state.customerId } : {}),
      ...(state.departureFrom && state.departureTo
        ? { departureFrom: state.departureFrom, departureTo: state.departureTo }
        : {}),
    };
    const result = await auth.api.call('listOrders', { body });
    // 快速翻页时丢弃过期响应，避免旧页数据覆盖新页。
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
    // 失败与空数据是两种事实：不能让用户把「请求失败」理解成「系统里没有订单」。
    listStatus.value = 'error';
    listError.value =
      cause instanceof ApiClientError ? cause.message : '订单列表加载失败，请稍后重试';
  }
}

async function applyState(patch: Partial<ListState>) {
  Object.assign(state, patch);
  if (state.page < 1) state.page = 1;
  // replace 而非 push：翻页与筛选不应该把每一步都塞进浏览器返回栈。
  await router.replace({ query: stateQuery(state) });
  await load();
}

watch(
  () => route.query,
  () => {
    const next = readState();
    if (isSameState(state, next)) return;
    Object.assign(state, next);
    void load();
  },
);

watch(
  () => auth.currentOrganization.value?.organizationId,
  () => {
    void loadCustomers();
    void load();
  },
);

onMounted(() => {
  void loadCustomers();
  void load();
});

function submitKeyword() {
  void applyState({ keyword: keywordInput.value.trim(), page: 1 });
}

function onStatusChange(value: unknown) {
  void applyState({
    status: typeof value === 'string' && isStatus(value) ? value : undefined,
    page: 1,
  });
}

function onTypeChange(value: unknown) {
  void applyState({
    orderType: typeof value === 'string' && isOrderType(value) ? value : undefined,
    page: 1,
  });
}

function onCustomerChange(value: unknown) {
  const customerId = typeof value === 'string' && value ? value : undefined;
  selectCustomer(customerId);
  void applyState({ customerId, page: 1 });
}

const departureRange = computed<[string, string] | undefined>(() =>
  state.departureFrom && state.departureTo ? [state.departureFrom, state.departureTo] : undefined,
);

function onDepartureChange(value: unknown) {
  if (!Array.isArray(value) || value.length !== 2) {
    void applyState({ departureFrom: undefined, departureTo: undefined, page: 1 });
    return;
  }
  const [from, to] = value.map((item) => (typeof item === 'string' ? item : ''));
  void applyState({
    departureFrom: toIsoDate(from),
    departureTo: toIsoDate(to),
    page: 1,
  });
}

function resetFilters() {
  keywordInput.value = '';
  statusFilter.value = undefined;
  typeFilter.value = undefined;
  selectCustomer(undefined);
  void applyState({
    keyword: '',
    status: undefined,
    orderType: undefined,
    customerId: undefined,
    departureFrom: undefined,
    departureTo: undefined,
    page: 1,
  });
}

function onPageChange(page: number, pageSize: number) {
  // 改每页条数后页码会失效，统一回到第一页。
  void applyState({ page: pageSize === state.pageSize ? page : 1, pageSize });
}

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 个订单`;

function sortOrderFor(field: OrderSortField): 'ascend' | 'descend' | null {
  if (state.sort !== field) return null;
  return state.order === 'asc' ? 'ascend' : 'descend';
}

function onTableChange(
  _pagination: unknown,
  _filters: unknown,
  sorter: TableSorter | TableSorter[],
) {
  const active = Array.isArray(sorter) ? sorter[0] : sorter;
  const key = active?.columnKey;
  const field = typeof key === 'string' && isSortField(key) ? key : undefined;
  if (!field || !active?.order) {
    void applyState({ sort: 'createdAt', order: 'desc', page: 1 });
    return;
  }
  void applyState({ sort: field, order: active.order === 'ascend' ? 'asc' : 'desc', page: 1 });
}

const columns = computed(() => [
  {
    title: '订单号',
    dataIndex: 'orderNumber',
    key: 'orderNumber',
    width: 170,
    sorter: true,
    sortOrder: sortOrderFor('orderNumber'),
  },
  { title: '客户', dataIndex: 'customerName', key: 'customerName', width: 140 },
  { title: '线路', dataIndex: 'routeName', key: 'routeName' },
  { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
  { title: '类型', dataIndex: 'orderType', key: 'orderType', width: 110 },
  {
    title: '出团 / 回团',
    dataIndex: 'departureDate',
    key: 'departureDate',
    width: 210,
    sorter: true,
    sortOrder: sortOrderFor('departureDate'),
  },
  { title: '人数', dataIndex: 'personCount', key: 'personCount', width: 80, align: 'right' },
  {
    title: '应收合计',
    dataIndex: 'receivableTotal',
    key: 'receivableTotal',
    width: 140,
    align: 'right',
  },
  {
    title: '应付合计',
    dataIndex: 'payableTotal',
    key: 'payableTotal',
    width: 140,
    align: 'right',
  },
  { title: '利润', dataIndex: 'profit', key: 'profit', width: 140, align: 'right' },
  {
    title: '未收',
    dataIndex: 'uncollectedAmount',
    key: 'uncollectedAmount',
    width: 130,
    align: 'right',
  },
  {
    title: '未付',
    dataIndex: 'unpaidAmount',
    key: 'unpaidAmount',
    width: 130,
    align: 'right',
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 170,
    sorter: true,
    sortOrder: sortOrderFor('createdAt'),
  },
]);

function rowProps(record: OrderListItem) {
  return {
    style: { cursor: 'pointer' },
    onClick: () => openDetail(record),
  };
}

const detailOpen = ref(false);
const detailOrderId = ref<string | null>(null);
const detailSeed = ref<OrderDetail | null>(null);
const formOpen = ref(false);
const editingOrder = ref<OrderDetail | null>(null);

function openDetail(record: OrderListItem) {
  detailSeed.value = null;
  detailOrderId.value = record.id;
  detailOpen.value = true;
}

function onDetailOpenChange(open: boolean) {
  detailOpen.value = open;
  if (!open) detailSeed.value = null;
}

function openCreate() {
  editingOrder.value = null;
  formOpen.value = true;
}

function openEdit(order: OrderDetail) {
  editingOrder.value = order;
  // 抽屉与表单不同时显示同一订单，避免保存后抽屉里还是旧版本。
  detailOpen.value = false;
  detailSeed.value = null;
  formOpen.value = true;
}

async function onSaved(order: OrderDetail) {
  message.success(`已保存订单 ${order.orderNumber}`);
  // 用服务端返回的订单直接打开详情：金额是服务端重算后的值，不是前端预估。
  detailSeed.value = order;
  detailOrderId.value = order.id;
  detailOpen.value = true;
  await load();
}

async function onChanged() {
  await load();
}
</script>

<template>
  <section class="orders-page" aria-labelledby="orders-title">
    <header class="page-header">
      <div>
        <a-typography-title id="orders-title" :level="3" class="page-title"
          >订单</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          按订单号或线路检索订单；金额、利润与可申请余额均以服务端计算结果为准。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="listStatus === 'loading'" @click="load">刷新</a-button>
        <a-button v-if="canWrite" type="primary" @click="openCreate">新建订单</a-button>
      </a-space>
    </header>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索订单号或线路"
          allow-clear
          @search="submitKeyword"
        />
        <a-select
          v-model:value="statusFilter"
          class="filter-select"
          placeholder="按状态筛选"
          allow-clear
          :options="ORDER_STATUS_OPTIONS"
          @change="onStatusChange"
        />
        <a-select
          v-model:value="typeFilter"
          class="filter-select"
          placeholder="按类型筛选"
          allow-clear
          :options="ORDER_TYPE_OPTIONS"
          @change="onTypeChange"
        />
        <a-select
          :value="state.customerId"
          class="filter-customer"
          placeholder="按客户筛选"
          allow-clear
          show-search
          :filter-option="false"
          :loading="customersLoading"
          :options="customerOptions"
          @search="searchCustomers"
          @change="onCustomerChange"
        />
        <a-range-picker
          :value="departureRange"
          value-format="YYYY-MM-DD"
          :placeholder="['出团起始日', '出团截止日']"
          class="filter-range"
          @change="onDepartureChange"
        />
        <a-button @click="resetFilters">重置筛选</a-button>
        <span v-if="listStatus === 'ready'" class="result-count" role="status"
          >共 {{ total }} 个订单</span
        >
      </div>
      <p v-if="customersError" class="filter-error">
        客户筛选加载失败：{{ customersError }}
        <a-button type="link" size="small" @click="loadCustomers()">重试</a-button>
      </p>
    </a-card>

    <a-alert
      v-if="listStatus === 'error'"
      type="error"
      show-icon
      :message="listError"
      description="列表请求没有成功，当前页面没有任何订单数据；这不代表系统中没有订单。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="listStatus === 'forbidden'"
      status="403"
      title="无权限查看订单"
      :sub-title="listError"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="listStatus === 'loading' && items.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载订单…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="items"
          :loading="listStatus === 'loading' && items.length > 0"
          :pagination="false"
          :scroll="{ x: 1320 }"
          :custom-row="rowProps"
          :locale="{
            emptyText: canWrite ? '暂无订单，点击右上角「新建订单」开始录入' : '暂无订单',
          }"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'orderNumber'">
              <a-button type="link" class="order-link" @click.stop="openDetail(record)">
                {{ record.orderNumber }}
              </a-button>
            </template>
            <template v-else-if="column.key === 'routeName'">
              {{ record.routeName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'status'">
              <a-tag :bordered="false" :color="ORDER_STATUS_TAG_COLORS[record.status]">
                {{ ORDER_STATUS_LABELS[record.status] }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'orderType'">
              {{ ORDER_TYPE_LABELS[record.orderType] }}
            </template>
            <template v-else-if="column.key === 'departureDate'">
              <span class="trip-date">出团 {{ record.departureDate ?? '—' }}</span>
              <span class="trip-date">回团 {{ record.returnDate ?? '—' }}</span>
            </template>
            <template v-else-if="column.key === 'personCount'">
              {{ record.personCount }}
            </template>
            <template
              v-else-if="
                column.key === 'receivableTotal' ||
                column.key === 'payableTotal' ||
                column.key === 'profit' ||
                column.key === 'uncollectedAmount' ||
                column.key === 'unpaidAmount'
              "
            >
              <span
                :class="
                  column.key === 'profit' ? (record.profit < 0 ? 'profit-neg' : 'profit-pos') : ''
                "
              >
                {{ formatMoney(record[column.dataIndex]) }}
              </span>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
          </template>
        </a-table>
        <a-pagination
          v-if="total > 0"
          class="pagination"
          :current="state.page"
          :page-size="state.pageSize"
          :total="total"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          show-size-changer
          show-quick-jumper
          @change="onPageChange"
        />
      </template>
    </a-card>

    <OrderDetailDrawer
      :open="detailOpen"
      :order-id="detailOrderId"
      :can-write="canWrite"
      :can-apply="canApply"
      :seed="detailSeed"
      @update:open="onDetailOpenChange"
      @edit="openEdit"
      @changed="onChanged"
    />
    <OrderFormModal v-model:open="formOpen" :order="editingOrder" @saved="onSaved" />
  </section>
</template>

<style scoped>
.orders-page {
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

.keyword-input {
  width: 240px;
}

.filter-select {
  width: 140px;
}

.filter-customer {
  width: 200px;
}

.filter-range {
  width: 260px;
}

.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.filter-error {
  margin: var(--space-8) 0 0;
  color: var(--color-error-text);
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

.order-link {
  height: auto;
  padding: 0;
}

.trip-date {
  display: block;
  font-size: var(--font-size-xs);
}

.profit-pos {
  color: var(--color-success-text);
}

.profit-neg {
  color: var(--color-error-text);
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}
</style>
