<script lang="ts" setup>
/**
 * 导出任务（identity-audit 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / pending（排队/生成中）/ expired。
 *
 * 三条硬约束：
 * 1. **异步语义**：`POST /exports` 只返回 `status='queued'`（契约 §5.9 202）。
 *    提交成功后提示「已排队」，绝不提示「导出完成」。
 * 2. **下载链接现取现用**：签名 URL 有效期 ≤ 5 分钟，列表项没有该字段。
 *    点击下载时才去取详情，且不缓存 URL。
 * 3. **自动刷新可关、可停**：轮询只在有「排队中/生成中」任务时进行，
 *    全部完成或页面卸载立即停止——不留下一个永不停止的定时器。
 */
import type {
  CreateExportPayload,
  IdentityErrorView,
  OpsExportStatus,
  OpsExportTask,
  OpsExportType,
} from '#/api/ops/identity';

import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Card,
  message,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  actorLabel,
  createExport,
  createIdempotencyKey,
  describeIdentityError,
  EXPORT_STATUS_OPTIONS,
  EXPORT_TYPE_OPTIONS,
  exportStatusView,
  exportTypeView,
  fetchExportTask,
  fetchExportTasks,
  formatDateTime,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
} from '#/api/ops/identity';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import ExportCreateModal from './components/export-create-modal.vue';

defineOptions({ name: 'AuditExports' });

const POLL_INTERVAL_MS = 10_000;
const PAGE_SIZE_OPTIONS = OPS_PAGE_SIZE_OPTIONS.map(String);

const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.EXPORT_READ));
const canCreate = computed(() => hasPermission(OPS_PERMISSION.EXPORT_CREATE));

const filters = reactive<{
  exportType: OpsExportType | undefined;
  status: OpsExportStatus[];
}>({ exportType: undefined, status: [] });

const query = reactive<{
  page: number;
  pageSize: number;
}>({ page: 1, pageSize: OPS_DEFAULT_PAGE_SIZE });

const items = ref<OpsExportTask[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<IdentityErrorView | null>(null);
const downloadingId = ref<null | string>(null);

const columns = [
  { dataIndex: 'exportNo', key: 'exportNo', title: '任务号', width: 160 },
  { dataIndex: 'exportType', key: 'exportType', title: '对象', width: 110 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 120 },
  { dataIndex: 'rowCount', key: 'rowCount', title: '行数', width: 100 },
  { dataIndex: 'requestedBy', key: 'requestedBy', title: '发起人', width: 180 },
  { dataIndex: 'createdAt', key: 'createdAt', title: '创建时间', width: 170 },
  { dataIndex: 'expiresAt', key: 'expiresAt', title: '产物过期', width: 170 },
  { key: 'actions', title: '操作', width: 160 },
];

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchExportTasks({
      exportType: filters.exportType,
      page: query.page,
      pageSize: query.pageSize,
      status: filters.status,
    });
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
  filters.exportType = undefined;
  filters.status = [];
  reloadFirstPage();
}

const activeCount = computed(
  () =>
    items.value.filter(
      (task) => task.status === 'queued' || task.status === 'running',
    ).length,
);

/* ---------------------------- 自动刷新 ---------------------------- */

const autoRefresh = ref(false);
let timer: null | ReturnType<typeof setInterval> = null;

function stopPolling() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(() => {
    // 没有进行中的任务就不再轮询：状态只由后台推进，空转没有意义。
    if (activeCount.value === 0 && !loading.value) {
      autoRefresh.value = false;
      return;
    }
    void load();
  }, POLL_INTERVAL_MS);
}

watch(autoRefresh, (enabled) => {
  if (enabled) {
    startPolling();
  } else {
    stopPolling();
  }
});

/* ---------------------------- 创建导出 ---------------------------- */

const createState = reactive<{
  error: IdentityErrorView | null;
  open: boolean;
  submitting: boolean;
}>({ error: null, open: false, submitting: false });

/** 幂等键在打开弹窗时生成一次：连点两次不会排出两个任务。 */
let createKey = '';

function openCreate() {
  createKey = createIdempotencyKey();
  createState.error = null;
  createState.open = true;
}

async function submitCreate(payload: CreateExportPayload) {
  createState.submitting = true;
  createState.error = null;
  try {
    const result = await createExport(
      {
        exportType: payload.exportType,
        filters: payload.filters,
        reason: payload.reason,
      },
      createKey,
    );
    createState.open = false;
    // 只承诺「已排队」：真正的产出由后台任务完成。
    message.success(`导出任务已排队：${result.exportNo}（状态：排队中）`);
    await load();
    autoRefresh.value = true;
  } catch (error_) {
    createState.error = describeIdentityError(error_);
  } finally {
    createState.submitting = false;
  }
}

/* ---------------------------- 下载 ---------------------------- */

async function download(task: OpsExportTask) {
  if (task.status !== 'succeeded') {
    message.info('任务尚未完成，暂无下载地址');
    return;
  }
  downloadingId.value = task.id;
  try {
    // 现取：签名 URL 5 分钟过期，缓存它只会在用户点击时给一个失效链接。
    const detail = await fetchExportTask(task.id);
    if (!detail.downloadUrl) {
      message.warning('服务端未返回下载地址（可能已过期），请重新发起导出');
      return;
    }
    window.open(detail.downloadUrl, '_blank', 'noopener,noreferrer');
  } catch (error_) {
    const view = describeIdentityError(error_);
    error.value = view;
  } finally {
    downloadingId.value = null;
  }
}

function asTask(record: Record<string, unknown>): OpsExportTask {
  return record as unknown as OpsExportTask;
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
  void load();
});

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.EXPORT_READ]"
      title="导出任务"
    />

    <Card v-else title="导出任务">
      <template #extra>
        <Space>
          <span class="text-xs text-muted-foreground">
            异步任务 · 下载链接 5 分钟内有效
          </span>
          <Switch v-model:checked="autoRefresh" size="small" />
          <span class="text-xs text-muted-foreground">自动刷新（10 秒）</span>
          <Button :loading="loading" @click="load">刷新</Button>
          <Button v-if="canCreate" type="primary" @click="openCreate">
            发起导出
          </Button>
        </Space>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Select
          v-model:value="filters.exportType"
          allow-clear
          class="w-40"
          :options="EXPORT_TYPE_OPTIONS"
          placeholder="导出对象"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="filters.status"
          class="w-64"
          mode="multiple"
          :options="EXPORT_STATUS_OPTIONS"
          option-filter-prop="label"
          placeholder="状态"
          @change="reloadFirstPage"
        />
        <Button @click="reloadFirstPage">查询</Button>
        <Button type="text" @click="resetFilters">重置</Button>
      </div>

      <Alert
        v-if="activeCount > 0"
        class="mb-3"
        :message="`有 ${activeCount} 个任务正在排队或生成中`"
        description="状态由服务端后台任务推进，页面只做只读刷新；不要重复提交同一个导出（重复提交会产生独立任务）。"
        show-icon
        type="info"
      />

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
          <template v-if="column.key === 'exportNo'">
            <span class="font-mono text-xs">{{ record.exportNo }}</span>
          </template>
          <template v-else-if="column.key === 'exportType'">
            <Tag :color="exportTypeView(record.exportType).color">
              {{ exportTypeView(record.exportType).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="exportStatusView(record.status).color">
              {{ exportStatusView(record.status).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'rowCount'">
            {{ record.rowCount ?? '—' }}
          </template>
          <template v-else-if="column.key === 'requestedBy'">
            {{ actorLabel(record.requestedBy) }}
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'expiresAt'">
            {{ record.expiresAt ? formatDateTime(record.expiresAt) : '—' }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              :disabled="record.status !== 'succeeded'"
              :loading="downloadingId === record.id"
              size="small"
              type="link"
              @click="download(asTask(record))"
            >
              下载
            </Button>
            <Tag v-if="record.status === 'expired'" color="default">已过期</Tag>
          </template>
        </template>

        <template #emptyText>
          <div class="py-8 text-center">
            <p class="text-sm text-muted-foreground">还没有导出任务。</p>
            <p class="mt-1 text-xs text-muted-foreground">
              导出会把筛选条件、发起人与行数写入审计；产物到期后自动失效。
            </p>
          </div>
        </template>
      </Table>

      <p class="mt-3 text-xs text-muted-foreground">
        导出状态由后台任务推进（`queued` → `running` →
        `succeeded`/`failed`/`expired`）， 页面不推断进度、不估算剩余时间。
      </p>
    </Card>

    <ExportCreateModal
      :error="createState.error"
      :open="createState.open"
      :submitting="createState.submitting"
      @cancel="createState.open = false"
      @submit="submitCreate"
    />
  </div>
</template>
