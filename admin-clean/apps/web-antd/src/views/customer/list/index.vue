<script lang="ts" setup>
import type {
  CustomerDetail,
  CustomerDuplicate,
  CustomerListItem,
  CustomerTag,
  Permission,
  SortOrder,
} from '@erp/contracts';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  CUSTOMER_SORT_FIELDS,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  InputSearch,
  message,
  Pagination,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import CustomerBatchTagModal from './customer-batch-tag-modal.vue';
import CustomerDetailDrawer from './customer-detail-drawer.vue';
import CustomerFormModal from './customer-form-modal.vue';
import CustomerTagManagerModal from './customer-tag-manager-modal.vue';

defineOptions({ name: 'CustomerList' });

type CustomerSortField = (typeof CUSTOMER_SORT_FIELDS)[number];

interface ListState {
  keyword: string;
  order: SortOrder;
  page: number;
  pageSize: number;
  sort: CustomerSortField;
  tagId: string | undefined;
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
const canRead = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_READ));
/** 隐藏入口只影响体验：服务端与 RLS 仍按 customer.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_WRITE));
/** 回收站入口绑定的是 customer.restore，不是 customer.read。 */
const canRestore = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_RESTORE));

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function isSortField(value: string): value is CustomerSortField {
  // 元组是字面量类型，`includes` 的参数被收窄成那几个值；这里按 `readonly string[]` 查。
  return (CUSTOMER_SORT_FIELDS as readonly string[]).includes(value);
}

function toPage(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function toPageSize(value: string | undefined): number {
  const parsed = Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

/**
 * URL 是列表状态的唯一来源：刷新、前进后退、把链接发给同事都能还原同一页。
 *
 * 代价是每次筛选都要改 URL，所以路由上标了 `meta.fullPathKey: false`，
 * 让页签按 `path` 而不是 `fullPath` 去重——否则每翻一页都会多一个页签。
 */
function readState(): ListState {
  const sortValue = firstQueryValue(route.query.sort);
  const orderValue = firstQueryValue(route.query.order);
  const keyword = firstQueryValue(route.query.keyword) ?? '';
  const tagId = firstQueryValue(route.query.tagId);
  return {
    keyword: keyword.slice(0, 100),
    order: orderValue === 'asc' ? 'asc' : 'desc',
    page: toPage(firstQueryValue(route.query.page)),
    pageSize: toPageSize(firstQueryValue(route.query.pageSize)),
    sort: sortValue && isSortField(sortValue) ? sortValue : 'createdAt',
    tagId: tagId || undefined,
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
  if (current.tagId) query.tagId = current.tagId;
  return query;
}

function isSameState(current: ListState, next: ListState): boolean {
  return (
    current.keyword === next.keyword &&
    current.order === next.order &&
    current.page === next.page &&
    current.pageSize === next.pageSize &&
    current.sort === next.sort &&
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
const loading = ref(true);
const loadFailed = ref('');
const forbidden = ref(false);
const duplicateWarning = ref<null | { count: number; items: CustomerDuplicate[] }>(null);
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
  loading.value = true;
  loadFailed.value = '';
  forbidden.value = false;
  try {
    const result = await authStore.api.call('listCustomers', {
      body: {
        order: state.order,
        page: state.page,
        pageSize: state.pageSize,
        sort: state.sort,
        ...(state.keyword ? { keyword: state.keyword } : {}),
        ...(state.tagId ? { tagId: state.tagId } : {}),
      },
    });
    // 快速翻页时丢弃过期响应，避免旧页数据覆盖新页。
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    if (
      error instanceof ApiClientError &&
      (error.code === 'FORBIDDEN' || error.code === 'TENANT_SCOPE_DENIED')
    ) {
      forbidden.value = true;
      loadFailed.value = error.message;
      return;
    }
    // 失败与空数据是两种事实：不能让用户以为系统里没有客户。
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.customers.loadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

const tags = ref<CustomerTag[]>([]);
const tagsLoading = ref(false);
const tagsError = ref('');

async function loadTags() {
  tagsLoading.value = true;
  tagsError.value = '';
  try {
    const result = await authStore.api.call('listCustomerTags');
    tags.value = result.tags;
  } catch (error) {
    tagsError.value =
      error instanceof ApiClientError ? error.message : $t('shell.customers.tagLoadFailed');
  } finally {
    tagsLoading.value = false;
  }
}

const tagOptions = computed(() => tags.value.map((tag) => ({ label: tag.name, value: tag.id })));

const detailOpen = ref(false);
const detailCustomerId = ref<null | string>(null);
const formOpen = ref(false);
const editingCustomer = ref<CustomerDetail | null>(null);
const tagManagerOpen = ref(false);
const batchOpen = ref(false);
const selectedRowKeys = ref<string[]>([]);

async function applyState(patch: Partial<ListState>) {
  Object.assign(state, patch);
  if (state.page < 1) state.page = 1;
  // 换页或换筛选后旧选择已不在视野里，留着会让「批量打标」作用到看不见的客户。
  selectedRowKeys.value = [];
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
    selectedRowKeys.value = [];
    void load();
  },
);

watch(
  () => authStore.currentOrganization?.organizationId,
  () => {
    // 换公司后旧的选择、抽屉里的客户、重复提示都不再属于当前数据范围。
    duplicateWarning.value = null;
    selectedRowKeys.value = [];
    detailCustomerId.value = null;
    detailOpen.value = false;
    void loadTags();
    void load();
  },
);

onMounted(() => {
  void loadTags();
  void load();
});

function submitKeyword() {
  // 契约 keyword 上限 100：超长会让请求整条被契约拒掉，页面看起来像「加载失败」。
  void applyState({ keyword: keywordInput.value.trim().slice(0, 100), page: 1 });
}

function onTagChange(value: unknown) {
  void applyState({ page: 1, tagId: typeof value === 'string' && value ? value : undefined });
}

function resetFilters() {
  keywordInput.value = '';
  tagFilter.value = undefined;
  void applyState({ keyword: '', page: 1, tagId: undefined });
}

function onPageChange(nextPage: number, nextPageSize: number) {
  // 改每页条数后原页码会失效，统一回到第一页。
  void applyState({ page: nextPageSize === state.pageSize ? nextPage : 1, pageSize: nextPageSize });
}

const pageSizeOptions = PAGE_SIZE_OPTIONS.map(String);

function sortOrderFor(field: CustomerSortField): 'ascend' | 'descend' | null {
  if (state.sort !== field) return null;
  return state.order === 'asc' ? 'ascend' : 'descend';
}

function onTableChange(_pagination: unknown, _filters: unknown, sorter: TableSorter | TableSorter[]) {
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
  {
    dataIndex: 'name',
    key: 'name',
    sortOrder: sortOrderFor('name'),
    sorter: true,
    title: $t('shell.customers.colName'),
    width: 160,
  },
  { dataIndex: 'phoneMasked', key: 'phone', title: $t('shell.customers.colPhone'), width: 150 },
  { dataIndex: 'emailMasked', key: 'email', title: $t('shell.customers.colEmail') },
  { dataIndex: 'sourceName', key: 'source', title: $t('shell.customers.colSource'), width: 120 },
  { dataIndex: 'tags', key: 'tags', title: $t('shell.customers.colTags') },
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    sortOrder: sortOrderFor('createdAt'),
    sorter: true,
    title: $t('shell.customers.colCreatedAt'),
    width: 170,
  },
]);

/** 勾选框与行点击共用一个单元格树：不排除的话点勾选会同时打开详情抽屉。 */
function rowProps(record: CustomerListItem) {
  return {
    onClick: (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest('.ant-table-selection-column')) return;
      openDetail(record);
    },
    style: { cursor: 'pointer' },
  };
}

const rowSelection = computed(() =>
  canWrite.value
    ? {
        onChange: (keys: (number | string)[]) => {
          selectedRowKeys.value = keys.map(String);
        },
        selectedRowKeys: selectedRowKeys.value,
      }
    : undefined,
);

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
  duplicateWarning.value = payload.duplicates.length > 0
    ? { count: payload.duplicates.length, items: payload.duplicates }
    : null;
  editingCustomer.value = null;
  message.success($t('shell.customers.savedNotice', { name: payload.customer.name }));
  await load();
}

async function onDeleted() {
  detailOpen.value = false;
  message.success($t('shell.customers.deletedNotice'));
  await load();
  // 删掉当前页最后一条时回到上一页，避免停在空页上。
  if (items.value.length === 0 && state.page > 1) await applyState({ page: state.page - 1 });
}

/** 标签改名/删除后必须重拉列表：列表里展示的是标签名，缓存住就会显示旧名字。 */
async function onTagsChanged() {
  await loadTags();
  await load();
}

async function onBatchApplied() {
  selectedRowKeys.value = [];
  await load();
}
</script>

<template>
  <Page :description="$t('shell.customers.description')" :title="$t('shell.menu.customers')">
    <Alert v-if="forbidden" :message="loadFailed || $t('shell.customers.forbidden')" show-icon type="warning" />

    <template v-else>
      <Alert v-if="duplicateWarning" class="mb-3" closable show-icon type="warning" @close="duplicateWarning = null">
        <template #message>{{ $t('shell.customers.duplicateTitle') }}</template>
        <template #description>
          <p>{{ $t('shell.customers.duplicateHint', { count: duplicateWarning.count }) }}</p>
          <ul class="m-0 pl-5">
            <li v-for="item in duplicateWarning.items" :key="item.id">
              {{ item.name }}（{{ item.phoneMasked ?? $t('shell.customers.duplicatePhoneHidden') }}）
            </li>
          </ul>
        </template>
      </Alert>

      <Card>
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <InputSearch
            v-model:value="keywordInput"
            allow-clear
            class="w-70"
            :maxlength="100"
            :placeholder="$t('shell.customers.keywordPlaceholder')"
            @search="submitKeyword"
          />
          <Select
            v-model:value="tagFilter"
            allow-clear
            class="w-50"
            :loading="tagsLoading"
            :options="tagOptions"
            :placeholder="$t('shell.customers.tagPlaceholder')"
            @change="onTagChange"
          />
          <Button @click="resetFilters">{{ $t('shell.customers.reset') }}</Button>
          <span class="text-sm text-muted-foreground">
            {{ $t('shell.customers.total', { total }) }}
          </span>
          <div class="ml-auto flex items-center gap-2">
            <Button :loading="loading" @click="load">{{ $t('shell.customers.refresh') }}</Button>
            <Button v-if="canRestore" @click="router.push('/customer/recycle')">
              {{ $t('shell.customers.recycleBin') }}
            </Button>
            <Button v-if="canWrite" @click="tagManagerOpen = true">
              {{ $t('shell.customers.tagManager') }}
            </Button>
            <Button v-if="canWrite" type="primary" @click="openCreate">
              {{ $t('shell.customers.create') }}
            </Button>
          </div>
        </div>

        <p v-if="tagsError" class="mb-3 text-sm text-red-600" role="alert">
          {{ tagsError }}
          <Button size="small" type="link" @click="loadTags">{{ $t('shell.customers.retry') }}</Button>
        </p>
        <Alert
          v-if="loadFailed"
          class="mb-3"
          show-icon
          type="error"
          :message="loadFailed"
          :description="$t('shell.customers.errorHint')"
        >
          <template #action>
            <Button size="small" @click="load">{{ $t('shell.customers.retry') }}</Button>
          </template>
        </Alert>

        <div v-if="canWrite && selectedRowKeys.length > 0" class="mb-2 flex items-center gap-3 rounded bg-muted px-3 py-2 text-sm">
          <span>{{ $t('shell.customers.selectedCount', { count: selectedRowKeys.length }) }}</span>
          <Button size="small" @click="batchOpen = true">{{ $t('shell.customers.batchTag') }}</Button>
          <Button size="small" type="text" @click="selectedRowKeys = []">
            {{ $t('shell.customers.clearSelection') }}
          </Button>
        </div>

        <Table
          :columns="columns"
          :custom-row="rowProps"
          :data-source="items"
          :loading="loading"
          :pagination="false"
          :row-selection="rowSelection"
          row-key="id"
          size="small"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <Button class="h-auto p-0" type="link" @click.stop="openDetail(record as CustomerListItem)">
                {{ (record as CustomerListItem).name }}
              </Button>
            </template>
            <template v-else-if="column.key === 'phone'">
              {{ (record as CustomerListItem).phoneMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'email'">
              {{ (record as CustomerListItem).emailMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'source'">
              {{ (record as CustomerListItem).sourceName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'tags'">
              <Space v-if="(record as CustomerListItem).tags.length > 0" :size="4" wrap>
                <Tag
                  v-for="tag in (record as CustomerListItem).tags"
                  :key="tag.id"
                  :bordered="false"
                  :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
                >
                  {{ tag.name }}
                </Tag>
              </Space>
              <span v-else>—</span>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime((record as CustomerListItem).createdAt) }}
            </template>
          </template>
          <template #emptyText>
            <div class="py-8 text-center text-muted-foreground">
              {{ canWrite ? $t('shell.customers.emptyWritable') : $t('shell.customers.empty') }}
            </div>
          </template>
        </Table>

        <div v-if="total > 0" class="mt-4 flex justify-end">
          <Pagination
            :current="state.page"
            :page-size="state.pageSize"
            :page-size-options="pageSizeOptions"
            show-quick-jumper
            show-size-changer
            :show-total="(count: number) => $t('shell.customers.total', { total: count })"
            :total="total"
            @change="onPageChange"
          />
        </div>
      </Card>
    </template>

    <CustomerDetailDrawer
      v-model:open="detailOpen"
      :can-write="canWrite"
      :customer-id="detailCustomerId"
      @deleted="onDeleted"
      @edit="openEdit"
    />
    <CustomerFormModal
      v-model:open="formOpen"
      :customer="editingCustomer"
      :tags="tags"
      @saved="onSaved"
    />
    <CustomerTagManagerModal v-model:open="tagManagerOpen" :tags="tags" @changed="onTagsChanged" />
    <CustomerBatchTagModal
      v-model:open="batchOpen"
      :customer-ids="selectedRowKeys"
      :tags="tags"
      @applied="onBatchApplied"
    />
  </Page>
</template>
