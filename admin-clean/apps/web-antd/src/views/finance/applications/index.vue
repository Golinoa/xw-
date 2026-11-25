<script lang="ts" setup>
import type { FinanceApplicationItem, SortOrder } from '@erp/contracts';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  InputSearch,
  Modal,
  Pagination,
  Select,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  applicantLabelKey,
  APPLICATION_STATUS_FILTERS,
  APPLICATION_STATUS_LABEL_KEYS,
  APPLICATION_STATUS_TAG_COLORS,
  applicationStageLabelKey,
  type ApplicationStatusFilter,
  canDecide,
  canUndo,
  canWithdraw,
  isApplicationKind,
  isStatusFilter,
  PAYMENT_METHOD_LABEL_KEYS,
} from '../finance-application-display';

defineOptions({ name: 'FinanceApplications' });

type DecisionMode = 'approve' | 'reject' | 'undo' | 'withdraw';

interface DictationState {
  error: string;
  mode: DecisionMode | null;
  submitting: boolean;
  target: FinanceApplicationItem | null;
  text: string;
}

const SORT_FIELD = 'createdAt';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const permissions = computed<readonly import('@erp/contracts').Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ORDER_READ));
const currentUserId = computed(() => authStore.session?.user.id ?? null);

const rows = ref<FinanceApplicationItem[]>([]);
const total = ref(0);
const status = ref<'error' | 'forbidden' | 'loading' | 'ready'>('loading');
const error = ref('');

const filters = reactive({
  kind: 'all' as 'all' | 'payment' | 'receipt',
  keyword: '',
  order: 'desc' as SortOrder,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  status: 'pending' as ApplicationStatusFilter,
});
const keywordInput = ref('');
const sorter = reactive<{ field: string; order: SortOrder }>({ field: SORT_FIELD, order: 'desc' });

const dictation = reactive<DictationState>({
  error: '',
  mode: null,
  submitting: false,
  target: null,
  text: '',
});

let requestSeq = 0;

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
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

/** URL 是筛选状态唯一来源：刷新、返回、分享链接都回到同一屏。 */
function readFilters() {
  const statusValue = firstQuery(route.query.status);
  const kindValue = firstQuery(route.query.kind);
  filters.status = statusValue && isStatusFilter(statusValue) ? statusValue : 'pending';
  filters.kind = kindValue && isApplicationKind(kindValue) ? kindValue : 'all';
  filters.keyword = (firstQuery(route.query.keyword) ?? '').slice(0, 100);
  filters.page = toPage(firstQuery(route.query.page));
  filters.pageSize = toPageSize(firstQuery(route.query.pageSize));
  filters.order = firstQuery(route.query.order) === 'asc' ? 'asc' : 'desc';
  const sortValue = firstQuery(route.query.sort);
  sorter.field =
    sortValue === 'amount' || sortValue === 'occurredOn' || sortValue === SORT_FIELD
      ? sortValue
      : SORT_FIELD;
  keywordInput.value = filters.keyword;
}

function stateQuery(): Record<string, string> {
  const query: Record<string, string> = {
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    status: filters.status,
  };
  if (filters.kind !== 'all') query.kind = filters.kind;
  if (filters.keyword) query.keyword = filters.keyword;
  if (sorter.field !== SORT_FIELD || filters.order !== 'desc') {
    query.order = filters.order;
    query.sort = sorter.field;
  }
  return query;
}

async function load() {
  const seq = ++requestSeq;
  if (!canRead.value) {
    rows.value = [];
    total.value = 0;
    status.value = 'forbidden';
    return;
  }
  status.value = 'loading';
  error.value = '';
  const body = {
    order: filters.order,
    page: filters.page,
    pageSize: filters.pageSize,
    sort: sorter.field === 'amount' || sorter.field === 'occurredOn' ? sorter.field : SORT_FIELD,
    ...(filters.status === 'all' ? {} : { status: filters.status }),
    ...(filters.kind === 'all' ? {} : { kind: filters.kind }),
    ...(filters.keyword ? { keyword: filters.keyword } : {}),
  };
  try {
    const page = await authStore.api.call('listFinanceApplications', { body });
    if (seq !== requestSeq) return;
    rows.value = page.items;
    total.value = page.total;
    status.value = 'ready';
  } catch (error_) {
    if (seq !== requestSeq) return;
    rows.value = [];
    total.value = 0;
    if (
      error_ instanceof ApiClientError &&
      ['FORBIDDEN', 'TENANT_SCOPE_DENIED'].includes(error_.code)
    ) {
      status.value = 'forbidden';
      error.value = error_.message;
      return;
    }
    // 失败与空列表是两种事实：不能让「请求失败」看起来像「没有待审申请」。
    status.value = 'error';
    error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.applications.loadFailed');
  }
}

async function applyFilters(patch: Partial<typeof filters>) {
  Object.assign(filters, patch);
  if (filters.page < 1) filters.page = 1;
  await router.replace({ query: stateQuery() });
  await load();
}

function queryMatchesState(query: Record<string, unknown>): boolean {
  const expected = stateQuery();
  const keys = new Set([...Object.keys(expected), ...Object.keys(query)]);
  for (const key of keys) {
    const left = expected[key] ?? '';
    const right = typeof query[key] === 'string' ? (query[key] as string) : (firstQuery(query[key]) ?? '');
    if (left !== right) return false;
  }
  return true;
}

watch(
  () => route.query,
  () => {
    // 自家 applyFilters 引起的路由变化已经发过请求，这里只处理浏览器前进后退与外部链接。
    if (queryMatchesState(route.query)) return;
    readFilters();
    void load();
  },
);
watch(
  () => authStore.currentOrganization?.organizationId,
  () => {
    // 换公司后必须清空，否则会看到上一家公司的申请。
    rows.value = [];
    total.value = 0;
    void load();
  },
);

onMounted(() => {
  readFilters();
  void load();
});

function submitKeyword() {
  void applyFilters({ keyword: keywordInput.value.trim().slice(0, 100), page: 1 });
}
function onStatusChange(value: unknown) {
  void applyFilters({ page: 1, status: typeof value === 'string' && isStatusFilter(value) ? value : 'all' });
}
function onKindChange(value: unknown) {
  void applyFilters({ kind: typeof value === 'string' && isApplicationKind(value) ? value : 'all', page: 1 });
}
function onPageChange(page: number, pageSize: number) {
  void applyFilters({ page: pageSize === filters.pageSize ? page : 1, pageSize });
}
function onTableChange(
  _p: unknown,
  _f: unknown,
  sort: { columnKey?: number | string; order?: 'ascend' | 'descend' | null } | { columnKey?: number | string; order?: 'ascend' | 'descend' | null }[],
) {
  const active = Array.isArray(sort) ? sort[0] : sort;
  if ((active?.columnKey !== 'amount' && active?.columnKey !== 'occurredOn') || !active?.order) {
    sorter.field = SORT_FIELD;
    sorter.order = 'desc';
    void applyFilters({ order: 'desc', page: 1 });
    return;
  }
  sorter.field = active.columnKey;
  sorter.order = active.order === 'ascend' ? 'asc' : 'desc';
  void applyFilters({ order: sorter.order, page: 1 });
}
function rowSortOrder(key: string): 'ascend' | 'descend' | null {
  if (sorter.field !== key) return null;
  return sorter.order === 'asc' ? 'ascend' : 'descend';
}

function openDictation(mode: DecisionMode, target: FinanceApplicationItem) {
  dictation.mode = mode;
  dictation.target = target;
  dictation.text = '';
  dictation.error = '';
}
function closeDictation() {
  if (dictation.submitting) return;
  dictation.mode = null;
  dictation.target = null;
}

const textRequired = computed(() =>
  ['reject', 'undo', 'withdraw'].includes(dictation.mode ?? ''),
);
const dictationTitle = computed(() =>
  dictation.mode
    ? $t(`shell.applications.decide${dictation.mode.charAt(0).toUpperCase()}${dictation.mode.slice(1)}`)
    : '',
);
const dictationHint = computed(() =>
  dictation.mode ? $t(`shell.applications.hint${dictation.mode.charAt(0).toUpperCase()}${dictation.mode.slice(1)}`) : '',
);

async function submitDictation() {
  const target = dictation.target;
  const mode = dictation.mode;
  if (!target || !mode || dictation.submitting) return;

  const text = dictation.text.trim();
  if (textRequired.value && !text) {
    dictation.error = $t('shell.applications.reasonRequired');
    return;
  }

  dictation.submitting = true;
  dictation.error = '';
  try {
    if (mode === 'approve' || mode === 'reject') {
      await authStore.api.call('decideFinanceApplication', {
        body: { action: mode, version: target.version, ...(text ? { opinion: text } : {}) },
        params: { applicationId: target.id },
      });
    } else if (mode === 'withdraw') {
      await authStore.api.call('withdrawFinanceApplication', {
        body: { reason: text, version: target.version },
        params: { applicationId: target.id },
      });
    } else {
      await authStore.api.call('undoFinanceApplication', {
        body: { reason: text, version: target.version },
        params: { applicationId: target.id },
      });
    }
    dictation.mode = null;
    dictation.target = null;
    await load();
  } catch (error_) {
    if (
      error_ instanceof ApiClientError &&
      ['CONFLICT', 'FINANCE_APPLICATION_STATE_CONFLICT', 'FINANCE_SELF_APPROVAL_FORBIDDEN'].includes(
        error_.code,
      )
    ) {
      // 版本冲突/状态已变：这条记录已经不是你看到的样子，先刷新再让人决定。
      dictation.mode = null;
      dictation.target = null;
      await load();
      return;
    }
    dictation.error = error_ instanceof ApiClientError ? error_.message : $t('shell.applications.actionFailed');
  } finally {
    dictation.submitting = false;
  }
}

const columns = computed(() => [
  { dataIndex: 'orderNumber', key: 'orderNumber', title: $t('shell.applications.colOrderNumber'), width: 160 },
  { dataIndex: 'customerName', key: 'customerName', title: $t('shell.applications.colCustomer'), width: 130 },
  { dataIndex: 'kind', key: 'kind', title: $t('shell.applications.colKind'), width: 90 },
  { dataIndex: 'lineName', key: 'lineName', title: $t('shell.applications.colLine') },
  { align: 'right' as const, dataIndex: 'amount', key: 'amount', sorter: true, sortOrder: rowSortOrder('amount'), title: $t('shell.applications.colAmount'), width: 130 },
  { dataIndex: 'method', key: 'method', title: $t('shell.applications.colMethod'), width: 110 },
  { dataIndex: 'status', key: 'status', title: $t('shell.applications.colStatus'), width: 100 },
  { dataIndex: 'currentStep', key: 'step', title: $t('shell.applications.colStep'), width: 110 },
  { dataIndex: 'createdBy', key: 'applicant', title: $t('shell.applications.colApplicant'), width: 100 },
  { dataIndex: 'occurredOn', key: 'occurredOn', sorter: true, sortOrder: rowSortOrder('occurredOn'), title: $t('shell.applications.colOccurredOn'), width: 120 },
  { key: 'action', title: $t('shell.applications.colAction'), width: 200 },
]);
const statusOptions = computed(() =>
  APPLICATION_STATUS_FILTERS.map((value) => ({
    label: value === 'all' ? $t('shell.applications.statusAll') : $t(APPLICATION_STATUS_LABEL_KEYS[value]),
    value,
  })),
);
const kindOptions = [
  { label: $t('shell.applications.kindAll'), value: 'all' },
  { label: $t('shell.applications.kindReceipt'), value: 'receipt' },
  { label: $t('shell.applications.kindPayment'), value: 'payment' },
];
</script>

<template>
  <Page :description="$t('shell.applications.description')" :title="$t('shell.menu.financeApplications')">
    <Alert v-if="!canRead || status === 'forbidden'" :message="$t('shell.applications.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p v-if="status === 'error'" class="mb-4 text-sm text-red-600" role="alert">{{ error }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <InputSearch
          v-model:value="keywordInput"
          allow-clear
          class="w-56"
          :maxlength="100"
          :placeholder="$t('shell.applications.keywordPlaceholder')"
          @search="submitKeyword"
        />
        <Select
          :options="statusOptions"
          :value="filters.status"
          class="w-36"
          @change="onStatusChange"
        />
        <Select
          :options="kindOptions"
          :value="filters.kind"
          class="w-32"
          @change="onKindChange"
        />
        <span class="text-sm text-muted-foreground">{{ $t('shell.applications.total', { total }) }}</span>
      </div>

      <Table
        :columns="columns"
        :data-source="rows"
        :loading="status === 'loading'"
        :locale="{ emptyText: $t('shell.applications.empty') }"
        :pagination="false"
        row-key="id"
        size="small"
        @change="onTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'kind'">
            {{ $t(record.kind === 'receipt' ? 'shell.applications.kindReceipt' : 'shell.applications.kindPayment') }}
          </template>
          <template v-else-if="column.key === 'amount'">{{ formatMoney(record.amount) }}</template>
          <template v-else-if="column.key === 'method'">
            {{ $t(PAYMENT_METHOD_LABEL_KEYS[record.method as keyof typeof PAYMENT_METHOD_LABEL_KEYS]) }}
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="APPLICATION_STATUS_TAG_COLORS[record.status as keyof typeof APPLICATION_STATUS_TAG_COLORS]">
              {{ $t(APPLICATION_STATUS_LABEL_KEYS[record.status as keyof typeof APPLICATION_STATUS_LABEL_KEYS]) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'step'">
            {{ $t(applicationStageLabelKey(record as FinanceApplicationItem)) }}
          </template>
          <template v-else-if="column.key === 'applicant'">
            {{ $t(applicantLabelKey(record as FinanceApplicationItem, currentUserId)) }}
          </template>
          <template v-else-if="column.key === 'occurredOn'">{{ record.occurredOn }}</template>
          <template v-else-if="column.key === 'action'">
            <div class="flex flex-wrap gap-1">
              <Button
                v-if="canDecide(record as FinanceApplicationItem, permissions, currentUserId)"
                size="small"
                type="link"
                @click="openDictation('approve', record as FinanceApplicationItem)"
              >
                {{ $t('shell.applications.decideApprove') }}
              </Button>
              <Button
                v-if="canDecide(record as FinanceApplicationItem, permissions, currentUserId)"
                danger
                size="small"
                type="link"
                @click="openDictation('reject', record as FinanceApplicationItem)"
              >
                {{ $t('shell.applications.decideReject') }}
              </Button>
              <Button
                v-if="canWithdraw(record as FinanceApplicationItem, currentUserId)"
                size="small"
                type="link"
                @click="openDictation('withdraw', record as FinanceApplicationItem)"
              >
                {{ $t('shell.applications.decideWithdraw') }}
              </Button>
              <Button
                v-if="canUndo(record as FinanceApplicationItem, permissions)"
                size="small"
                type="link"
                @click="openDictation('undo', record as FinanceApplicationItem)"
              >
                {{ $t('shell.applications.decideUndo') }}
              </Button>
            </div>
          </template>
        </template>
      </Table>

      <div v-if="total > filters.pageSize" class="mt-4 flex justify-end">
        <Pagination
          :current="filters.page"
          :page-size="filters.pageSize"
          :page-size-options="PAGE_SIZE_OPTIONS.map(String)"
          :total="total"
          @change="onPageChange"
        />
      </div>
    </Card>

    <Modal
      :cancel-text="$t('shell.common.cancel')"
      :confirm-loading="dictation.submitting"
      :ok-text="dictationTitle"
      :open="dictation.mode !== null"
      :title="dictationTitle"
      @cancel="closeDictation"
      @ok="submitDictation"
    >
      <p class="mb-3 text-sm text-muted-foreground">{{ dictationHint }}</p>
      <Textarea
        v-model:value="dictation.text"
        :maxlength="500"
        :placeholder="textRequired ? $t('shell.applications.reasonPlaceholder') : $t('shell.applications.reasonOptionalPlaceholder')"
        :rows="3"
        show-count
      />
      <Alert v-if="dictation.error" class="mt-3" show-icon type="error" :message="dictation.error" />
    </Modal>
  </Page>
</template>
