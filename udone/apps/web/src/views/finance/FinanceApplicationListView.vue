<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type FinanceApplicationItem,
  type FinanceApplicationListQuery,
  type SortOrder,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import {
  APPLICATION_KIND_LABELS,
  APPLICATION_KIND_OPTIONS,
  APPLICATION_STATUS_FILTER_OPTIONS,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUS_TAG_COLORS,
  PAYMENT_METHOD_LABELS,
  applicantLabel,
  applicationStageLabel,
  canDecide,
  canUndo,
  canWithdraw,
  isApplicationKind,
  isStatusFilter,
  type ApplicationStatusFilter,
} from './finance-application-display';

type DecisionMode = 'approve' | 'reject' | 'withdraw' | 'undo';

interface DictationState {
  mode: DecisionMode | null;
  target: FinanceApplicationItem | null;
  text: string;
  error: string;
  submitting: boolean;
}

const SORT_FIELD = 'createdAt';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

/** 列表只用 order.read（与服务端一致）：能看到订单的人就该看到它的收付款申请。 */
const permissions = computed(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ORDER_READ));
const currentUserId = computed(() => auth.user.value?.id ?? null);

const rows = ref<FinanceApplicationItem[]>([]);
const total = ref(0);
const status = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const error = ref('');

const filters = reactive({
  status: 'pending' as ApplicationStatusFilter,
  kind: 'all' as 'all' | 'receipt' | 'payment',
  keyword: '',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  order: 'desc' as SortOrder,
});

const keywordInput = ref('');
const sorter = reactive<{ field: string; order: SortOrder }>({ field: SORT_FIELD, order: 'desc' });

const dictation = reactive<DictationState>({
  mode: null,
  target: null,
  text: '',
  error: '',
  submitting: false,
});

/**
 * 序号守卫：翻页、改筛选、切换公司都会让在途请求过期。
 * 没有它的话，先发的慢请求会把后发的快请求结果覆盖掉，列表就会闪回旧数据。
 */
let requestSeq = 0;

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

/** URL 是筛选状态的唯一来源：刷新、返回、分享链接都回到同一屏。 */
function readFilters() {
  const statusValue = firstQueryValue(route.query.status);
  const kindValue = firstQueryValue(route.query.kind);
  filters.status = statusValue && isStatusFilter(statusValue) ? statusValue : 'pending';
  filters.kind = kindValue && isApplicationKind(kindValue) ? kindValue : 'all';
  filters.keyword = (firstQueryValue(route.query.keyword) ?? '').slice(0, 100);
  filters.page = toPage(firstQueryValue(route.query.page));
  filters.pageSize = toPageSize(firstQueryValue(route.query.pageSize));
  filters.order = firstQueryValue(route.query.order) === 'asc' ? 'asc' : 'desc';
  // 排序字段也要从 URL 还原：否则刷新后表头显示的是默认排序，而列表还是上次的金额升序。
  const sortValue = firstQueryValue(route.query.sort);
  sorter.field =
    sortValue === 'amount' || sortValue === 'occurredOn' || sortValue === SORT_FIELD
      ? sortValue
      : SORT_FIELD;
  keywordInput.value = filters.keyword;
}

function stateQuery(): Record<string, string> {
  const query: Record<string, string> = {
    status: filters.status,
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  };
  if (filters.kind !== 'all') query.kind = filters.kind;
  if (filters.keyword) query.keyword = filters.keyword;
  if (sorter.field !== SORT_FIELD || filters.order !== 'desc') {
    query.sort = sorter.field;
    query.order = filters.order;
  }
  return query;
}

async function load() {
  const seq = ++requestSeq;
  if (!canRead.value) {
    rows.value = [];
    total.value = 0;
    status.value = 'forbidden';
    error.value = '当前账号没有订单查看权限，收付款申请也不可见。请联系管理员开通。';
    return;
  }
  status.value = 'loading';
  error.value = '';
  const body: FinanceApplicationListQuery = {
    page: filters.page,
    pageSize: filters.pageSize,
    // 排序字段白名单只有 createdAt / amount / occurredOn；界面目前只提供时间与金额两种。
    sort: sorter.field === 'amount' || sorter.field === 'occurredOn' ? sorter.field : 'createdAt',
    order: filters.order,
    ...(filters.status === 'all' ? {} : { status: filters.status }),
    ...(filters.kind === 'all' ? {} : { kind: filters.kind }),
    ...(filters.keyword ? { keyword: filters.keyword } : {}),
  };
  try {
    const page = await auth.api.call('listFinanceApplications', { body });
    if (seq !== requestSeq) return;
    rows.value = page.items;
    total.value = page.total;
    status.value = 'ready';
  } catch (cause) {
    if (seq !== requestSeq) return;
    rows.value = [];
    total.value = 0;
    if (
      cause instanceof ApiClientError &&
      (cause.code === 'FORBIDDEN' || cause.code === 'TENANT_SCOPE_DENIED')
    ) {
      status.value = 'forbidden';
      error.value = cause.message;
      return;
    }
    // 失败与空列表是两种事实：不能让「请求失败」看起来像「没有待审申请」。
    status.value = 'error';
    error.value =
      cause instanceof ApiClientError ? cause.message : '收付款申请加载失败，请稍后重试';
  }
}

async function applyFilters(patch: Partial<typeof filters>) {
  Object.assign(filters, patch);
  if (filters.page < 1) filters.page = 1;
  await router.replace({ query: stateQuery() });
  await load();
}

/**
 * 判断当前 URL 是否已经等同于界面状态。
 *
 * `applyFilters` 会先改 URL 再自己发一次请求，而路由变化又会触发 watcher。
 * 不比这一下就会变成每次翻页发两个请求——两个几乎同时返回，列表闪一下，
 * 分页器偶尔还会停在旧页。
 */
function queryMatchesState(query: Record<string, unknown>): boolean {
  const expected = stateQuery();
  const keys = new Set([...Object.keys(expected), ...Object.keys(query)]);
  for (const key of keys) {
    const left = expected[key] ?? '';
    const right =
      typeof query[key] === 'string' ? (query[key] as string) : (firstQueryValue(query[key]) ?? '');
    if (left !== right) return false;
  }
  return true;
}

watch(
  () => route.query,
  async () => {
    // 自家 applyFilters 引起的路由变化已经发过请求，这里只处理浏览器前进后退与外部链接。
    if (queryMatchesState(route.query)) return;
    readFilters();
    await load();
  },
);

watch(
  () => auth.currentOrganization.value?.organizationId,
  async () => {
    // 换公司后必须清空：否则会看到上一家公司的申请。
    rows.value = [];
    total.value = 0;
    await load();
  },
);

onMounted(async () => {
  readFilters();
  await load();
});

function submitKeyword() {
  void applyFilters({ keyword: keywordInput.value.trim(), page: 1 });
}

function onKeywordChange(event: { target: { value?: string } } | string) {
  const value = typeof event === 'string' ? event : (event.target.value ?? '');
  // 只接管「被清空」：其余输入等回车或点搜索，避免每敲一个字发一次请求。
  if (value !== '' || filters.keyword === '') return;
  void applyFilters({ keyword: '', page: 1 });
}

function onStatusChange(value: unknown) {
  const next = typeof value === 'string' && isStatusFilter(value) ? value : 'all';
  void applyFilters({ status: next, page: 1 });
}

function onKindChange(value: unknown) {
  const next = typeof value === 'string' && isApplicationKind(value) ? value : 'all';
  void applyFilters({ kind: next, page: 1 });
}

function resetFilters() {
  keywordInput.value = '';
  sorter.field = SORT_FIELD;
  sorter.order = 'desc';
  void applyFilters({ status: 'pending', kind: 'all', keyword: '', page: 1, order: 'desc' });
}

function onPageChange(page: number, pageSize: number) {
  void applyFilters({ page: pageSize === filters.pageSize ? page : 1, pageSize });
}

function onTableChange(
  _pagination: unknown,
  _filters: unknown,
  sort: { columnKey?: string | number; order?: 'ascend' | 'descend' | null } | Array<unknown>,
) {
  const active = Array.isArray(sort)
    ? (sort[0] as { columnKey?: string | number; order?: 'ascend' | 'descend' | null })
    : sort;
  const key = active?.columnKey;
  if ((key !== 'amount' && key !== 'occurredOn') || !active?.order) {
    sorter.field = SORT_FIELD;
    sorter.order = 'desc';
    void applyFilters({ page: 1, order: 'desc' });
    return;
  }
  sorter.field = key;
  sorter.order = active.order === 'ascend' ? 'asc' : 'desc';
  void applyFilters({ page: 1, order: sorter.order });
}

function rowSortOrder(key: string): 'ascend' | 'descend' | null {
  if (sorter.field !== key) return null;
  return sorter.order === 'asc' ? 'ascend' : 'descend';
}

function decideRow(item: FinanceApplicationItem): boolean {
  return canDecide(item, permissions.value, currentUserId.value);
}
function withdrawRow(item: FinanceApplicationItem): boolean {
  return canWithdraw(item, currentUserId.value);
}
function undoRow(item: FinanceApplicationItem): boolean {
  return canUndo(item, permissions.value);
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

const dictationTitle = computed(() => {
  switch (dictation.mode) {
    case 'approve':
      return '通过申请';
    case 'reject':
      return '驳回申请';
    case 'withdraw':
      return '撤回申请';
    case 'undo':
      return '撤销终审';
    default:
      return '';
  }
});

const dictationHint = computed(() => {
  switch (dictation.mode) {
    case 'withdraw':
      return '撤回后会立即释放占用的额度，申请进入已撤回状态，不能再次提交。';
    case 'undo':
      return '撤销终审会把已确认的金额退回在途，申请回到待管理员终审。';
    case 'reject':
      return '驳回必须写明原因，创建人据此修改后重新提交。';
    default:
      return '通过后如果这是终审，金额会从在途转入已收/已付。';
  }
});

const textRequired = computed(
  () => dictation.mode === 'reject' || dictation.mode === 'withdraw' || dictation.mode === 'undo',
);

async function submitDictation() {
  const target = dictation.target;
  const mode = dictation.mode;
  if (!target || !mode || dictation.submitting) return;

  const text = dictation.text.trim();
  if (textRequired.value && !text) {
    dictation.error = mode === 'reject' ? '驳回必须填写原因' : '请填写原因';
    return;
  }

  dictation.submitting = true;
  dictation.error = '';
  try {
    if (mode === 'approve' || mode === 'reject') {
      await auth.api.call('decideFinanceApplication', {
        params: { applicationId: target.id },
        body: {
          action: mode,
          version: target.version,
          ...(text ? { opinion: text } : {}),
        },
      });
      message.success(mode === 'approve' ? '已通过' : '已驳回');
    } else if (mode === 'withdraw') {
      await auth.api.call('withdrawFinanceApplication', {
        params: { applicationId: target.id },
        body: { reason: text, version: target.version },
      });
      message.success('已撤回');
    } else {
      await auth.api.call('undoFinanceApplication', {
        params: { applicationId: target.id },
        body: { reason: text, version: target.version },
      });
      message.success('已撤销终审');
    }
    dictation.mode = null;
    dictation.target = null;
    await load();
  } catch (cause) {
    if (cause instanceof ApiClientError) {
      // 版本冲突或状态已变：这条记录已经不是你看到的样子了，先刷新再让人决定。
      if (
        cause.code === 'CONFLICT' ||
        cause.code === 'FINANCE_APPLICATION_STATE_CONFLICT' ||
        cause.code === 'FINANCE_SELF_APPROVAL_FORBIDDEN'
      ) {
        message.warning(cause.message);
        dictation.mode = null;
        dictation.target = null;
        await load();
        return;
      }
      dictation.error = cause.message;
      return;
    }
    dictation.error = '操作失败，请稍后重试';
  } finally {
    dictation.submitting = false;
  }
}

const emptyText = computed(() => {
  if (filters.keyword || filters.kind !== 'all' || filters.status !== 'all') {
    return '没有符合条件的申请，可以放宽筛选条件或重置。';
  }
  return '暂无收付款申请';
});

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 条申请`;
</script>

<template>
  <section class="applications-page" aria-labelledby="applications-title">
    <header class="page-header">
      <div>
        <a-typography-title id="applications-title" :level="3" class="page-title"
          >收付款申请</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          待审只占用额度、不计入已收已付；终审通过后才入账。提交人不能审批自己的申请。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="status === 'loading'" @click="load">刷新</a-button>
      </a-space>
    </header>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索订单号、客户或项目名称"
          allow-clear
          @search="submitKeyword"
          @change="onKeywordChange"
        />
        <a-select
          :value="filters.status"
          class="filter-select"
          :options="APPLICATION_STATUS_FILTER_OPTIONS"
          @change="onStatusChange"
        />
        <a-select
          :value="filters.kind"
          class="filter-select"
          :options="[{ value: 'all', label: '全部类型' }, ...APPLICATION_KIND_OPTIONS]"
          @change="onKindChange"
        />
        <a-button @click="resetFilters">重置筛选</a-button>
        <span v-if="status === 'ready'" class="result-count" role="status"
          >共 {{ total }} 条申请</span
        >
      </div>
    </a-card>

    <a-alert
      v-if="status === 'error'"
      type="error"
      show-icon
      :message="error"
      description="列表请求没有成功，当前页面没有任何申请数据；这不代表没有人提交过申请。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="status === 'forbidden'"
      status="403"
      title="无权限查看收付款申请"
      :sub-title="error"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="status === 'loading' && rows.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载收付款申请…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="[
            { title: '类型', dataIndex: 'kind', key: 'kind', width: 80 },
            { title: '订单号', dataIndex: 'orderNumber', key: 'orderNumber', width: 170 },
            { title: '客户', dataIndex: 'customerName', key: 'customerName', width: 130 },
            { title: '项目', dataIndex: 'lineName', key: 'lineName' },
            {
              title: '金额',
              dataIndex: 'amount',
              key: 'amount',
              width: 130,
              align: 'right',
              sorter: true,
              sortOrder: rowSortOrder('amount'),
            },
            { title: '方式', dataIndex: 'method', key: 'method', width: 100 },
            {
              title: '发生日期',
              dataIndex: 'occurredOn',
              key: 'occurredOn',
              width: 130,
              sorter: true,
              sortOrder: rowSortOrder('occurredOn'),
            },
            { title: '状态', dataIndex: 'status', key: 'status', width: 150 },
            { title: '提交', dataIndex: 'createdAt', key: 'createdAt', width: 150 },
            { title: '操作', key: 'actions', width: 150 },
          ]"
          :data-source="rows"
          :loading="status === 'loading' && rows.length > 0"
          :pagination="false"
          :scroll="{ x: 1500 }"
          :locale="{ emptyText }"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'kind'">
              {{ APPLICATION_KIND_LABELS[record.kind] }}
            </template>
            <template v-else-if="column.key === 'orderNumber'">
              <RouterLink
                class="order-link"
                :to="`/orders?keyword=${encodeURIComponent(record.orderNumber)}`"
              >
                {{ record.orderNumber }}
              </RouterLink>
            </template>
            <template v-else-if="column.key === 'amount'">
              {{ formatMoney(record.amount) }}
            </template>
            <template v-else-if="column.key === 'method'">
              {{ PAYMENT_METHOD_LABELS[record.method] }}
            </template>
            <template v-else-if="column.key === 'status'">
              <a-space direction="vertical" :size="2">
                <a-tag :color="APPLICATION_STATUS_TAG_COLORS[record.status]">
                  {{ APPLICATION_STATUS_LABELS[record.status] }}
                </a-tag>
                <span class="stage-hint">{{ applicationStageLabel(record) }}</span>
              </a-space>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              <a-space direction="vertical" :size="2">
                <span>{{ applicantLabel(record, currentUserId) }}</span>
                <span class="stage-hint">{{ formatDateTime(record.createdAt) }}</span>
              </a-space>
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-space wrap :size="4">
                <a-button
                  v-if="decideRow(record)"
                  type="link"
                  size="small"
                  @click="openDictation('approve', record)"
                >
                  通过
                </a-button>
                <a-button
                  v-if="decideRow(record)"
                  type="link"
                  size="small"
                  danger
                  @click="openDictation('reject', record)"
                >
                  驳回
                </a-button>
                <a-button
                  v-if="withdrawRow(record)"
                  type="link"
                  size="small"
                  @click="openDictation('withdraw', record)"
                >
                  撤回
                </a-button>
                <a-button
                  v-if="undoRow(record)"
                  type="link"
                  size="small"
                  @click="openDictation('undo', record)"
                >
                  撤销终审
                </a-button>
                <span
                  v-if="!decideRow(record) && !withdrawRow(record) && !undoRow(record)"
                  class="stage-hint"
                  >—</span
                >
              </a-space>
            </template>
          </template>
        </a-table>
        <a-pagination
          v-if="total > 0"
          class="pagination"
          :current="filters.page"
          :page-size="filters.pageSize"
          :total="total"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          show-size-changer
          show-quick-jumper
          @change="onPageChange"
        />
      </template>
    </a-card>

    <a-modal
      :open="dictation.mode !== null"
      :title="dictationTitle"
      :confirm-loading="dictation.submitting"
      :ok-text="dictation.mode === 'approve' ? '通过' : '确认'"
      cancel-text="取消"
      destroy-on-close
      @ok="submitDictation"
      @cancel="closeDictation"
    >
      <a-alert
        v-if="dictation.target"
        class="modal-hint"
        type="info"
        show-icon
        :message="`${dictation.target.orderNumber} · ${dictation.target.lineName} · ${formatMoney(dictation.target.amount)}`"
        :description="dictationHint"
      />
      <a-textarea
        v-model:value="dictation.text"
        :rows="3"
        :maxlength="500"
        show-count
        :placeholder="textRequired ? '请填写原因（必填）' : '审批意见（可选）'"
      />
      <a-alert
        v-if="dictation.error"
        class="modal-error"
        type="error"
        show-icon
        :message="dictation.error"
      />
    </a-modal>
  </section>
</template>

<style scoped>
.applications-page {
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
  width: 280px;
}

.filter-select {
  width: 150px;
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

.stage-hint {
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

.modal-hint {
  margin-bottom: var(--space-12);
}

.modal-error {
  margin-top: var(--space-12);
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}
</style>
