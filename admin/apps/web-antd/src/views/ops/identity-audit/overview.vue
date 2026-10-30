<script lang="ts" setup>
/**
 * 运营总览（identity-audit 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / partial-failure。
 *
 * 四条硬约束：
 * 1. **「统计时刻」只取 `statisticsAt`**（服务端），页面不读浏览器时钟，也不显示
 *    「几秒前」这类本地推导（契约 §2.3）。
 * 2. **金额按币种分组、不合并**：指标里的两个金额字段没有币种，原样展示并加注；
 *    权威的分币种口径看下方应收表（契约 §2.2 / U-12）。
 * 3. **前端不累加**：所有数字直接来自响应，`formatCount` / `formatMoney` 只做格式化。
 * 4. **部分指标失败必须显式提示**：`partialFailures` 非空时说明「这不是全量」，
 *    否则运营会把缺数的总览当结论。
 */
import type { OpsApiError } from '#/api/adapter/errors';
import type { OpsOverview } from '#/api/ops/identity';
import type { OpsPermission } from '#/constants/permissions';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, Card, Select, Tag } from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import { formatMoney } from '#/api/ops/billing';
import {
  fetchOverview,
  formatCount,
  formatDateTime,
  SETTINGS_LIMITS,
} from '#/api/ops/identity';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

defineOptions({ name: 'OpsOverview' });

interface Drill {
  name: string;
  permission: OpsPermission;
}

interface MetricCard {
  /** 有下钻目标时才渲染入口；同时要求具备目标页权限。 */
  drill?: Drill;
  /** 金额型指标（响应里没有币种，按原值展示）。 */
  money?: boolean;
  note?: string;
  title: string;
  value: number;
}

const router = useRouter();
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.OVERVIEW_READ));

const windowOptions = [7, 14, 30, 60, 90].map((value) => ({
  label: `${value} 天`,
  value,
}));

const windowDays = ref<number | undefined>(undefined);
const data = ref<null | OpsOverview>(null);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

const defaultWindowHint = computed(
  () =>
    `未选择时使用系统设置中的临期窗口（${
      SETTINGS_LIMITS.overviewExpiryWindowDays.min
    }–${SETTINGS_LIMITS.overviewExpiryWindowDays.max} 天，由服务端取值）`,
);

function metricCards(overview: OpsOverview): MetricCard[] {
  const { metrics } = overview;
  return [
    {
      drill: { name: 'CustomerList', permission: OPS_PERMISSION.CUSTOMER_READ },
      title: '生效客户',
      value: metrics.activeCustomers,
    },
    {
      drill: { name: 'ContractList', permission: OPS_PERMISSION.CONTRACT_READ },
      title: '生效合同',
      value: metrics.activeContracts,
    },
    {
      drill: {
        name: 'TenantMappings',
        permission: OPS_PERMISSION.TENANT_READ,
      },
      title: '运行中租户',
      value: metrics.runningTenants,
    },
    {
      drill: {
        name: 'EntitlementSubscriptions',
        permission: OPS_PERMISSION.ENTITLEMENT_READ,
      },
      title: '生效权益',
      value: metrics.activeEntitlements,
    },
    {
      drill: {
        name: 'EntitlementSubscriptions',
        permission: OPS_PERMISSION.ENTITLEMENT_READ,
      },
      note: `窗口 ${overview.windowDays} 天内到期`,
      title: '临期权益',
      value: metrics.expiringEntitlements,
    },
    {
      drill: {
        name: 'SupportTicketList',
        permission: OPS_PERMISSION.TICKET_READ,
      },
      title: '未关闭工单',
      value: metrics.openTickets,
    },
    {
      drill: {
        name: 'SupportTicketList',
        permission: OPS_PERMISSION.TICKET_READ,
      },
      title: '等待中工单',
      value: metrics.waitingTickets,
    },
    {
      drill: {
        name: 'TenantCommands',
        permission: OPS_PERMISSION.TENANT_READ,
      },
      title: '同步失败命令',
      value: metrics.failedSyncCommands,
    },
    {
      drill: {
        name: 'BillingReceipts',
        permission: OPS_PERMISSION.RECEIVABLE_READ,
      },
      money: true,
      note: '指标金额未带币种，按契约原样展示',
      title: '待核销收款',
      value: metrics.pendingReceiptAmount,
    },
    {
      drill: {
        name: 'BillingReceipts',
        permission: OPS_PERMISSION.RECEIVABLE_READ,
      },
      money: true,
      note: '指标金额未带币种，按契约原样展示',
      title: '未核销金额',
      value: metrics.unreconciledAmount,
    },
  ];
}

const cards = computed(() => (data.value ? metricCards(data.value) : []));

const amountColumns = [
  { key: 'currency', title: '币种' },
  { key: 'totalReceivable', title: '应收合计' },
  { key: 'settledReceivable', title: '已收' },
  { key: 'overdueReceivable', title: '逾期' },
  { key: 'upcomingReceivable', title: '未到期' },
];

const hasPartialFailures = computed(
  () => (data.value?.partialFailures.length ?? 0) > 0,
);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    data.value = await fetchOverview(
      windowDays.value ? { windowDays: windowDays.value } : {},
    );
  } catch (error_) {
    error.value = toOpsApiError(error_);
    data.value = null;
  } finally {
    loading.value = false;
  }
}

function canDrill(drill: Drill | undefined): boolean {
  return Boolean(drill && hasPermission(drill.permission));
}

/** 各列表页筛选参数不同，下钻只做跳转，不试图跨页传筛选条件。 */
function drillTo(drill: Drill | undefined) {
  if (!drill || !hasPermission(drill.permission)) {
    return;
  }
  void router.push({ name: drill.name });
}

function describeFailure(index: number): string {
  const failure = data.value?.partialFailures[index];
  if (!failure) {
    return '未提供原因';
  }
  const parts = [failure.section, failure.code, failure.message].filter(
    (item): item is string => typeof item === 'string' && item !== '',
  );
  return parts.length > 0
    ? parts.join(' · ')
    : '未提供原因（契约未定义条目字段）';
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.OVERVIEW_READ]"
      title="运营总览"
    />

    <template v-else>
      <Card>
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-medium text-foreground">运营总览</h2>
            <p class="mt-1 text-xs text-muted-foreground">
              统计时刻：{{ formatDateTime(data?.statisticsAt) }}
              <span v-if="data"> · 临期窗口 {{ data.windowDays }} 天</span>
              <span> · 时间取自服务端，不使用本地时钟</span>
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Select
              v-model:value="windowDays"
              allow-clear
              class="w-36"
              :options="windowOptions"
              placeholder="临期窗口"
              @change="load"
            />
            <Button :loading="loading" @click="load">刷新</Button>
          </div>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          {{ defaultWindowHint }}
        </p>
      </Card>

      <OpsErrorAlert
        v-if="error"
        class="mt-4"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <div
        v-if="hasPartialFailures"
        class="mt-4 rounded-md border border-orange-300 bg-orange-50 p-3 text-sm text-orange-800"
      >
        <p class="font-medium">部分指标取数失败，以下数字不是全量</p>
        <ul class="mt-1 list-disc pl-5">
          <li v-for="(_, index) in data?.partialFailures" :key="index">
            {{ describeFailure(index) }}
          </li>
        </ul>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card v-for="card in cards" :key="card.title" size="small">
          <p class="text-xs text-muted-foreground">{{ card.title }}</p>
          <p class="mt-1 text-2xl font-semibold text-foreground">
            {{ card.money ? formatMoney(card.value) : formatCount(card.value) }}
          </p>
          <p v-if="card.note" class="mt-1 text-xs text-muted-foreground">
            {{ card.note }}
          </p>
          <Button
            v-if="canDrill(card.drill)"
            class="mt-2 px-0"
            size="small"
            type="link"
            @click="drillTo(card.drill)"
          >
            查看明细
          </Button>
        </Card>
      </div>

      <Card class="mt-4" size="small" title="应收按币种">
        <template #extra>
          <span class="text-xs text-muted-foreground">
            按币种分组，不做汇率折算与跨币种合计
          </span>
        </template>

        <div
          v-if="!loading && (data?.amounts.length ?? 0) === 0"
          class="py-6 text-center text-sm text-muted-foreground"
        >
          服务端未返回任何币种的应收数据。
        </div>

        <table v-else class="w-full text-sm">
          <thead>
            <tr
              class="border-b border-border text-left text-xs text-muted-foreground"
            >
              <th
                v-for="column in amountColumns"
                :key="column.key"
                class="py-2 pr-4"
              >
                {{ column.title }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="amount in data?.amounts ?? []"
              :key="amount.currency"
              class="border-b border-border/60"
            >
              <td class="py-2 pr-4">
                <Tag color="blue">{{ amount.currency }}</Tag>
              </td>
              <td class="py-2 pr-4">
                {{ formatMoney(amount.totalReceivable, amount.currency) }}
              </td>
              <td class="py-2 pr-4">
                {{ formatMoney(amount.settledReceivable, amount.currency) }}
              </td>
              <td class="py-2 pr-4">
                {{ formatMoney(amount.overdueReceivable, amount.currency) }}
              </td>
              <td class="py-2 pr-4">
                {{ formatMoney(amount.upcomingReceivable, amount.currency) }}
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      <p class="mt-3 text-xs text-muted-foreground">
        指标与金额全部由服务端聚合（契约 §2.2）：前端只格式化，不做求和或换算。
      </p>
    </template>
  </div>
</template>
