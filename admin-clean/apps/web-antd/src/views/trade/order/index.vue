<script lang="ts" setup>
import type { OrderDetail, OrderListItem, OrderStatus, OrderType, Permission } from '@erp/contracts';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  ORDER_SORT_FIELDS,
  ORDER_STATUSES,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  type SortOrder,
} from '@erp/contracts';
import { Alert, Button, Card, DatePicker, InputSearch, Pagination, Select, Table, Tag } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime, formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { useCustomerOptions } from './customer-options';
import OrderDetailDrawer from './order-detail-drawer.vue';
import {
  ORDER_STATUS_LABEL_KEYS,
  ORDER_STATUS_OPTIONS,
  ORDER_STATUS_TAG_COLORS,
  ORDER_TYPE_LABEL_KEYS,
  ORDER_TYPE_OPTIONS,
} from './order-display';
import OrderFormModal from './order-form-modal.vue';

defineOptions({ name: 'TradeOrders' });

type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];

interface ListState {
  customerId: string | undefined;
  departureFrom: string | undefined;
  departureTo: string | undefined;
  keyword: string;
  order: SortOrder;
  orderType: OrderType | undefined;
  page: number;
  pageSize: number;
  sort: OrderSortField;
  status: OrderStatus | undefined;
}

interface TableSorter {
  columnKey?: number | string;
  order?: 'ascend' | 'descend' | null;
}

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ORDER_READ));
/** 隐藏入口只影响体验，服务端仍按 order.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.ORDER_WRITE));
/** 发起收付款申请是另一道权限：能改订单不等于能报款。 */
const canApply = computed(() => permissions.value.includes(PERMISSIONS.FINANCE_WRITE));

const {
  ensure: ensureCustomer,
  load: loadCustomers,
  options: customerOptions,
  search: searchCustomers,
  select: selectCustomer,
} = useCustomerOptions();

function firstQuery(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
function isSortField(value: string): value is OrderSortField {
  return (ORDER_SORT_FIELDS as readonly string[]).includes(value);
}
function isStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
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
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function toIsoDate(value: string | undefined): string | undefined {
  return value && ISO_DATE.test(value) ? value : undefined;
}

/** URL 是列表状态唯一来源：刷新、前进后退、分享链接都还原到同一页。 */
function readState(): ListState {
  const sortValue = firstQuery(route.query.sort);
  const statusValue = firstQuery(route.query.status);
  const typeValue = firstQuery(route.query.orderType);
  const customerId = firstQuery(route.query.customerId);
  return {
    customerId: customerId || undefined,
    departureFrom: toIsoDate(firstQuery(route.query.departureFrom)),
    departureTo: toIsoDate(firstQuery(route.query.departureTo)),
    keyword: (firstQuery(route.query.keyword) ?? '').slice(0, 100),
    order: firstQuery(route.query.order) === 'asc' ? 'asc' : 'desc',
    orderType: typeValue && isOrderType(typeValue) ? typeValue : undefined,
    page: toPage(firstQuery(route.query.page)),
    pageSize: toPageSize(firstQuery(route.query.pageSize)),
    sort: sortValue && isSortField(sortValue) ? sortValue : 'createdAt',
    status: statusValue && isStatus(statusValue) ? statusValue : undefined,
  };
}

function stateQuery(current: ListState): Record<string, string> {
  const query: Record<string, string> = {
    order: current.order,
    page: String(current.page),
    pageSize: String(current.pageSize),
    sort: current.sort,
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

function isSameState(a: ListState, b: ListState): boolean {
  return (
    a.page === b.page &&
    a.pageSize === b.pageSize &&
    a.sort === b.sort &&
    a.order === b.order &&
    a.keyword === b.keyword &&
    a.status === b.status &&
    a.orderType === b.orderType &&
    a.customerId === b.customerId &&
    a.departureFrom === b.departureFrom &&
    a.departureTo === b.departureTo
  );
}

const state = reactive<ListState>(readState());
const keywordInput = ref(state.keyword);
const statusFilter = ref<OrderStatus | undefined>(state.status);
const typeFilter = ref<OrderType | undefined>(state.orderType);

watch(() => state.keyword, (v) => (keywordInput.value = v));
watch(() => state.status, (v) => (statusFilter.value = v));
watch(() => state.orderType, (v) => (typeFilter.value = v));
/** 地址栏只有客户 id，进入/刷新时补出客户名，避免下拉显示裸 id。 */
watch(
  () => state.customerId,
  (id) => {
    if (id) void ensureCustomer(id);
    else selectCustomer(undefined);
  },
  { immediate: true },
);

const items = ref<OrderListItem[]>([]);
const total = ref(0);
const loading = ref(true);
const loadFailed = ref('');
const forbidden = ref(false);
let requestSeq = 0;

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    loading.value = false;
    forbidden.value = true;
    return;
  }
  const seq = ++requestSeq;
  forbidden.value = false;
  loading.value = true;
  loadFailed.value = '';
  try {
    const result = await authStore.api.call('listOrders', {
      body: {
        order: state.order,
        page: state.page,
        pageSize: state.pageSize,
        sort: state.sort,
        ...(state.keyword ? { keyword: state.keyword } : {}),
        ...(state.status ? { status: state.status } : {}),
        ...(state.orderType ? { orderType: state.orderType } : {}),
        ...(state.customerId ? { customerId: state.customerId } : {}),
        ...(state.departureFrom && state.departureTo
          ? { departureFrom: state.departureFrom, departureTo: state.departureTo }
          : {}),
      },
    });
    // 快速翻页时丢弃过期响应，避免旧页数据覆盖新页。
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    if (error_ instanceof ApiClientError && ['FORBIDDEN', 'TENANT_SCOPE_DENIED'].includes(error_.code)) {
      forbidden.value = true;
      loadFailed.value = error_.message;
    } else {
      // 失败与空数据是两种事实，不能让用户把「请求失败」理解成「没有订单」。
      loadFailed.value =
        error_ instanceof ApiClientError ? error_.message : $t('shell.orders.loadFailed');
    }
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

async function applyState(patch: Partial<ListState>) {
  Object.assign(state, patch);
  if (state.page < 1) state.page = 1;
  // replace 而非 push：翻页与筛选不该把每一步都塞进浏览器返回栈。
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
  () => authStore.currentOrganization?.organizationId,
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
  void applyState({ keyword: keywordInput.value.trim().slice(0, 100), page: 1 });
}
function onStatusChange(value: unknown) {
  void applyState({ page: 1, status: typeof value === 'string' && isStatus(value) ? value : undefined });
}
function onTypeChange(value: unknown) {
  void applyState({ orderType: typeof value === 'string' && isOrderType(value) ? value : undefined, page: 1 });
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
  void applyState({ departureFrom: toIsoDate(from), departureTo: toIsoDate(to), page: 1 });
}
function resetFilters() {
  keywordInput.value = '';
  statusFilter.value = undefined;
  typeFilter.value = undefined;
  selectCustomer(undefined);
  void applyState({
    customerId: undefined,
    departureFrom: undefined,
    departureTo: undefined,
    keyword: '',
    orderType: undefined,
    page: 1,
    status: undefined,
  });
}
function onPageChange(page: number, pageSize: number) {
  void applyState({ page: pageSize === state.pageSize ? page : 1, pageSize });
}

const pageSizeOptions = PAGE_SIZE_OPTIONS.map(String);
const statusOptions = computed(() =>
  ORDER_STATUS_OPTIONS.map((option) => ({ label: $t(option.labelKey), value: option.value })),
);
const typeOptions = computed(() =>
  ORDER_TYPE_OPTIONS.map((option) => ({ label: $t(option.labelKey), value: option.value })),
);
const showTotal = (count: number) => $t('shell.orders.total', { total: count });

function sortOrderFor(field: OrderSortField): 'ascend' | 'descend' | null {
  if (state.sort !== field) return null;
  return state.order === 'asc' ? 'ascend' : 'descend';
}
function onTableChange(_p: unknown, _f: unknown, sorter: TableSorter | TableSorter[]) {
  const active = Array.isArray(sorter) ? sorter[0] : sorter;
  const key = active?.columnKey;
  const field = typeof key === 'string' && isSortField(key) ? key : undefined;
  if (!field || !active?.order) {
    void applyState({ order: 'desc', page: 1, sort: 'createdAt' });
    return;
  }
  void applyState({ order: active.order === 'ascend' ? 'asc' : 'desc', page: 1, sort: field });
}

const columns = computed(() => [
  { dataIndex: 'orderNumber', key: 'orderNumber', sorter: true, sortOrder: sortOrderFor('orderNumber'), title: $t('shell.orders.colOrderNumber'), width: 170 },
  { dataIndex: 'customerName', key: 'customerName', title: $t('shell.orders.colCustomer'), width: 140 },
  { dataIndex: 'routeName', key: 'routeName', title: $t('shell.orders.colRoute') },
  { dataIndex: 'status', key: 'status', title: $t('shell.orders.colStatus'), width: 100 },
  { dataIndex: 'orderType', key: 'orderType', title: $t('shell.orders.colType'), width: 110 },
  { dataIndex: 'departureDate', key: 'departureDate', sorter: true, sortOrder: sortOrderFor('departureDate'), title: $t('shell.orders.colDates'), width: 210 },
  { align: 'right' as const, dataIndex: 'personCount', key: 'personCount', title: $t('shell.orders.colPeople'), width: 80 },
  { align: 'right' as const, dataIndex: 'receivableTotal', key: 'receivableTotal', title: $t('shell.orders.colReceivableTotal'), width: 140 },
  { align: 'right' as const, dataIndex: 'payableTotal', key: 'payableTotal', title: $t('shell.orders.colPayableTotal'), width: 140 },
  { align: 'right' as const, dataIndex: 'profit', key: 'profit', title: $t('shell.orders.colProfit'), width: 140 },
  { align: 'right' as const, dataIndex: 'uncollectedAmount', key: 'uncollectedAmount', title: $t('shell.orders.colUncollected'), width: 130 },
  { align: 'right' as const, dataIndex: 'unpaidAmount', key: 'unpaidAmount', title: $t('shell.orders.colUnpaid'), width: 130 },
  { dataIndex: 'createdAt', key: 'createdAt', sorter: true, sortOrder: sortOrderFor('createdAt'), title: $t('shell.orders.colCreatedAt'), width: 170 },
]);

function rowProps(record: OrderListItem) {
  return { onClick: () => openDetail(record), style: { cursor: 'pointer' } };
}

const detailOpen = ref(false);
const detailOrderId = ref<null | string>(null);
const detailSeed = ref<null | OrderDetail>(null);
const formOpen = ref(false);
const editingOrder = ref<null | OrderDetail>(null);

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
  // 用服务端返回的订单直接打开详情：金额是重算后的值，不是前端预估。
  detailSeed.value = order;
  detailOrderId.value = order.id;
  detailOpen.value = true;
  formOpen.value = false;
  await load();
}
async function onChanged() {
  await load();
}
</script>

<template>
  <Page :description="$t('shell.orders.description')" :title="$t('shell.menu.orders')">
    <Alert v-if="!canRead || forbidden" :message="$t('shell.orders.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p v-if="loadFailed" class="mb-4 text-sm text-red-600" role="alert">{{ loadFailed }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <InputSearch
          v-model:value="keywordInput"
          allow-clear
          class="w-60"
          :maxlength="100"
          :placeholder="$t('shell.orders.keywordPlaceholder')"
          @search="submitKeyword"
        />
        <Select
          v-model:value="statusFilter"
          allow-clear
          class="w-36"
          :options="statusOptions"
          :placeholder="$t('shell.orders.statusPlaceholder')"
          @change="onStatusChange"
        />
        <Select
          v-model:value="typeFilter"
          allow-clear
          class="w-36"
          :options="typeOptions"
          :placeholder="$t('shell.orders.typePlaceholder')"
          @change="onTypeChange"
        />
        <Select
          :filter-option="false"
          :loading="false"
          :options="customerOptions"
          :placeholder="$t('shell.orders.customerPlaceholder')"
          :value="state.customerId"
          class="w-48"
          show-search
          allow-clear
          @change="onCustomerChange"
          @search="searchCustomers"
        />
        <DatePicker.RangePicker
          :placeholder="[$t('shell.orders.departureFrom'), $t('shell.orders.departureTo')]"
          :value="departureRange"
          value-format="YYYY-MM-DD"
          @change="onDepartureChange"
        />
        <Button @click="resetFilters">{{ $t('shell.orders.resetFilters') }}</Button>
        <span class="text-sm text-muted-foreground">{{ $t('shell.orders.total', { total }) }}</span>
        <Button v-if="canWrite" class="ml-auto" type="primary" @click="openCreate">
          {{ $t('shell.orders.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :custom-row="rowProps"
        :data-source="items"
        :loading="loading"
        :locale="{
          emptyText: canWrite ? $t('shell.orders.emptyWritable') : $t('shell.orders.empty'),
        }"
        :pagination="false"
        :scroll="{ x: 1700 }"
        row-key="id"
        size="small"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'orderNumber'">
            <Button size="small" type="link" @click.stop="openDetail(record as OrderListItem)">
              {{ record.orderNumber }}
            </Button>
          </template>
          <template v-else-if="column.key === 'routeName'">{{ record.routeName ?? '—' }}</template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="ORDER_STATUS_TAG_COLORS[record.status as OrderStatus]">
              {{ $t(ORDER_STATUS_LABEL_KEYS[record.status as OrderStatus]) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'orderType'">
            {{ $t(ORDER_TYPE_LABEL_KEYS[record.orderType as OrderType]) }}
          </template>
          <template v-else-if="column.key === 'departureDate'">
            <span class="block text-xs">{{ $t('shell.orders.departure') }} {{ record.departureDate ?? '—' }}</span>
            <span class="block text-xs">{{ $t('shell.orders.return') }} {{ record.returnDate ?? '—' }}</span>
          </template>
          <template
v-else-if="[
            'receivableTotal', 'payableTotal', 'profit', 'uncollectedAmount', 'unpaidAmount',
          ].includes(String(column.key))">
            <span :class="column.key === 'profit' ? (record.profit < 0 ? 'text-red-600' : 'text-green-600') : ''">
              {{ formatMoney(record[column.dataIndex as keyof typeof record]) }}
            </span>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
        </template>
      </Table>

      <div v-if="total > 0" class="mt-4 flex justify-end">
        <Pagination
          :current="state.page"
          :page-size="state.pageSize"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          :total="total"
          show-quick-jumper
          show-size-changer
          @change="onPageChange"
        />
      </div>
    </Card>

    <OrderDetailDrawer
      :can-apply="canApply"
      :can-write="canWrite"
      :open="detailOpen"
      :order-id="detailOrderId"
      :seed="detailSeed"
      @changed="onChanged"
      @edit="openEdit"
      @update:open="onDetailOpenChange"
    />
    <OrderFormModal v-model:open="formOpen" :order="editingOrder" @saved="onSaved" />
  </Page>
</template>
