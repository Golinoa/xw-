<script lang="ts" setup>
import type { ReportResponse, SupplierReportResponse } from '@erp/contracts';

import { onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import { Button, Card, Checkbox, Input, Spin, Table } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'OpsReports' });

const authStore = useAuthStore();

const loading = ref(true);
const errorText = ref('');
const report = ref<null | ReportResponse>(null);
const suppliers = ref<SupplierReportResponse['items']>([]);

/** 默认本月 1 日到今天：报表按订单创建日期统计，跨月看要手动改。 */
function defaultDates() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`,
    to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}

const dates = reactive({ ...defaultDates(), includeCancelled: false });

const STATUS_LABELS: Record<string, string> = {
  active: $t('shell.reports.statusActive'),
  booking: $t('shell.reports.statusBooking'),
  cancelled: $t('shell.reports.statusCancelled'),
  completed: $t('shell.reports.statusCompleted'),
};

const supplierColumns = [
  { dataIndex: 'supplierName', key: 'supplierName', title: $t('shell.reports.colSupplier') },
  {
    align: 'right' as const,
    dataIndex: 'orderCount',
    key: 'orderCount',
    title: $t('shell.reports.colOrderCount'),
  },
  {
    align: 'right' as const,
    dataIndex: 'payableAmount',
    key: 'payableAmount',
    title: $t('shell.reports.colPayable'),
  },
  {
    align: 'right' as const,
    dataIndex: 'confirmedAmount',
    key: 'confirmedAmount',
    title: $t('shell.reports.colConfirmed'),
  },
];

async function load() {
  loading.value = true;
  errorText.value = '';
  const query = { from: dates.from, includeCancelled: dates.includeCancelled, to: dates.to };
  try {
    const [overview, bySupplier] = await Promise.all([
      authStore.api.call('getTenantReport', { body: query }),
      authStore.api.call('getSupplierReport', { body: query }),
    ]);
    report.value = overview;
    suppliers.value = bySupplier.items;
  } catch (error) {
    report.value = null;
    suppliers.value = [];
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.reports.loadFailed');
  } finally {
    loading.value = false;
  }
}

/** 导出直接用页面已拿到的数据：与页面同源，不另算一遍，避免两份口径。 */
function exportCsv() {
  if (!report.value) return;
  const lines = [
    [$t('shell.reports.csvMetric'), $t('shell.reports.csvValue')].join(','),
    [$t('shell.reports.csvBasis'), $t('shell.reports.csvBasisValue')].join(','),
    [$t('shell.reports.csvFrom'), dates.from].join(','),
    [$t('shell.reports.csvTo'), dates.to].join(','),
    [$t('shell.reports.metricOrders'), report.value.overview.orderCount].join(','),
    [$t('shell.reports.metricReceivable'), report.value.overview.receivableTotal].join(','),
    [$t('shell.reports.metricPayable'), report.value.overview.payableTotal].join(','),
    [$t('shell.reports.financeConfirmedIn'), report.value.finance.confirmedIn].join(','),
    [$t('shell.reports.financePendingIn'), report.value.finance.pendingIn].join(','),
    [$t('shell.reports.financeConfirmedOut'), report.value.finance.confirmedOut].join(','),
    [$t('shell.reports.financePendingOut'), report.value.finance.pendingOut].join(','),
    [],
    [
      $t('shell.reports.colSupplier'),
      $t('shell.reports.colOrderCount'),
      $t('shell.reports.colPayable'),
      $t('shell.reports.colConfirmed'),
    ].join(','),
    ...suppliers.value.map((item) =>
      [item.supplierName, item.orderCount, item.payableAmount, item.confirmedAmount].join(','),
    ),
  ];
  // BOM + CRLF：Excel 直接双击打开中文才不乱码，换行才不会被某些版本吞掉。
  const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${$t('shell.reports.fileName')}_${dates.from}_${dates.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

onMounted(load);
</script>

<template>
  <Page :description="$t('shell.reports.description')" :title="$t('shell.menu.reports')">
    <Card>
      <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.reports.note') }}</p>
      <p v-if="errorText" class="mb-4 text-sm text-red-600" role="alert">{{ errorText }}</p>

      <div class="mb-6 flex flex-wrap items-center gap-3">
        <Input v-model:value="dates.from" class="w-[160px]" type="date" @change="load" />
        <span class="text-muted-foreground">{{ $t('shell.reports.to') }}</span>
        <Input v-model:value="dates.to" class="w-[160px]" type="date" @change="load" />
        <Checkbox v-model:checked="dates.includeCancelled" @change="load">
          {{ $t('shell.reports.includeCancelled') }}
        </Checkbox>
        <Button class="ml-auto" :disabled="!report" @click="exportCsv">
          {{ $t('shell.reports.export') }}
        </Button>
      </div>

      <Spin :spinning="loading">
        <div v-if="report" class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="rounded border border-border bg-muted/40 p-4">
            <div class="font-mono text-xl font-semibold">{{ report.overview.orderCount }}</div>
            <div class="mt-1 text-sm text-muted-foreground">{{ $t('shell.reports.metricOrders') }}</div>
          </div>
          <div class="rounded border border-border bg-muted/40 p-4">
            <div class="font-mono text-xl font-semibold">
              {{ formatMoney(report.overview.receivableTotal) }}
            </div>
            <div class="mt-1 text-sm text-muted-foreground">{{ $t('shell.reports.metricReceivable') }}</div>
          </div>
          <div class="rounded border border-border bg-muted/40 p-4">
            <div class="font-mono text-xl font-semibold">
              {{ formatMoney(report.overview.payableTotal) }}
            </div>
            <div class="mt-1 text-sm text-muted-foreground">{{ $t('shell.reports.metricPayable') }}</div>
          </div>
          <div class="rounded border border-border bg-muted/40 p-4">
            <div class="font-mono text-xl font-semibold">{{ formatMoney(report.overview.profit) }}</div>
            <div class="mt-1 text-sm text-muted-foreground">{{ $t('shell.reports.metricProfit') }}</div>
          </div>
        </div>

        <div v-if="report" class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div class="flex flex-col">
            <span class="text-sm text-muted-foreground">{{ $t('shell.reports.financeConfirmedIn') }}</span>
            <span class="font-mono">{{ formatMoney(report.finance.confirmedIn) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm text-muted-foreground">{{ $t('shell.reports.financePendingIn') }}</span>
            <span class="font-mono text-primary">{{ formatMoney(report.finance.pendingIn) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm text-muted-foreground">{{ $t('shell.reports.financeConfirmedOut') }}</span>
            <span class="font-mono">{{ formatMoney(report.finance.confirmedOut) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm text-muted-foreground">{{ $t('shell.reports.financePendingOut') }}</span>
            <span class="font-mono text-primary">{{ formatMoney(report.finance.pendingOut) }}</span>
          </div>
        </div>

        <div v-if="report" class="mb-6 flex flex-wrap items-center gap-2">
          <span class="text-sm text-muted-foreground">{{ $t('shell.reports.statusTitle') }}</span>
          <span
            v-for="(count, status) in report.byStatus"
            :key="status"
            class="rounded border border-border px-2 py-0.5 text-sm"
          >
            {{ STATUS_LABELS[String(status)] ?? status }} · {{ count }}
          </span>
          <span v-if="Object.keys(report.byStatus).length === 0" class="text-sm text-muted-foreground">
            {{ $t('shell.reports.noData') }}
          </span>
        </div>

        <div class="mb-1 font-medium">{{ $t('shell.reports.supplierTitle') }}</div>
        <Table
          :columns="supplierColumns"
          :data-source="suppliers"
          :pagination="false"
          row-key="supplierId"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'payableAmount' || column.key === 'confirmedAmount'">
              {{
                formatMoney(
                  (record as unknown as Record<string, number>)[String(column.key)],
                )
              }}
            </template>
          </template>
          <template #emptyText>
            <div class="py-6 text-center text-muted-foreground">{{ $t('shell.reports.emptySuppliers') }}</div>
          </template>
        </Table>
      </Spin>
    </Card>
  </Page>
</template>
