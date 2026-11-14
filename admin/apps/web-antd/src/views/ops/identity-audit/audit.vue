<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

/**
 * 审计日志（identity-audit 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied。
 *
 * 四条约束：
 * 1. **只读**：没有任何写入口——审计只由后端在动作发生时落库（契约 §3.9 仅 INSERT）。
 * 2. **筛选与分页全部走服务端**：契约 §5.9 的 `/audit-events` 支持
 *    `actorOperatorId`/`action`/`entityType`/`entityId`/`requestId`/`from`/`to`，
 *    不在浏览器里拉全量再过滤。
 * 3. **时间范围转 ISO**：`from`/`to` 是时间戳（契约 §2.3），日期控件取当天 00:00 / 23:59:59。
 * 4. **未登记动作原样显示**：`action` 是开放词表，后端新增动作不该让页面出现空白行。
 */
import type { AuditEventListQuery, OpsAuditEvent } from '#/api/ops/identity';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  Button,
  Card,
  DatePicker,
  Input,
  message,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  auditActionLabel,
  describeIdentityError,
  fetchAuditEvents,
  formatDateTime,
  isKnownAuditAction,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
} from '#/api/ops/identity';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import AuditDetailDrawer from './components/audit-detail-drawer.vue';

defineOptions({ name: 'AuditEvents' });

const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.AUDIT_READ));

const PAGE_SIZE_OPTIONS = OPS_PAGE_SIZE_OPTIONS.map(String);

const filters = reactive<{
  action: string;
  actorOperatorId: string;
  createdRange: [Dayjs, Dayjs] | undefined;
  entityId: string;
  entityType: string;
  requestId: string;
}>({
  action: '',
  actorOperatorId: '',
  createdRange: undefined,
  entityId: '',
  entityType: '',
  requestId: '',
});

const query = reactive<{ page: number; pageSize: number }>({
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
});

const items = ref<OpsAuditEvent[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | ReturnType<typeof describeIdentityError>>(null);

const selected = ref<null | OpsAuditEvent>(null);
const drawerOpen = ref(false);

const columns = [
  { dataIndex: 'createdAt', key: 'createdAt', title: '时间', width: 170 },
  { dataIndex: 'action', key: 'action', title: '动作', width: 200 },
  { dataIndex: 'actor', key: 'actor', title: '操作者', width: 200 },
  { dataIndex: 'entity', key: 'entity', title: '对象', width: 200 },
  { dataIndex: 'reason', key: 'reason', title: '原因', width: 240 },
  { dataIndex: 'requestId', key: 'requestId', title: '请求 ID', width: 180 },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): AuditEventListQuery {
  const next: AuditEventListQuery = {
    page: query.page,
    pageSize: query.pageSize,
  };
  if (filters.action.trim() !== '') {
    next.action = filters.action.trim();
  }
  if (filters.actorOperatorId.trim() !== '') {
    next.actorOperatorId = filters.actorOperatorId.trim();
  }
  if (filters.entityType.trim() !== '') {
    next.entityType = filters.entityType.trim();
  }
  if (filters.entityId.trim() !== '') {
    next.entityId = filters.entityId.trim();
  }
  if (filters.requestId.trim() !== '') {
    next.requestId = filters.requestId.trim();
  }
  if (filters.createdRange) {
    next.from = filters.createdRange[0].startOf('day').toISOString();
    next.to = filters.createdRange[1].endOf('day').toISOString();
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
    const result = await fetchAuditEvents(buildQuery());
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    error.value = describeIdentityError(error_);
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
  filters.action = '';
  filters.actorOperatorId = '';
  filters.createdRange = undefined;
  filters.entityId = '';
  filters.entityType = '';
  filters.requestId = '';
  reloadFirstPage();
}

function asEvent(record: Record<string, unknown>): OpsAuditEvent {
  return record as unknown as OpsAuditEvent;
}

function openDetail(event: OpsAuditEvent) {
  selected.value = event;
  drawerOpen.value = true;
}

async function copyRequestId(requestId: null | string) {
  if (!requestId) {
    return;
  }
  try {
    await navigator.clipboard.writeText(requestId);
    message.success('请求 ID 已复制');
  } catch {
    message.warning('浏览器不允许访问剪贴板，请手动选中复制');
  }
}

interface TablePagerEvent {
  current?: number;
  pageSize?: number;
}

function handleTableChange(...args: unknown[]) {
  const [pager] = args as [TablePagerEvent | undefined];
  query.page = pager?.current ?? 1;
  query.pageSize = pager?.pageSize ?? OPS_DEFAULT_PAGE_SIZE;
  void load();
}

const pagination = computed(() => ({
  current: query.page,
  pageSize: query.pageSize,
  pageSizeOptions: PAGE_SIZE_OPTIONS,
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 条（服务端分页）`,
  total: total.value,
}));

onMounted(() => {
  if (canRead.value) {
    void load();
  }
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.AUDIT_READ]"
      title="审计日志"
    />

    <Card v-else title="审计日志">
      <template #extra>
        <span class="text-xs text-muted-foreground">
          只读事实 · 仅追加 · 固定按时间倒序
        </span>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input
          v-model:value="filters.action"
          allow-clear
          class="w-52"
          placeholder="动作，如 export.create"
          @press-enter="reloadFirstPage"
        />
        <Input
          v-model:value="filters.entityType"
          allow-clear
          class="w-40"
          placeholder="对象类型，如 role"
          @press-enter="reloadFirstPage"
        />
        <Input
          v-model:value="filters.entityId"
          allow-clear
          class="w-56"
          placeholder="对象 ID"
          @press-enter="reloadFirstPage"
        />
        <Input
          v-model:value="filters.actorOperatorId"
          allow-clear
          class="w-56"
          placeholder="操作者 ID"
          @press-enter="reloadFirstPage"
        />
        <Input
          v-model:value="filters.requestId"
          allow-clear
          class="w-56"
          placeholder="请求 ID"
          @press-enter="reloadFirstPage"
        />
        <DatePicker.RangePicker
          v-model:value="filters.createdRange"
          :placeholder="['时间起', '时间止']"
          @change="reloadFirstPage"
        />
        <Button @click="reloadFirstPage">查询</Button>
        <Button type="text" @click="resetFilters">重置</Button>
      </div>

      <OpsErrorAlert
        v-if="error"
        :message="error.description"
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
        :scroll="{ x: 1300 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <div>{{ auditActionLabel(record.action) }}</div>
            <div class="font-mono text-xs text-muted-foreground">
              {{ record.action }}
            </div>
            <Tag v-if="!isKnownAuditAction(record.action)" color="orange">
              未登记动作
            </Tag>
          </template>
          <template v-else-if="column.key === 'actor'">
            <div>{{ record.actor?.displayName ?? '—' }}</div>
            <div class="font-mono text-xs text-muted-foreground">
              {{ record.actor?.id }}
            </div>
          </template>
          <template v-else-if="column.key === 'entity'">
            <div class="font-mono text-xs">{{ record.entityType }}</div>
            <div class="font-mono text-xs text-muted-foreground">
              {{ record.entityId || '—' }}
            </div>
          </template>
          <template v-else-if="column.key === 'reason'">
            <Tooltip :title="record.reason || ''">
              <span class="line-clamp-2 text-sm">
                {{ record.reason || '未填写' }}
              </span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'requestId'">
            <span class="font-mono text-xs">{{ record.requestId || '—' }}</span>
            <Button
              v-if="record.requestId"
              class="px-0"
              size="small"
              type="link"
              @click="copyRequestId(record.requestId)"
            >
              复制
            </Button>
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              size="small"
              type="link"
              @click="openDetail(asEvent(record))"
            >
              详情
            </Button>
          </template>
        </template>

        <template #emptyText>
          <div class="py-8 text-center">
            <p class="text-sm text-muted-foreground">
              没有符合条件的审计事件。
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              审计只记录真实发生过的动作：没有记录通常表示这段时间没有符合条件的操作，
              而不是「查询失败」。
            </p>
          </div>
        </template>
      </Table>

      <p class="mt-3 text-xs text-muted-foreground">
        审计事件由后端在动作发生的同一事务内写入（契约
        §3.9），前端没有任何写入端点； 记录一旦写入不可修改、不可删除。
      </p>
    </Card>

    <AuditDetailDrawer
      :event="selected"
      :open="drawerOpen"
      @close="drawerOpen = false"
    />
  </div>
</template>
