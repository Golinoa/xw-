<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type { EntitlementErrorView } from '#/api/ops/entitlement/errors';
import type {
  BillingCycle,
  EntitlementStatus,
  Subscription,
  SubscriptionListQuery,
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
  BILLING_CYCLE_OPTIONS,
  billingCycleLabel,
  describeEntitlementError,
  ENTITLEMENT_STATUS_OPTIONS,
  entitlementStatusView,
  fetchSubscriptions,
  formatDate,
  snapshotSummaryText,
} from '#/api/ops/entitlement';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import EntitlementDetailDrawer from './components/entitlement-detail-drawer.vue';
import SubscriptionCreateModal from './components/subscription-create-modal.vue';

defineOptions({ name: 'EntitlementSubscriptions' });

/**
 * SaaS 订阅列表。
 *
 * - 分页/筛选全部走服务端（`page/pageSize/status[]/customerId/billingCycle/endsFrom/endsTo`），
 *   不在浏览器做全量过滤；
 * - 状态列只读：任何状态推进都在详情抽屉里走「提交/审批」或「变更申请」；
 * - 无 `entitlement.read` 时不渲染任何订阅/权益明细（含额度与快照摘要）。
 */
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.ENTITLEMENT_READ));
const canRequest = computed(() =>
  hasPermission(OPS_PERMISSION.ENTITLEMENT_REQUEST),
);

const rows = ref<Subscription[]>([]);
const loading = ref(false);
const loadError = shallowRef<EntitlementErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  billingCycle: undefined as BillingCycle | undefined,
  customerId: '',
  status: [] as EntitlementStatus[],
});
const endsRange = ref<[Dayjs, Dayjs] | undefined>();

const columns: TableColumnsType = [
  {
    dataIndex: 'subscriptionNo',
    key: 'subscriptionNo',
    title: '订阅号',
    width: 170,
  },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 210 },
  { dataIndex: 'product', key: 'product', title: '产品', width: 200 },
  {
    dataIndex: 'billingCycle',
    key: 'billingCycle',
    title: '计费周期',
    width: 110,
  },
  { dataIndex: 'period', key: 'period', title: '订阅期间', width: 200 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 120 },
  {
    dataIndex: 'snapshot',
    key: 'snapshot',
    title: '当前权益快照',
    width: 320,
  },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): SubscriptionListQuery {
  return {
    billingCycle: filters.billingCycle,
    customerId: filters.customerId.trim() || undefined,
    endsFrom: endsRange.value?.[0]?.format('YYYY-MM-DD'),
    endsTo: endsRange.value?.[1]?.format('YYYY-MM-DD'),
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    sort: 'startsOn',
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
    const result = await fetchSubscriptions(buildQuery());
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
  filters.billingCycle = undefined;
  filters.customerId = '';
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

// ------------------------------------------------------------------ 详情 / 新建

const detailOpen = ref(false);
const activeId = ref<null | string>(null);

function openDetail(row: Subscription): void {
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
      description="当前账号缺少 entitlement.read 动作码。按最小可见原则，本页不展示任何客户权益、快照或额度信息。如需开通请联系运营管理员。"
      message="无查看权益权限"
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
              style="width: 190px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="ENTITLEMENT_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 220px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">计费周期</div>
            <Select
              v-model:value="filters.billingCycle"
              :options="BILLING_CYCLE_OPTIONS"
              allow-clear
              placeholder="全部周期"
              style="width: 140px"
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
              title="缺少 entitlement.request，不能创建订阅草稿"
            >
              <span>
                <Button disabled>创建订阅草稿</Button>
              </span>
            </Tooltip>
            <Button v-else ghost type="primary" @click="createOpen = true">
              创建订阅草稿
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
          :row-key="(row: Subscription) => row.id"
          :scroll="{ x: 1350 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'product'">
              {{ record.product?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'billingCycle'">
              {{ billingCycleLabel(record.billingCycle) }}
            </template>
            <template v-else-if="column.key === 'period'">
              {{ formatDate(record.startsOn) }} ~
              {{ record.endsOn ? formatDate(record.endsOn) : '未定' }}
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
                @click="openDetail(record as Subscription)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有订阅记录" />
          </template>
        </Table>
      </Card>
    </template>

    <EntitlementDetailDrawer
      v-model:open="detailOpen"
      :subject-id="activeId"
      subject-type="subscription"
      @changed="load"
    />

    <SubscriptionCreateModal v-model:open="createOpen" @created="load" />
  </div>
</template>
