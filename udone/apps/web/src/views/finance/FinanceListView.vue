<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type FinanceListQuery,
  type OutstandingFilter,
  type SortOrder,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import {
  OUTSTANDING_OPTIONS,
  financeColumns,
  isFinanceKind,
  isFinanceSortField,
  isOutstandingChoice,
  settlementLabel,
  toFinanceRow,
  toOutstandingFilter,
  type FinanceKind,
  type FinanceRow,
  type FinanceSortField,
  type FinanceSortState,
  type OutstandingChoice,
} from './finance-display';

interface TabState {
  page: number;
  pageSize: number;
  sort: FinanceSortField;
  order: SortOrder;
  keyword: string;
  outstanding: OutstandingFilter | undefined;
}

interface TabResult {
  items: FinanceRow[];
  total: number;
  status: 'loading' | 'ready' | 'error' | 'forbidden';
  error: string;
}

interface TableSorter {
  columnKey?: string | number;
  order?: 'ascend' | 'descend' | null;
}

const KIND_TABS: readonly FinanceKind[] = ['receivable', 'payable'];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/** 财务明细是订单的子资源，服务端也只用 order.read 一道闸；这里保持同一口径。 */
const canRead = computed(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions.includes(PERMISSIONS.ORDER_READ) : false;
});

function firstQueryValue(value: unknown): string | undefined {
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
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

function toOutstanding(value: string | undefined): OutstandingFilter | undefined {
  return value === 'true' || value === 'false' ? value : undefined;
}

function createTabState(): TabState {
  return {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sort: 'createdAt',
    order: 'desc',
    keyword: '',
    outstanding: undefined,
  };
}

/** URL 是页签与列表状态的唯一来源：刷新、前进后退、分享链接都还原到同一页。 */
function readKind(): FinanceKind {
  const value = firstQueryValue(route.query.tab);
  return value && isFinanceKind(value) ? value : 'receivable';
}

function readTabState(): TabState {
  const sortValue = firstQueryValue(route.query.sort);
  const orderValue = firstQueryValue(route.query.order);
  return {
    page: toPage(firstQueryValue(route.query.page)),
    pageSize: toPageSize(firstQueryValue(route.query.pageSize)),
    sort: sortValue && isFinanceSortField(sortValue) ? sortValue : 'createdAt',
    order: orderValue === 'asc' ? 'asc' : 'desc',
    keyword: (firstQueryValue(route.query.keyword) ?? '').slice(0, 100),
    outstanding: toOutstanding(firstQueryValue(route.query.outstanding)),
  };
}

function stateQuery(kind: FinanceKind, current: TabState): Record<string, string> {
  const query: Record<string, string> = {
    tab: kind,
    page: String(current.page),
    pageSize: String(current.pageSize),
    sort: current.sort,
    order: current.order,
  };
  if (current.keyword) query.keyword = current.keyword;
  if (current.outstanding) query.outstanding = current.outstanding;
  return query;
}

function isSameState(current: TabState, next: TabState): boolean {
  return (
    current.page === next.page &&
    current.pageSize === next.pageSize &&
    current.sort === next.sort &&
    current.order === next.order &&
    current.keyword === next.keyword &&
    current.outstanding === next.outstanding
  );
}

const activeKind = ref<FinanceKind>(readKind());
// 两个页签各存一份状态与结果：切换页签只影响自己，切换回来还是原来的页码与筛选。
const tabStates = reactive<Record<FinanceKind, TabState>>({
  receivable: createTabState(),
  payable: createTabState(),
});
const results = reactive<Record<FinanceKind, TabResult>>({
  receivable: { items: [], total: 0, status: 'loading', error: '' },
  payable: { items: [], total: 0, status: 'loading', error: '' },
});
Object.assign(tabStates[activeKind.value], readTabState());

/** 序号按页签分开计数：A 页签的旧响应不能把 B 页签刚拿到的结果挤掉，反之亦然。 */
const requestSeq: Record<FinanceKind, number> = { receivable: 0, payable: 0 };

const activeTab = computed(() => tabStates[activeKind.value]);
const view = computed(() => results[activeKind.value]);

const keywordInput = ref(activeTab.value.keyword);
watch(
  () => tabStates[activeKind.value].keyword,
  (keyword) => {
    keywordInput.value = keyword;
  },
);

async function load(kind: FinanceKind) {
  const result = results[kind];
  // 先占号再判权限：权限变化时也要让在途请求失效，否则旧公司的响应会写进新状态。
  const seq = ++requestSeq[kind];
  if (!canRead.value) {
    result.items = [];
    result.total = 0;
    result.status = 'forbidden';
    result.error = '当前账号没有订单与财务明细的查看权限，请联系管理员开通。';
    return;
  }
  const tab = tabStates[kind];
  result.status = 'loading';
  result.error = '';
  const body: FinanceListQuery = {
    page: tab.page,
    pageSize: tab.pageSize,
    sort: tab.sort,
    order: tab.order,
    ...(tab.keyword ? { keyword: tab.keyword } : {}),
    ...(tab.outstanding ? { outstanding: tab.outstanding } : {}),
  };
  try {
    // GET 的查询条件放在 body 里，由 api-client 序列化成查询串。
    const page =
      kind === 'receivable'
        ? await auth.api.call('listReceivables', { body })
        : await auth.api.call('listPayables', { body });
    // 快速翻页或连续切页签时丢弃过期响应，避免旧数据覆盖新数据。
    if (seq !== requestSeq[kind]) return;
    result.items = page.items.map(toFinanceRow);
    result.total = page.total;
    result.status = 'ready';
  } catch (cause) {
    if (seq !== requestSeq[kind]) return;
    result.items = [];
    result.total = 0;
    if (
      cause instanceof ApiClientError &&
      (cause.code === 'FORBIDDEN' || cause.code === 'TENANT_SCOPE_DENIED')
    ) {
      result.status = 'forbidden';
      result.error = cause.message;
      return;
    }
    // 失败与空数据是两种事实：不能让用户把「请求失败」理解成「系统里没有明细」。
    result.status = 'error';
    result.error = cause instanceof ApiClientError ? cause.message : '财务明细加载失败，请稍后重试';
  }
}

async function applyState(kind: FinanceKind, patch: Partial<TabState>) {
  const tab = tabStates[kind];
  Object.assign(tab, patch);
  if (tab.page < 1) tab.page = 1;
  // replace 而非 push：翻页与筛选不应该把每一步都塞进浏览器返回栈。
  if (kind === activeKind.value) await router.replace({ query: stateQuery(kind, tab) });
  await load(kind);
}

async function switchKind(kind: FinanceKind) {
  activeKind.value = kind;
  await router.replace({ query: stateQuery(kind, tabStates[kind]) });
  // 切换页签一律重查：另一侧的数据可能已经被结算或新增，缓存展示会给出过期金额。
  await load(kind);
}

watch(
  () => route.query,
  () => {
    const kind = readKind();
    const next = readTabState();
    if (kind === activeKind.value && isSameState(tabStates[kind], next)) return;
    activeKind.value = kind;
    Object.assign(tabStates[kind], next);
    void load(kind);
  },
);

watch(
  () => auth.currentOrganization.value?.organizationId,
  () => {
    // 换公司后必须丢掉另一侧页签的缓存，否则会看到上一家公司的明细。
    for (const kind of KIND_TABS) {
      results[kind].items = [];
      results[kind].total = 0;
    }
    void load(activeKind.value);
  },
);

onMounted(() => {
  void load(activeKind.value);
});

function reloadActive() {
  void load(activeKind.value);
}

function onTabChange(key: string | number) {
  if (typeof key !== 'string' || !isFinanceKind(key) || key === activeKind.value) return;
  void switchKind(key);
}

function submitKeyword() {
  void applyState(activeKind.value, { keyword: keywordInput.value.trim(), page: 1 });
}

/**
 * 点输入框的清除图标只会触发 change，不会触发 search；不处理这个分支的话，
 * 界面上关键词已经空了、列表还停在旧结果上。只接管「被清空」这一种情况，
 * 其余输入仍然等用户回车或点搜索，避免每敲一个字就发一次请求。
 */
function onKeywordChange(event: { target: { value?: string } } | string) {
  const value = typeof event === 'string' ? event : (event.target.value ?? '');
  if (value !== '' || activeTab.value.keyword === '') return;
  void applyState(activeKind.value, { keyword: '', page: 1 });
}

function onOutstandingChange(value: unknown) {
  const choice: OutstandingChoice =
    typeof value === 'string' && isOutstandingChoice(value) ? value : 'all';
  void applyState(activeKind.value, { outstanding: toOutstandingFilter(choice), page: 1 });
}

function resetFilters() {
  keywordInput.value = '';
  void applyState(activeKind.value, { keyword: '', outstanding: undefined, page: 1 });
}

function onPageChange(page: number, pageSize: number) {
  // 改每页条数后页码会失效，统一回到第一页。
  void applyState(activeKind.value, {
    page: pageSize === activeTab.value.pageSize ? page : 1,
    pageSize,
  });
}

function onTableChange(
  _pagination: unknown,
  _filters: unknown,
  sorter: TableSorter | TableSorter[],
) {
  const active = Array.isArray(sorter) ? sorter[0] : sorter;
  const key = active?.columnKey;
  const field = typeof key === 'string' && isFinanceSortField(key) ? key : undefined;
  if (!field || !active?.order) {
    void applyState(activeKind.value, { sort: 'createdAt', order: 'desc', page: 1 });
    return;
  }
  void applyState(activeKind.value, {
    sort: field,
    order: active.order === 'ascend' ? 'asc' : 'desc',
    page: 1,
  });
}

const sortState = computed<FinanceSortState>(() => ({
  sort: activeTab.value.sort,
  order: activeTab.value.order,
}));
const columns = computed(() => financeColumns(activeKind.value, sortState.value));

const kindLabel = computed(() => (activeKind.value === 'receivable' ? '应收' : '应付'));
const emptyText = computed(() => {
  const tab = activeTab.value;
  if (tab.keyword || tab.outstanding) return '没有符合筛选条件的明细，可以放宽条件或重置筛选。';
  return `暂无${kindLabel.value}明细`;
});

const tableScrollX = computed(() => (activeKind.value === 'receivable' ? 1200 : 1480));
const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 条明细`;
</script>

<template>
  <section class="finance-page" aria-labelledby="finance-title">
    <header class="page-header">
      <div>
        <a-typography-title id="finance-title" :level="3" class="page-title"
          >应收 / 应付明细</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          金额、已确认、在途与可申请余额均以服务端计算结果为准；订单号可跳转到对应订单。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="view.status === 'loading'" @click="reloadActive">刷新</a-button>
      </a-space>
    </header>

    <a-tabs :active-key="activeKind" class="kind-tabs" @change="onTabChange">
      <a-tab-pane key="receivable" tab="应收明细" />
      <a-tab-pane key="payable" tab="应付明细" />
    </a-tabs>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索项目名称或订单号"
          allow-clear
          @search="submitKeyword"
          @change="onKeywordChange"
        />
        <a-select
          :value="activeTab.outstanding ?? 'all'"
          class="filter-select"
          :options="OUTSTANDING_OPTIONS"
          @change="onOutstandingChange"
        />
        <a-button @click="resetFilters">重置筛选</a-button>
        <span v-if="view.status === 'ready'" class="result-count" role="status"
          >共 {{ view.total }} 条明细</span
        >
      </div>
    </a-card>

    <a-alert
      v-if="view.status === 'error'"
      type="error"
      show-icon
      :message="view.error"
      description="列表请求没有成功，当前页面没有任何明细数据；这不代表系统中没有明细。"
    >
      <template #action>
        <a-button size="small" @click="reloadActive">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="view.status === 'forbidden'"
      status="403"
      title="无权限查看财务明细"
      :sub-title="view.error"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div
        v-if="view.status === 'loading' && view.items.length === 0"
        class="list-status"
        role="status"
      >
        <a-spin />
        <span>正在加载{{ kindLabel }}明细…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="view.items"
          :loading="view.status === 'loading' && view.items.length > 0"
          :pagination="false"
          :scroll="{ x: tableScrollX }"
          :locale="{ emptyText }"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'orderNumber'">
              <RouterLink
                v-if="record.orderStatus !== null"
                class="order-link"
                :to="`/orders?keyword=${encodeURIComponent(record.orderNumber)}`"
              >
                {{ record.orderNumber }}
              </RouterLink>
              <span v-else>—</span>
            </template>
            <template v-else-if="column.key === 'customerName'">
              {{ record.orderStatus === null ? '—' : record.customerName }}
            </template>
            <template v-else-if="column.key === 'supplierName'">
              {{ record.supplierName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'settlement'">
              {{ settlementLabel(record.settlement) }}
            </template>
            <template
              v-else-if="
                column.key === 'amount' ||
                column.key === 'confirmedAmount' ||
                column.key === 'pendingAmount' ||
                column.key === 'availableAmount'
              "
            >
              {{ formatMoney(record[column.dataIndex]) }}
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
          </template>
        </a-table>
        <a-pagination
          v-if="view.total > 0"
          class="pagination"
          :current="activeTab.page"
          :page-size="activeTab.pageSize"
          :total="view.total"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          show-size-changer
          show-quick-jumper
          @change="onPageChange"
        />
      </template>
    </a-card>
  </section>
</template>

<style scoped>
.finance-page {
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

.kind-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0;
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
  width: 260px;
}

.filter-select {
  width: 140px;
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

.order-link {
  color: var(--color-primary);
  text-decoration: none;
}

.order-link:hover {
  color: var(--color-primary-hover);
  text-decoration: underline;
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}
</style>
