<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';

import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type {
  TenantMapping,
  TenantMappingListQuery,
  TenantMappingStatus,
} from '#/api/ops/tenant/types';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';

import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  message,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  createCommandIdempotencyKey,
  createMapping,
  describeTenantError,
  fetchMappings,
  formatDateTime,
  MAPPING_STATUS_OPTIONS,
  mappingStatusView,
  shortId,
  validateReason,
} from '#/api/ops/tenant';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import MappingDetailDrawer from './components/mapping-detail-drawer.vue';

defineOptions({ name: 'TenantMappings' });

/**
 * 租户映射列表（契约 §5.7 `GET /tenant-mappings`）。
 *
 * 交付正确性要求：
 * - 冲突（`TENANT_MAPPING_CONFLICT`）只提示「不自动改绑」，**不提供**一键改绑；
 * - 版本冲突（`SYNC_VERSION_CONFLICT`）提示刷新并重新拉取，禁止本地覆盖；
 * - 无 `tenant.read` 时不展示任何租户数据（含空态与统计）。
 */
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.TENANT_READ));
const canProvision = computed(() =>
  hasPermission(OPS_PERMISSION.TENANT_PROVISION),
);

// ------------------------------------------------------------------ 列表

const rows = ref<TenantMapping[]>([]);
const loading = ref(false);
const loadError = shallowRef<null | TenantErrorView>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  customerId: '',
  mappingStatus: undefined as TenantMappingStatus | undefined,
  productId: '',
  syncVersion: '',
});

const columns: TableColumnsType = [
  { dataIndex: 'mappingNo', key: 'mappingNo', title: '映射编号', width: 170 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 200 },
  { dataIndex: 'productId', key: 'productId', title: '产品', width: 180 },
  {
    dataIndex: 'udoneOrganizationId',
    key: 'udoneOrganizationId',
    title: '外部租户 ID',
    width: 190,
  },
  {
    dataIndex: 'mappingStatus',
    key: 'mappingStatus',
    title: '映射状态',
    width: 110,
  },
  {
    dataIndex: 'lastKnownState',
    key: 'lastKnownState',
    title: '已知状态',
    width: 120,
  },
  {
    dataIndex: 'syncVersion',
    key: 'syncVersion',
    title: '同步版本',
    width: 100,
  },
  {
    dataIndex: 'lastSyncedAt',
    key: 'lastSyncedAt',
    title: '最近同步',
    width: 150,
  },
  { key: 'actions', title: '操作', width: 90 },
];

function parseSyncVersion(raw: string): number | undefined {
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function buildQuery(): TenantMappingListQuery {
  const syncVersion = parseSyncVersion(filters.syncVersion);
  return {
    customerId: filters.customerId.trim() || undefined,
    mappingStatus: filters.mappingStatus,
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    productId: filters.productId.trim() || undefined,
    ...(syncVersion === undefined ? {} : { syncVersion }),
  };
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchMappings(buildQuery());
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
  filters.customerId = '';
  filters.mappingStatus = undefined;
  filters.productId = '';
  filters.syncVersion = '';
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig) {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

// ------------------------------------------------------------------ 详情

const detailOpen = ref(false);
const activeMappingId = ref<null | string>(null);

function openDetail(row: TenantMapping) {
  activeMappingId.value = row.id;
  detailOpen.value = true;
}

// ------------------------------------------------------------------ 新建映射

const createOpen = ref(false);
const createSubmitting = ref(false);
const createError = shallowRef<null | TenantErrorView>(null);
const createErrors = ref<Record<string, string>>({});
const createForm = reactive({
  customerId: '',
  externalRef: '',
  productId: '',
  reason: '',
  udoneOrganizationId: '',
});
/**
 * 新建映射的幂等键：**弹窗打开时生成一次**，提交与失败重试都复用；
 * 只有关闭弹窗（新意图）才重新生成，避免重复建映射。
 */
const createIdempotencyKey = ref<null | string>(null);

function openCreate() {
  createForm.customerId = filters.customerId.trim();
  createForm.externalRef = '';
  createForm.productId = filters.productId.trim();
  createForm.reason = '';
  createForm.udoneOrganizationId = '';
  createErrors.value = {};
  createError.value = null;
  createIdempotencyKey.value = createCommandIdempotencyKey();
  createOpen.value = true;
}

async function submitCreate() {
  const key = createIdempotencyKey.value;
  if (!key || createSubmitting.value) {
    return;
  }
  const errors: Record<string, string> = {};
  if (createForm.customerId.trim() === '') {
    errors.customerId = '请填写客户 ID（客户选择器待客户域联调）';
  }
  if (createForm.productId.trim() === '') {
    errors.productId = '请填写产品 ID';
  }
  const validatedReason = validateReason(createForm.reason);
  if (!validatedReason.ok) {
    errors.reason = validatedReason.message ?? '请填写操作原因';
  }
  createErrors.value = errors;
  if (Object.keys(errors).length > 0) {
    return;
  }

  createSubmitting.value = true;
  createError.value = null;
  try {
    const externalRef = createForm.externalRef.trim();
    const udoneOrganizationId = createForm.udoneOrganizationId.trim();
    await createMapping(
      {
        customerId: createForm.customerId.trim(),
        productId: createForm.productId.trim(),
        reason: validatedReason.value,
        ...(externalRef === '' ? {} : { externalRef }),
        ...(udoneOrganizationId === '' ? {} : { udoneOrganizationId }),
      },
      key,
    );
    message.success('映射已创建（状态：待开通），下一步请下发开通命令');
    createOpen.value = false;
    createIdempotencyKey.value = null;
    await load();
  } catch (error: unknown) {
    const view = describeTenantError(error);
    createError.value = view;
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    createSubmitting.value = false;
  }
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
      data-testid="tenant-permission-denied"
      description="当前账号缺少 tenant.read 动作码。为避免泄漏租户引用与交付状态，本页不展示任何映射、命令或尝试记录。如需开通请联系运营管理员。"
      message="无查看租户交付权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="filters.customerId"
              allow-clear
              placeholder="按客户 ID 精确筛选"
              style="width: 200px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">映射状态</div>
            <Select
              v-model:value="filters.mappingStatus"
              :options="MAPPING_STATUS_OPTIONS"
              allow-clear
              placeholder="全部状态"
              style="width: 150px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">产品 ID</div>
            <Input
              v-model:value="filters.productId"
              allow-clear
              placeholder="按产品筛选"
              style="width: 180px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">同步版本</div>
            <Input
              v-model:value="filters.syncVersion"
              allow-clear
              placeholder="如 7"
              style="width: 110px"
            />
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
          <div class="ml-auto">
            <Tooltip
              v-if="!canProvision"
              title="缺少 tenant.provision，不能新建映射"
            >
              <span>
                <Button disabled>新建映射</Button>
              </span>
            </Tooltip>
            <Button v-else type="primary" ghost @click="openCreate">
              新建映射
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="tenant-list-error"
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
          :row-key="(row: TenantMapping) => row.id"
          :scroll="{ x: 1400 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'udoneOrganizationId'">
              <Tooltip :title="record.udoneOrganizationId">
                <span class="font-mono text-xs">
                  {{ shortId(record.udoneOrganizationId) }}
                </span>
              </Tooltip>
            </template>
            <template v-else-if="column.key === 'mappingStatus'">
              <Tag :color="mappingStatusView(record.mappingStatus).color">
                {{ mappingStatusView(record.mappingStatus).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'lastKnownState'">
              {{ record.lastKnownState ?? '—' }}
            </template>
            <template v-else-if="column.key === 'syncVersion'">
              v{{ record.syncVersion }}
            </template>
            <template v-else-if="column.key === 'lastSyncedAt'">
              {{ formatDateTime(record.lastSyncedAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as TenantMapping)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有租户映射" />
          </template>
        </Table>
      </Card>
    </template>

    <MappingDetailDrawer
      v-model:open="detailOpen"
      :mapping-id="activeMappingId"
      @changed="load"
    />

    <Modal
      v-model:open="createOpen"
      :confirm-loading="createSubmitting"
      :mask-closable="false"
      :width="720"
      ok-text="创建映射"
      title="新建租户映射"
      @ok="submitCreate"
    >
      <div class="space-y-3">
        <Alert
          message="一个 udone 租户只能绑定一个商业客户。若该租户已被占用，系统会拒绝并且不会自动改绑。"
          show-icon
          type="info"
        />
        <div class="grid gap-3 md:grid-cols-2">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="createForm.customerId"
              :status="createErrors.customerId ? 'error' : undefined"
              placeholder="软件客户 ID"
            />
            <p v-if="createErrors.customerId" class="mt-1 text-xs text-red-500">
              {{ createErrors.customerId }}
            </p>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">产品 ID</div>
            <Input
              v-model:value="createForm.productId"
              :status="createErrors.productId ? 'error' : undefined"
              placeholder="关联产品 ID"
            />
            <p v-if="createErrors.productId" class="mt-1 text-xs text-red-500">
              {{ createErrors.productId }}
            </p>
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">
              外部租户 ID（可空）
            </div>
            <Input
              v-model:value="createForm.udoneOrganizationId"
              placeholder="留空则由后端创建后回填"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">
              客户环境标识（可空）
            </div>
            <Input
              v-model:value="createForm.externalRef"
              placeholder="如 example-prod"
            />
          </div>
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">操作原因（必填）</div>
          <Input.TextArea
            v-model:value="createForm.reason"
            :maxlength="500"
            :rows="3"
            :status="createErrors.reason ? 'error' : undefined"
            placeholder="例如：合同 HT-2026-000201 已生效，登记租户映射并准备开通"
            show-count
          />
          <p v-if="createErrors.reason" class="mt-1 text-xs text-red-500">
            {{ createErrors.reason }}
          </p>
        </div>
        <Alert
          v-if="createError"
          :message="createError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ createError.description }}</p>
              <p v-if="createError.requestId" class="text-xs">
                请求 ID：<span class="font-mono">{{
                  createError.requestId
                }}</span>
              </p>
              <p
                v-if="createError.reason === 'TENANT_MAPPING_CONFLICT'"
                class="text-xs"
              >
                请核对租户 ID
                是否填错；如需改绑，必须由客户负责人确认后人工处理，本页不提供一键改绑。
              </p>
            </div>
          </template>
        </Alert>
      </div>
    </Modal>
  </div>
</template>
