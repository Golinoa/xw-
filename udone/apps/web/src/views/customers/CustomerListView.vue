<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import {
  CUSTOMER_SORT_FIELDS,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type CustomerDetail,
  type CustomerDuplicate,
  type CustomerListItem,
  type CustomerTag,
  type Permission,
  type SortOrder,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import CustomerDetailDrawer from './CustomerDetailDrawer.vue';
import CustomerFormModal from './CustomerFormModal.vue';
import { formatDateTime } from './customer-display';

type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

interface ListState {
  page: number;
  pageSize: number;
  sort: CustomerSortField;
  order: SortOrder;
  keyword: string;
  tagId: string | undefined;
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
const canRead = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_READ));
/** 隐藏入口只影响体验：服务端与 RLS 仍按 customer.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_WRITE));

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function isSortField(value: string): value is CustomerSortField {
  return CUSTOMER_SORT_FIELDS.some((field) => field === value);
}

function toPage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function toPageSize(value: string | undefined): number {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

/** URL 是列表状态的唯一来源：刷新、前进后退、直接分享链接都能还原同一页。 */
function readState(): ListState {
  const sortValue = firstQueryValue(route.query.sort);
  const orderValue = firstQueryValue(route.query.order);
  const keyword = firstQueryValue(route.query.keyword) ?? '';
  const tagId = firstQueryValue(route.query.tagId);
  return {
    page: toPage(firstQueryValue(route.query.page)),
    pageSize: toPageSize(firstQueryValue(route.query.pageSize)),
    sort: sortValue && isSortField(sortValue) ? sortValue : 'createdAt',
    order: orderValue === 'asc' ? 'asc' : 'desc',
    keyword: keyword.slice(0, 100),
    tagId: tagId ? tagId : undefined,
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
  if (current.tagId) query.tagId = current.tagId;
  return query;
}

function isSameState(current: ListState, next: ListState): boolean {
  return (
    current.page === next.page &&
    current.pageSize === next.pageSize &&
    current.sort === next.sort &&
    current.order === next.order &&
    current.keyword === next.keyword &&
    current.tagId === next.tagId
  );
}

const state = reactive<ListState>(readState());
const keywordInput = ref(state.keyword);
const tagFilter = ref<string | undefined>(state.tagId);

watch(
  () => state.keyword,
  (keyword) => {
    keywordInput.value = keyword;
  },
);
watch(
  () => state.tagId,
  (tagId) => {
    tagFilter.value = tagId;
  },
);

const items = ref<CustomerListItem[]>([]);
const total = ref(0);
const listStatus = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const listError = ref('');
const duplicateWarning = ref<{ count: number; items: CustomerDuplicate[] } | null>(null);
let requestSeq = 0;

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    listStatus.value = 'forbidden';
    listError.value = '当前账号没有客户查看权限，请联系管理员开通。';
    return;
  }
  const seq = ++requestSeq;
  listStatus.value = 'loading';
  listError.value = '';
  try {
    const body: {
      page: number;
      pageSize: number;
      sort: CustomerSortField;
      order: SortOrder;
      keyword?: string;
      tagId?: string;
    } = {
      page: state.page,
      pageSize: state.pageSize,
      sort: state.sort,
      order: state.order,
      ...(state.keyword ? { keyword: state.keyword } : {}),
      ...(state.tagId ? { tagId: state.tagId } : {}),
    };
    const result = await auth.api.call('listCustomers', { body });
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
    // 失败与空数据是两种事实：这里必须进入错误态，不能让用户以为系统里没有客户。
    listStatus.value = 'error';
    listError.value =
      cause instanceof ApiClientError ? cause.message : '客户列表加载失败，请稍后重试';
  }
}

const tags = ref<CustomerTag[]>([]);
const tagsLoading = ref(false);
const tagsError = ref('');

async function loadTags() {
  tagsLoading.value = true;
  tagsError.value = '';
  try {
    const result = await auth.api.call('listCustomerTags');
    tags.value = result.tags;
  } catch (cause) {
    tagsError.value = cause instanceof ApiClientError ? cause.message : '标签加载失败';
  } finally {
    tagsLoading.value = false;
  }
}

const tagOptions = computed(() => tags.value.map((tag) => ({ value: tag.id, label: tag.name })));

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
    duplicateWarning.value = null;
    void loadTags();
    void load();
  },
);

onMounted(() => {
  void loadTags();
  void load();
});

function submitKeyword() {
  void applyState({ keyword: keywordInput.value.trim(), page: 1 });
}

function onTagChange(value: unknown) {
  void applyState({ tagId: typeof value === 'string' && value ? value : undefined, page: 1 });
}

function resetFilters() {
  keywordInput.value = '';
  tagFilter.value = undefined;
  void applyState({ keyword: '', tagId: undefined, page: 1 });
}

function onPageChange(page: number, pageSize: number) {
  // 改每页条数后页码会失效，统一回到第一页。
  void applyState({ page: pageSize === state.pageSize ? page : 1, pageSize });
}

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 条`;

function sortOrderFor(field: CustomerSortField): 'ascend' | 'descend' | null {
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
    title: '姓名',
    dataIndex: 'name',
    key: 'name',
    width: 150,
    sorter: true,
    sortOrder: sortOrderFor('name'),
  },
  { title: '电话', dataIndex: 'phoneMasked', key: 'phone', width: 150 },
  { title: '邮箱', dataIndex: 'emailMasked', key: 'email' },
  { title: '来源', dataIndex: 'sourceName', key: 'source', width: 120 },
  { title: '标签', dataIndex: 'tags', key: 'tags' },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 180,
    sorter: true,
    sortOrder: sortOrderFor('createdAt'),
  },
]);

function rowProps(record: CustomerListItem) {
  return {
    style: { cursor: 'pointer' },
    onClick: () => openDetail(record),
  };
}

const detailOpen = ref(false);
const detailCustomerId = ref<string | null>(null);
const formOpen = ref(false);
const editingCustomer = ref<CustomerDetail | null>(null);

function openDetail(record: CustomerListItem) {
  detailCustomerId.value = record.id;
  detailOpen.value = true;
}

function openCreate() {
  editingCustomer.value = null;
  formOpen.value = true;
}

function openEdit(customer: CustomerDetail) {
  editingCustomer.value = customer;
  // 抽屉与表单不同时显示同一客户，避免保存后抽屉里还是旧版本。
  detailOpen.value = false;
  formOpen.value = true;
}

async function onSaved(payload: { customer: CustomerDetail; duplicates: CustomerDuplicate[] }) {
  // 重复提示只是提醒，不阻断保存；列表与提示都以服务端回读结果为准。
  duplicateWarning.value = payload.duplicates.length
    ? { count: payload.duplicates.length, items: payload.duplicates }
    : null;
  message.success(`已保存客户「${payload.customer.name}」`);
  await load();
}

async function onDeleted() {
  detailOpen.value = false;
  message.success('客户已删除');
  await load();
  // 删掉当前页最后一条时回到上一页，避免停在空页上。
  if (items.value.length === 0 && state.page > 1) await applyState({ page: state.page - 1 });
}
</script>

<template>
  <section class="customers-page" aria-labelledby="customers-title">
    <header class="page-header">
      <div>
        <a-typography-title id="customers-title" :level="3" class="page-title"
          >客户</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          维护客户基础资料与标签；电话、邮箱与证件号按当前账号权限以掩码展示。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="listStatus === 'loading'" @click="load">刷新</a-button>
        <a-button v-if="canWrite" type="primary" @click="openCreate">新建客户</a-button>
      </a-space>
    </header>

    <a-alert
      v-if="duplicateWarning"
      class="duplicate-alert"
      type="warning"
      show-icon
      closable
      message="疑似重复客户"
      @close="duplicateWarning = null"
    >
      <template #description>
        <p>同手机号下已有 {{ duplicateWarning.count }} 位客户，请确认是否需要合并：</p>
        <ul class="duplicate-list">
          <li v-for="item in duplicateWarning.items" :key="item.id">
            {{ item.name }}（{{ item.phoneMasked ?? '号码不可见' }}）
          </li>
        </ul>
      </template>
    </a-alert>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索姓名、电话或邮箱"
          allow-clear
          @search="submitKeyword"
        />
        <a-select
          v-model:value="tagFilter"
          class="tag-filter"
          placeholder="按标签筛选"
          allow-clear
          :loading="tagsLoading"
          :options="tagOptions"
          @change="onTagChange"
        />
        <a-button @click="resetFilters">重置筛选</a-button>
        <span v-if="listStatus === 'ready'" class="result-count" role="status"
          >共 {{ total }} 位客户</span
        >
      </div>
      <p v-if="tagsError" class="tags-error">
        标签加载失败：{{ tagsError }}
        <a-button type="link" size="small" @click="loadTags">重试</a-button>
      </p>
    </a-card>

    <a-alert
      v-if="listStatus === 'error'"
      type="error"
      show-icon
      :message="listError"
      description="列表请求没有成功，当前页面没有任何客户数据；这不代表系统中没有客户。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="listStatus === 'forbidden'"
      status="403"
      title="无权限查看客户"
      :sub-title="listError"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="listStatus === 'loading' && items.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载客户…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="items"
          :loading="listStatus === 'loading' && items.length > 0"
          :pagination="false"
          :custom-row="rowProps"
          :locale="{
            emptyText: canWrite ? '暂无客户，点击右上角「新建客户」开始录入' : '暂无客户',
          }"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <a-button type="link" class="name-link" @click.stop="openDetail(record)">
                {{ record.name }}
              </a-button>
            </template>
            <template v-else-if="column.key === 'phone'">
              {{ record.phoneMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'email'">
              {{ record.emailMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'source'">
              {{ record.sourceName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'tags'">
              <a-space v-if="record.tags.length" :size="4" wrap>
                <a-tag
                  v-for="tag in record.tags"
                  :key="tag.id"
                  :bordered="false"
                  :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
                >
                  {{ tag.name }}
                </a-tag>
              </a-space>
              <span v-else>—</span>
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

    <CustomerDetailDrawer
      v-model:open="detailOpen"
      :customer-id="detailCustomerId"
      :can-write="canWrite"
      @edit="openEdit"
      @deleted="onDeleted"
    />
    <CustomerFormModal
      v-model:open="formOpen"
      :customer="editingCustomer"
      :tags="tags"
      @saved="onSaved"
    />
  </section>
</template>

<style scoped>
.customers-page {
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

.duplicate-alert {
  margin-bottom: var(--space-4);
}

.duplicate-list {
  margin: var(--space-4) 0 0;
  padding-left: var(--space-20);
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
  width: 280px;
}

.tag-filter {
  width: 200px;
}

.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.tags-error {
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

.name-link {
  height: auto;
  padding: 0;
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}
</style>
