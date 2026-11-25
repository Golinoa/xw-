<script lang="ts" setup>
import type { OutstandingFilter, SortOrder } from '@erp/contracts';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
} from '@erp/contracts';
import { Alert, Card, InputSearch, Pagination, Select, Table } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime, formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  FINANCE_KINDS,
  type FinanceKind,
  type FinanceRow,
  type FinanceSortField,
  isFinanceKind,
  isFinanceSortField,
  isOutstandingChoice,
  OUTSTANDING_CHOICES,
  sortOrderFor,
  toFinanceRow,
  toOutstandingFilter,
} from '../receipts/finance-display';

defineOptions({ name: 'FinanceReceipts' });

interface TabState {
  keyword: string;
  order: SortOrder;
  outstanding: OutstandingFilter | undefined;
  page: number;
  pageSize: number;
  sort: FinanceSortField;
}
interface TabResult {
  error: string;
  items: FinanceRow[];
  status: 'error' | 'forbidden' | 'loading' | 'ready';
  total: number;
}

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const canRead = (() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions.includes(PERMISSIONS.ORDER_READ) : false;
})();

function firstQuery(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
function toPage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}
function toPageSize(value: string | undefined): number {
  const parsed = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_PAGE_SIZE;
}
function createTabState(): TabState {
  return {
    keyword: '',
    order: 'desc',
    outstanding: undefined,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sort: 'createdAt',
  };
}
function readKind(): FinanceKind {
  const value = firstQuery(route.query.tab);
  return value && isFinanceKind(value) ? value : 'receivable';
}
function readTabState(): TabState {
  const sortValue = firstQuery(route.query.sort);
  const outstandingValue = firstQuery(route.query.outstanding);
  return {
    keyword: (firstQuery(route.query.keyword) ?? '').slice(0, 100),
    order: firstQuery(route.query.order) === 'asc' ? 'asc' : 'desc',
    outstanding:
      outstandingValue && isOutstandingChoice(outstandingValue)
        ? toOutstandingFilter(outstandingValue)
        : undefined,
    page: toPage(firstQuery(route.query.page)),
    pageSize: toPageSize(firstQuery(route.query.pageSize)),
    sort: sortValue && isFinanceSortField(sortValue) ? sortValue : 'createdAt',
  };
}
function stateQuery(kind: FinanceKind, current: TabState): Record<string, string> {
  const query: Record<string, string> = {
    order: current.order,
    page: String(current.page),
    pageSize: String(current.pageSize),
    sort: current.sort,
    tab: kind,
  };
  if (current.keyword) query.keyword = current.keyword;
  if (current.outstanding) query.outstanding = current.outstanding;
  return query;
}

const activeKind = ref<FinanceKind>(readKind());
// 两个页签各存一份状态与结果：切换只影响自己，切回来还是原来的页码与筛选。
const tabStates = reactive<Record<FinanceKind, TabState>>({
  payable: createTabState(),
  receivable: createTabState(),
});
const results = reactive<Record<FinanceKind, TabResult>>({
  payable: { error: '', items: [], status: 'loading', total: 0 },
  receivable: { error: '', items: [], status: 'loading', total: 0 },
});
Object.assign(tabStates[activeKind.value], readTabState());

const requestSeq: Record<FinanceKind, number> = { payable: 0, receivable: 0 };
const activeTab = computed(() => tabStates[activeKind.value]);
const view = computed(() => results[activeKind.value]);
const keywordInput = ref(activeTab.value.keyword);
const outstandingSelect = computed({
  get: () => activeTab.value.outstanding ?? 'all',
  set: (value: 'all' | OutstandingFilter) => {
    activeTab.value.outstanding = toOutstandingFilter(value);
  },
});

watch(
  () => activeTab.value.keyword,
  (keyword) => (keywordInput.value = keyword),
);

async function load(kind: FinanceKind) {
  const result = results[kind];
  // 先占号再判权限：权限变化时也让在途请求失效，旧公司的响应不写进新状态。
  const seq = ++requestSeq[kind];
  if (!canRead) {
    result.items = [];
    result.total = 0;
    result.status = 'forbidden';
    return;
  }
  const tab = tabStates[kind];
  result.status = 'loading';
  result.error = '';
  const body = {
    order: tab.order,
    page: tab.page,
    pageSize: tab.pageSize,
    sort: tab.sort,
    ...(tab.keyword ? { keyword: tab.keyword } : {}),
    ...(tab.outstanding ? { outstanding: tab.outstanding } : {}),
  };
  try {
    const page =
      kind === 'receivable'
        ? await authStore.api.call('listReceivables', { body })
        : await authStore.api.call('listPayables', { body });
    if (seq !== requestSeq[kind]) return;
    result.items = page.items.map((item) => toFinanceRow(item));
    result.total = page.total;
    result.status = 'ready';
  } catch (error_) {
    if (seq !== requestSeq[kind]) return;
    result.items = [];
    result.total = 0;
    result.status = 'error';
    result.error = error_ instanceof ApiClientError ? error_.message : $t('shell.receipts.loadFailed');
  }
}

async function applyState(patch: Partial<TabState>) {
  Object.assign(tabStates[activeKind.value], patch);
  if (tabStates[activeKind.value].page < 1) tabStates[activeKind.value].page = 1;
  await router.replace({ query: stateQuery(activeKind.value, tabStates[activeKind.value]) });
  await load(activeKind.value);
}

watch(
  () => route.query,
  () => {
    const nextKind = readKind();
    const nextState = readTabState();
    const current = tabStates[nextKind];
    const same =
      current.keyword === nextState.keyword &&
      current.order === nextState.order &&
      current.outstanding === nextState.outstanding &&
      current.page === nextState.page &&
      current.pageSize === nextState.pageSize &&
      current.sort === nextState.sort;
    activeKind.value = nextKind;
    if (same) return;
    Object.assign(current, nextState);
    void load(nextKind);
  },
);

onMounted(() => {
  void load(activeKind.value);
});

function onTabChange(kind: FinanceKind) {
  activeKind.value = kind;
  void router.replace({ query: stateQuery(kind, tabStates[kind]) });
}
function submitKeyword() {
  void applyState({ keyword: keywordInput.value.trim().slice(0, 100), page: 1 });
}
function onOutstandingChange() {
  void applyState({ page: 1 });
}
function onPageChange(page: number, pageSize: number) {
  const tab = tabStates[activeKind.value];
  void applyState({ page: pageSize === tab.pageSize ? page : 1, pageSize });
}
function onTableChange(_p: unknown, _f: unknown, sorter: { columnKey?: number | string; order?: null | string } | { columnKey?: number | string; order?: null | string }[]) {
  const active = Array.isArray(sorter) ? sorter[0] : sorter;
  const field = typeof active?.columnKey === 'string' && isFinanceSortField(active.columnKey)
    ? active.columnKey
    : 'createdAt';
  void applyState({
    order: active?.order === 'ascend' ? 'asc' : 'desc',
    page: 1,
    sort: field,
  });
}

const pageSizeOptions = PAGE_SIZE_OPTIONS.map(String);
const outstandingOptions = computed(() =>
  OUTSTANDING_CHOICES.map((value) => ({
    label: $t(
      value === 'all'
        ? 'shell.receipts.outstandingAll'
        : (value === 'true'
          ? 'shell.receipts.outstandingUnsettled'
          : 'shell.receipts.outstandingSettled'),
    ),
    value,
  })),
);

const columns = computed(() => {
  const base: { align?: 'right'; dataIndex: string; key: string; sorter?: boolean; sortOrder?: 'ascend' | 'descend' | null; title: string; width?: number }[] = [
    { dataIndex: 'orderNumber', key: 'orderNumber', title: $t('shell.receipts.colOrderNumber'), width: 170 },
    { dataIndex: 'customerName', key: 'customerName', title: $t('shell.receipts.colCustomer'), width: 140 },
  ];
  if (activeKind.value === 'payable') {
    base.push({ dataIndex: 'supplierName', key: 'supplierName', title: $t('shell.receipts.colSupplier'), width: 160 });
  }
  base.push(
    { dataIndex: 'name', key: 'name', title: $t('shell.receipts.colName') },
    {
      align: 'right' as const,
      dataIndex: 'amount',
      key: 'amount',
      sorter: true,
      sortOrder: sortOrderFor({ order: activeTab.value.order, sort: activeTab.value.sort }, 'amount'),
      title: $t('shell.receipts.colAmount'),
      width: 130,
    },
    { align: 'right' as const, dataIndex: 'confirmedAmount', key: 'confirmedAmount', title: $t('shell.receipts.colConfirmed'), width: 130 },
    { align: 'right' as const, dataIndex: 'pendingAmount', key: 'pendingAmount', title: $t('shell.receipts.colPending'), width: 120 },
    { align: 'right' as const, dataIndex: 'availableAmount', key: 'availableAmount', title: $t('shell.receipts.colAvailable'), width: 130 },
    { dataIndex: 'createdAt', key: 'createdAt', sorter: true, sortOrder: sortOrderFor({ order: activeTab.value.order, sort: activeTab.value.sort }, 'createdAt'), title: $t('shell.receipts.colCreatedAt'), width: 170 },
  );
  return base;
});
</script>

<template>
  <Page :description="$t('shell.receipts.description')" :title="$t('shell.menu.finance')">
    <Card>
      <Alert v-if="!canRead || view.status === 'forbidden'" :message="$t('shell.receipts.forbidden')" show-icon type="warning" />

      <template v-else>
        <div class="mb-4 flex gap-1 border-b">
          <button
            v-for="kind in FINANCE_KINDS"
            :key="kind"
            class="border-b-2 px-4 py-2 text-sm"
            :class="activeKind === kind ? 'border-primary font-semibold' : 'border-transparent text-muted-foreground'"
            type="button"
            @click="onTabChange(kind)"
          >
            {{ $t(kind === 'receivable' ? 'shell.receipts.tabReceivable' : 'shell.receipts.tabPayable') }}
          </button>
        </div>

        <p v-if="view.status === 'error'" class="mb-4 text-sm text-red-600" role="alert">{{ view.error }}</p>

        <div class="mb-4 flex flex-wrap items-center gap-3">
          <InputSearch
            v-model:value="keywordInput"
            allow-clear
            class="w-60"
            :maxlength="100"
            :placeholder="$t('shell.receipts.keywordPlaceholder')"
            @search="submitKeyword"
          />
          <Select
            v-model:value="outstandingSelect"
            class="w-36"
            :options="outstandingOptions"
            @change="onOutstandingChange"
          />
          <span class="text-sm text-muted-foreground">{{ $t('shell.receipts.total', { total: view.total }) }}</span>
        </div>

        <Table
          :columns="columns"
          :data-source="view.items"
          :loading="view.status === 'loading'"
          :pagination="false"
          :locale="{ emptyText: $t('shell.receipts.empty') }"
          row-key="id"
          size="small"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'supplierName' || column.key === 'customerName' || column.key === 'name'">
              {{ record[column.key as keyof typeof record] ?? '—' }}
            </template>
            <template v-else-if="['amount', 'confirmedAmount', 'pendingAmount', 'availableAmount'].includes(String(column.key))">
              {{ formatMoney(record[column.key as keyof typeof record]) }}
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
          </template>
        </Table>

        <div v-if="view.total > 0" class="mt-4 flex justify-end">
          <Pagination
            :current="activeTab.page"
            :page-size="activeTab.pageSize"
            :page-size-options="pageSizeOptions"
            :total="view.total"
            show-size-changer
            @change="onPageChange"
          />
        </div>
        <p class="mt-3 text-xs text-muted-foreground">{{ $t('shell.receipts.serverComputedHint') }}</p>
      </template>
    </Card>
  </Page>
</template>
