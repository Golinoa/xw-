<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type {
  TenantCommand,
  TenantCommandListQuery,
  TenantCommandStatus,
  TenantCommandType,
} from '#/api/ops/tenant/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  COMMAND_STATUS_OPTIONS,
  COMMAND_TYPE_OPTIONS,
  commandStatusView,
  commandTypeLabel,
  describeTenantError,
  errorCategoryView,
  fetchCommands,
  formatDateTime,
  shortId,
} from '#/api/ops/tenant';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import CommandDetailDrawer from './components/command-detail-drawer.vue';

defineOptions({ name: 'TenantCommands' });

/**
 * 命令与尝试记录总览（契约 §5.7 `GET /tenant-commands`）。
 *
 * 为什么单独一页：交付事故复盘需要「跨映射」看失败命令（哪个租户、什么类别、
 * 重试了几次），映射详情里的 20 条只是局部视图。
 */
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.TENANT_READ));

const rows = ref<TenantCommand[]>([]);
const loading = ref(false);
const loadError = shallowRef<null | TenantErrorView>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  commandType: undefined as TenantCommandType | undefined,
  mappingId: '',
  status: [] as TenantCommandStatus[],
});
const createdFrom = ref<Dayjs>();
const createdTo = ref<Dayjs>();

const columns: TableColumnsType = [
  { dataIndex: 'commandNo', key: 'commandNo', title: '命令编号', width: 170 },
  { dataIndex: 'mappingId', key: 'mappingId', title: '映射', width: 140 },
  { dataIndex: 'commandType', key: 'commandType', title: '类型', width: 120 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 110 },
  {
    dataIndex: 'attemptCount',
    key: 'attemptCount',
    title: '尝试次数',
    width: 96,
  },
  {
    dataIndex: 'lastErrorCategory',
    key: 'lastErrorCategory',
    title: '错误类别',
    width: 120,
  },
  {
    dataIndex: 'nextRetryAt',
    key: 'nextRetryAt',
    title: '下次重试',
    width: 150,
  },
  { dataIndex: 'createdAt', key: 'createdAt', title: '创建时间', width: 150 },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): TenantCommandListQuery {
  return {
    commandType: filters.commandType,
    createdFrom: createdFrom.value?.format('YYYY-MM-DD'),
    createdTo: createdTo.value?.format('YYYY-MM-DD'),
    mappingId: filters.mappingId.trim() || undefined,
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    status: filters.status.length > 0 ? filters.status : undefined,
  };
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchCommands(buildQuery());
    rows.value = result.items;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    pagination.total = 0;
    loadError.value = describeTenantError(error);
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  pagination.page = 1;
  void load();
}

function onReset() {
  filters.commandType = undefined;
  filters.mappingId = '';
  filters.status = [];
  createdFrom.value = undefined;
  createdTo.value = undefined;
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig) {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

const detailOpen = ref(false);
const activeCommandId = ref<null | string>(null);

function openDetail(row: TenantCommand) {
  activeCommandId.value = row.id;
  detailOpen.value = true;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="tenant-command-permission-denied"
      description="当前账号缺少 tenant.read 动作码。为避免泄漏租户引用与命令载荷，本页不展示任何命令或尝试记录。"
      message="无查看租户命令权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">映射 ID</div>
            <Input
              v-model:value="filters.mappingId"
              allow-clear
              placeholder="按映射 ID 精确筛选"
              style="width: 240px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="COMMAND_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 220px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">命令类型</div>
            <Select
              v-model:value="filters.commandType"
              :options="COMMAND_TYPE_OPTIONS"
              allow-clear
              placeholder="全部类型"
              style="width: 150px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">创建时间</div>
            <Space>
              <DatePicker v-model:value="createdFrom" placeholder="起" />
              <DatePicker v-model:value="createdTo" placeholder="止" />
            </Space>
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
        </div>
      </Card>

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="tenant-command-list-error"
          :message="loadError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ loadError.description }}</p>
              <p v-if="loadError.requestId" class="text-xs">
                请求 ID：<span class="font-mono">{{
                  loadError.requestId
                }}</span>
              </p>
              <Button size="small" @click="load">重试</Button>
            </div>
          </template>
        </Alert>

        <Table
          :columns="columns"
          :data-source="rows"
          :loading="loading"
          :pagination="{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
          }"
          :row-key="(row: TenantCommand) => row.id"
          :scroll="{ x: 1200 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'mappingId'">
              <span class="font-mono text-xs">{{
                shortId(record.mappingId)
              }}</span>
            </template>
            <template v-else-if="column.key === 'commandType'">
              {{ commandTypeLabel(record.commandType) }}
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="commandStatusView(record.status).color">
                {{ commandStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'lastErrorCategory'">
              {{
                record.lastErrorCategory
                  ? errorCategoryView(record.lastErrorCategory).label
                  : '—'
              }}
            </template>
            <template v-else-if="column.key === 'nextRetryAt'">
              {{ formatDateTime(record.nextRetryAt) }}
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as TenantCommand)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有命令记录" />
          </template>
        </Table>
      </Card>
    </template>

    <CommandDetailDrawer
      v-model:open="detailOpen"
      :command-id="activeCommandId"
      @changed="load"
    />
  </div>
</template>
