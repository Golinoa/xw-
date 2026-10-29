<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  EntitlementStatus,
  License,
  LicenseListQuery,
  LicenseMode,
} from '#/api/ops/entitlement/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Select,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  describeEntitlementError,
  ENTITLEMENT_STATUS_OPTIONS,
  entitlementStatusView,
  fetchLicenses,
  formatDate,
  LICENSE_MODE_OPTIONS,
  licenseModeLabel,
  licenseModeView,
  maintenanceNote,
  snapshotSummaryText,
} from '#/api/ops/entitlement';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import EntitlementDetailDrawer from './components/entitlement-detail-drawer.vue';
import LicenseCreateModal from './components/license-create-modal.vue';

defineOptions({ name: 'EntitlementLicenses' });

/**
 * 私有授权列表。
 *
 * 与订阅列表同构，额外强调两件事：
 * 1. `license_mode`（term / perpetual）必须可见；
 * 2. **永久授权 ≠ 永久更新**：`maintenanceUntil` 单独展示，绝不从授权方式推导。
 */
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.ENTITLEMENT_READ));
const canRequest = computed(() =>
  hasPermission(OPS_PERMISSION.ENTITLEMENT_REQUEST),
);

const rows = ref<License[]>([]);
const loading = ref(false);
const loadError = shallowRef<EntitlementErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  customerId: '',
  deploymentInstanceId: '',
  licenseMode: undefined as LicenseMode | undefined,
  status: [] as EntitlementStatus[],
});
const endsRange = ref<[Dayjs, Dayjs] | undefined>();

const columns: TableColumnsType = [
  { dataIndex: 'licenseNo', key: 'licenseNo', title: '授权号', width: 170 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 210 },
  {
    dataIndex: 'licenseMode',
    key: 'licenseMode',
    title: '授权方式',
    width: 110,
  },
  { dataIndex: 'valid', key: 'valid', title: '授权有效期', width: 210 },
  { dataIndex: 'maintenance', key: 'maintenance', title: '维护期', width: 240 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 110 },
  { dataIndex: 'snapshot', key: 'snapshot', title: '当前权益快照', width: 300 },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): LicenseListQuery {
  return {
    customerId: filters.customerId.trim() || undefined,
    deploymentInstanceId: filters.deploymentInstanceId.trim() || undefined,
    endsFrom: endsRange.value?.[0]?.format('YYYY-MM-DD'),
    endsTo: endsRange.value?.[1]?.format('YYYY-MM-DD'),
    licenseMode: filters.licenseMode,
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    sort: 'validFrom',
    status: filters.status.length > 0 ? filters.status : undefined,
  };
}

async function load(): Promise<void> {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchLicenses(buildQuery());
    rows.value = result.items;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    pagination.total = 0;
    loadError.value = describeEntitlementError(error);
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  pagination.page = 1;
  void load();
}

function onReset(): void {
  filters.customerId = '';
  filters.deploymentInstanceId = '';
  filters.licenseMode = undefined;
  filters.status = [];
  endsRange.value = undefined;
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig): void {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

const detailOpen = ref(false);
const activeId = ref<null | string>(null);

function openDetail(row: License): void {
  activeId.value = row.id;
  detailOpen.value = true;
}

const createOpen = ref(false);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="entitlement-permission-denied"
      description="当前账号缺少 entitlement.read 动作码。按最小可见原则，本页不展示任何私有授权、维护期或权益明细。如需开通请联系运营管理员。"
      message="无查看权益权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Alert
        class="mb-3"
        message="永久授权（perpetual）只表示软件使用无到期日，不代表包含永久更新；版本更新与技术支持以维护期为准，两者在列表中分开显示。"
        show-icon
        type="info"
      />

      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="filters.customerId"
              allow-clear
              placeholder="按客户 ID 精确筛选"
              style="width: 180px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">部署实例 ID</div>
            <Input
              v-model:value="filters.deploymentInstanceId"
              allow-clear
              placeholder="按部署实例筛选"
              style="width: 180px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">授权方式</div>
            <Select
              v-model:value="filters.licenseMode"
              :options="LICENSE_MODE_OPTIONS"
              allow-clear
              placeholder="全部方式"
              style="width: 140px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="ENTITLEMENT_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 210px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">到期区间</div>
            <DatePicker.RangePicker v-model:value="endsRange" />
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
          <div class="ml-auto">
            <Tooltip
              v-if="!canRequest"
              title="缺少 entitlement.request，不能创建授权草稿"
            >
              <span>
                <Button disabled>创建授权草稿</Button>
              </span>
            </Tooltip>
            <Button v-else ghost type="primary" @click="createOpen = true">
              创建授权草稿
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="entitlement-list-error"
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
          :row-key="(row: License) => row.id"
          :scroll="{ x: 1400 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'licenseMode'">
              <Tag :color="licenseModeView(record.licenseMode).color">
                {{ licenseModeLabel(record.licenseMode) }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'valid'">
              {{ formatDate(record.validFrom) }} ~
              {{
                record.validTo ? formatDate(record.validTo) : '永久（无到期日）'
              }}
            </template>
            <template v-else-if="column.key === 'maintenance'">
              <div class="text-xs">
                {{ maintenanceNote(record as License) }}
              </div>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="entitlementStatusView(record.status).color">
                {{ entitlementStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'snapshot'">
              <div class="text-xs text-muted-foreground">
                {{ snapshotSummaryText(record.snapshotSummary) }}
              </div>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as License)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有授权记录" />
          </template>
        </Table>
      </Card>
    </template>

    <EntitlementDetailDrawer
      v-model:open="detailOpen"
      :subject-id="activeId"
      subject-type="license"
      @changed="load"
    />

    <LicenseCreateModal v-model:open="createOpen" @created="load" />
  </div>
</template>
