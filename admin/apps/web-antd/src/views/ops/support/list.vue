<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { OpsApiError } from '#/api/adapter/errors';
import type {
  CreateTicketInput,
  TicketErrorView,
  TicketListItem,
  TicketListQuery,
  TicketPriority,
  TicketStatus,
} from '#/api/ops/support';

/**
 * 售后工单列表（support 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / conflict / destructive-confirm
 * （conflict 与 destructive-confirm 发生在详情页；本页负责读取、筛选与建单）。
 *
 * 两条硬约束：
 * 1. **逾期只读服务端字段**：`isOverdue` 缺失时显示「逾期标识未返回」，本地不比较
 *    `dueAt` 与当前时间（源码参考门 §4.2）。筛选「只看逾期」走服务端 `overdueOnly`。
 * 2. 筛选/分页/排序全部走服务端参数，不下载全量再前端过滤。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  message,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createTicket,
  describeTicketError,
  fetchTickets,
  formatDateTime,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
  OVERDUE_SOURCE_NOTE,
  TICKET_PRIORITY_OPTIONS,
  TICKET_STATUS_OPTIONS,
  ticketPriorityView,
  ticketStatusView,
} from '#/api/ops/support';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';
import { useCurrentOperator } from '#/views/ops/entitlement/composables/use-current-operator';

import TicketCreateModal from './components/ticket-create-modal.vue';
import TicketOverdueBadge from './components/ticket-overdue-badge.vue';
import { useCustomerOptions } from './composables/use-customer-options';

defineOptions({ name: 'SupportTicketList' });

const PAGE_SIZE_OPTIONS = OPS_PAGE_SIZE_OPTIONS.map(String);

const router = useRouter();
const { hasPermission } = useOpsPermission();
const { currentOperatorId } = useCurrentOperator();
const {
  ensureLoaded: ensureCustomerOptions,
  loading: customerLoading,
  options: customerOptionList,
  search: searchCustomer,
} = useCustomerOptions();

const canRead = computed(() => hasPermission(OPS_PERMISSION.TICKET_READ));
const canCreate = computed(() => hasPermission(OPS_PERMISSION.TICKET_CREATE));

type AssigneeMode = 'all' | 'mine' | 'unassigned';

/** 日期控件用 dayjs 值，提交时统一转 ISO（契约 §2.3：时间戳为 UTC ISO 8601）。 */
const filters = reactive<{
  assigneeMode: AssigneeMode;
  createdRange: [Dayjs, Dayjs] | undefined;
  customerId: string | undefined;
  overdueOnly: boolean;
  priority: TicketPriority[];
  status: TicketStatus[];
  updatedFrom: Dayjs | undefined;
}>({
  assigneeMode: 'all',
  createdRange: undefined,
  customerId: undefined,
  overdueOnly: false,
  priority: [],
  status: [],
  updatedFrom: undefined,
});

const query = reactive<TicketListQuery>({
  order: 'desc',
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
  sort: 'updatedAt',
});

const items = ref<TicketListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

/** 把界面筛选项翻译成契约 §5.8 的服务端参数（推导项显式标注）。 */
function buildQuery(): TicketListQuery {
  const next: TicketListQuery = {
    order: query.order,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
  };
  if (filters.overdueOnly) {
    next.overdueOnly = true;
  }
  if (filters.priority.length > 0) {
    next.priority = [...filters.priority];
  }
  if (filters.status.length > 0) {
    next.status = [...filters.status];
  }
  if (filters.customerId) {
    next.customerId = filters.customerId;
  }
  if (filters.assigneeMode === 'mine' && currentOperatorId.value) {
    next.assigneeOperatorId = currentOperatorId.value;
  }
  if (filters.assigneeMode === 'unassigned') {
    // 契约推导 U-07：§5.8 未列 `unassigned`，后端确认前可能被忽略。
    next.unassigned = true;
  }
  if (filters.updatedFrom) {
    next.updatedFrom = filters.updatedFrom.startOf('day').toISOString();
  }
  if (filters.createdRange) {
    // 契约推导 U-07：§5.8 只列了 `updatedFrom`，创建时间区间为本页补齐。
    next.createdFrom = filters.createdRange[0].startOf('day').toISOString();
    next.createdTo = filters.createdRange[1].endOf('day').toISOString();
  }
  return next;
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchTickets(buildQuery());
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    error.value = toOpsApiError(error_);
    items.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function reloadFirstPage() {
  query.page = 1;
  void load();
}

function resetFilters() {
  filters.assigneeMode = 'all';
  filters.createdRange = undefined;
  filters.customerId = undefined;
  filters.overdueOnly = false;
  filters.priority = [];
  filters.status = [];
  filters.updatedFrom = undefined;
  reloadFirstPage();
}

const mineDisabled = computed(() => currentOperatorId.value === null);

const assigneeOptions = computed(() => [
  { label: '全部工单', value: 'all' },
  { disabled: mineDisabled.value, label: '分派给我', value: 'mine' },
  { label: '未分派', value: 'unassigned' },
]);

const columns = [
  { dataIndex: 'ticketNo', key: 'ticketNo', title: '工单号', width: 160 },
  { dataIndex: 'subject', key: 'subject', title: '主题', width: 280 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 200 },
  { dataIndex: 'priority', key: 'priority', title: '优先级', width: 100 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 110 },
  { dataIndex: 'assignee', key: 'assignee', title: '指派人', width: 150 },
  { dataIndex: 'dueAt', key: 'dueAt', title: '到期 / 逾期', width: 170 },
  {
    dataIndex: 'updatedAt',
    key: 'updatedAt',
    sorter: true,
    title: '更新时间',
    width: 170,
  },
  { key: 'actions', title: '操作', width: 90 },
];

/** antd `#bodyCell` 的 `record` 是第三方边界的宽松类型，这里收敛为行类型。 */
function asTicket(record: Record<string, unknown>): TicketListItem {
  return record as unknown as TicketListItem;
}

interface TablePagerEvent {
  current?: number;
  pageSize?: number;
}
interface TableSorterEvent {
  field?: string | string[];
  order?: 'ascend' | 'descend' | null;
}

function handleTableChange(...args: unknown[]) {
  const [pager, , sorter] = args as [
    TablePagerEvent | undefined,
    unknown,
    TableSorterEvent | undefined,
  ];
  query.page = pager?.current ?? 1;
  query.pageSize = pager?.pageSize ?? OPS_DEFAULT_PAGE_SIZE;
  const field = Array.isArray(sorter?.field) ? sorter?.field[0] : sorter?.field;
  if (field === 'updatedAt' || field === 'createdAt' || field === 'priority') {
    query.sort = field;
    query.order = sorter?.order === 'ascend' ? 'asc' : 'desc';
  }
  void load();
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? OPS_DEFAULT_PAGE_SIZE,
  pageSizeOptions: PAGE_SIZE_OPTIONS,
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 条（服务端分页）`,
  total: total.value,
}));

function openDetail(ticketId: string) {
  void router.push({ name: 'SupportTicketDetail', params: { ticketId } });
}

/* ---------------- 新建工单 ---------------- */

const createState = reactive<{
  error: null | TicketErrorView;
  open: boolean;
  submitting: boolean;
}>({ error: null, open: false, submitting: false });

function openCreate() {
  createState.error = null;
  createState.open = true;
}

async function submitCreate(payload: CreateTicketInput) {
  createState.submitting = true;
  createState.error = null;
  try {
    const result = await createTicket(payload);
    createState.open = false;
    message.success(`工单已创建：${result.ticket.ticketNo}（状态：待受理）`);
    reloadFirstPage();
    openDetail(result.ticket.id);
  } catch (error_) {
    // 400（引用不属于该客户）/ 403 / 409 都保留用户已填内容，只展示错误。
    createState.error = describeTicketError(error_);
  } finally {
    createState.submitting = false;
  }
}

onMounted(() => {
  void load();
  void ensureCustomerOptions();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.TICKET_READ]"
      title="售后工单"
    />

    <Card v-else title="售后工单">
      <template #extra>
        <Space>
          <span class="text-xs text-muted-foreground">
            逾期标识来自服务端字段
          </span>
          <Button v-if="canCreate" type="primary" @click="openCreate">
            新建工单
          </Button>
        </Space>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Select
          v-model:value="filters.status"
          class="min-w-48"
          mode="multiple"
          option-filter-prop="label"
          placeholder="状态"
          :options="TICKET_STATUS_OPTIONS"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="filters.priority"
          class="min-w-40"
          mode="multiple"
          option-filter-prop="label"
          placeholder="优先级"
          :options="TICKET_PRIORITY_OPTIONS"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="filters.assigneeMode"
          class="w-40"
          :options="assigneeOptions"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="filters.customerId"
          allow-clear
          class="min-w-56"
          :filter-option="false"
          :loading="customerLoading"
          :options="customerOptionList"
          placeholder="按客户筛选"
          show-search
          @change="reloadFirstPage"
          @search="searchCustomer"
        />
        <DatePicker
          v-model:value="filters.updatedFrom"
          placeholder="更新时间起"
          @change="reloadFirstPage"
        />
        <DatePicker.RangePicker
          v-model:value="filters.createdRange"
          :placeholder="['创建时间起', '创建时间止']"
          @change="reloadFirstPage"
        />
        <Checkbox
          v-model:checked="filters.overdueOnly"
          @change="reloadFirstPage"
        >
          只看逾期（服务端判定）
        </Checkbox>
        <Button @click="reloadFirstPage">查询</Button>
        <Button type="text" @click="resetFilters">重置</Button>
      </div>

      <Alert
        v-if="mineDisabled"
        class="mb-3"
        message="未能确认当前操作人身份，「分派给我」不可用"
        show-icon
        type="info"
      />

      <OpsErrorAlert
        v-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Table
        row-key="id"
        size="middle"
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="pagination"
        :scroll="{ x: 1400 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ticketNo'">
            <span class="font-mono text-xs">{{ record.ticketNo }}</span>
          </template>
          <template v-else-if="column.key === 'subject'">
            <a class="font-medium" @click="openDetail(asTicket(record).id)">
              {{ record.subject }}
            </a>
          </template>
          <template v-else-if="column.key === 'customer'">
            <div class="text-sm">{{ record.customer?.name ?? '—' }}</div>
            <div class="text-xs text-muted-foreground">
              {{ record.customer?.customerNo ?? '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'priority'">
            <Tag :color="ticketPriorityView(record.priority).color">
              {{ ticketPriorityView(record.priority).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="ticketStatusView(record.status).color">
              {{ ticketStatusView(record.status).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'assignee'">
            <span v-if="record.assignee" class="text-sm">
              {{ record.assignee.displayName ?? record.assignee.id }}
            </span>
            <Tag v-else color="orange">未分派</Tag>
          </template>
          <template v-else-if="column.key === 'dueAt'">
            <TicketOverdueBadge :ticket="asTicket(record)" show-due-at />
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            {{ formatDateTime(record.updatedAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              size="small"
              type="link"
              @click="openDetail(asTicket(record).id)"
            >
              详情
            </Button>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center">
            <p class="text-sm text-muted-foreground">没有符合条件的工单。</p>
            <p class="mt-1 text-xs text-muted-foreground">
              工单从受理开始留痕：分派、状态变更、备注都会追加到不可覆盖的时间线。
            </p>
          </div>
        </template>
      </Table>

      <p class="mt-3 text-xs text-muted-foreground">
        {{ OVERDUE_SOURCE_NOTE }}
      </p>
    </Card>

    <TicketCreateModal
      :error="createState.error"
      :open="createState.open"
      :submitting="createState.submitting"
      @cancel="createState.open = false"
      @submit="submitCreate"
    />
  </div>
</template>
