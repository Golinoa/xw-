<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { type ReportResponse, type SupplierReportResponse } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const report = ref<ReportResponse | null>(null);
const suppliers = ref<SupplierReportResponse['items']>([]);

function defaultDates() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${first.getFullYear()}-${pad(first.getMonth() + 1)}-01`,
    to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}

const dates = reactive({ ...defaultDates(), includeCancelled: false });

const STATUS_LABELS: Record<string, string> = {
  booking: '预订单',
  active: '进行中',
  completed: '已锁团',
  cancelled: '已取消',
};

const supplierColumns = [
  { title: '供应商', key: 'supplierName', dataIndex: 'supplierName' },
  { title: '订单数', key: 'orderCount', dataIndex: 'orderCount', align: 'right' },
  { title: '应付金额', key: 'payableAmount', dataIndex: 'payableAmount', align: 'right' },
  { title: '已确认结算', key: 'confirmedAmount', dataIndex: 'confirmedAmount', align: 'right' },
];

async function load() {
  loading.value = true;
  errorText.value = '';
  const query = { from: dates.from, to: dates.to, includeCancelled: dates.includeCancelled };
  try {
    const [overview, bySupplier] = await Promise.all([
      auth.api.call('getTenantReport', { body: query }),
      auth.api.call('getSupplierReport', { body: query }),
    ]);
    report.value = overview;
    suppliers.value = bySupplier.items;
  } catch (cause) {
    report.value = null;
    suppliers.value = [];
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

function exportCsv() {
  // 导出直接用页面已经拿到的报表数据，与页面/仪表盘同源，不另算一遍。
  if (!report.value) return;
  const lines = [
    ['指标', '数值'].join(','),
    ['统计口径', '订单创建日期'].join(','),
    ['起始日期', dates.from].join(','),
    ['结束日期', dates.to].join(','),
    ['订单数', report.value.overview.orderCount].join(','),
    ['应收合计', report.value.overview.receivableTotal].join(','),
    ['应付合计', report.value.overview.payableTotal].join(','),
    ['已确认收款', report.value.finance.confirmedIn].join(','),
    ['在途收款', report.value.finance.pendingIn].join(','),
    ['已确认付款', report.value.finance.confirmedOut].join(','),
    ['在途付款', report.value.finance.pendingOut].join(','),
    [],
    ['供应商', '订单数', '应付金额', '已确认结算'].join(','),
    ...suppliers.value.map((item) =>
      [item.supplierName, item.orderCount, item.payableAmount, item.confirmedAmount].join(','),
    ),
  ];
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `经营报表_${dates.from}_${dates.to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

onMounted(load);
</script>

<template>
  <div class="report-page">
    <a-card title="经营分析" class="report-card">
      <p class="note">
        按订单创建日期统计。默认含预订/进行中/已锁团并分状态展示，已取消订单默认排除；
        「在途」是与已确认金额分开的独立列。
      </p>
      <div v-if="errorText" class="error-note">{{ errorText }}</div>

      <div class="filters">
        <a-input v-model:value="dates.from" type="date" class="date-input" @change="load" />
        <span class="separator">至</span>
        <a-input v-model:value="dates.to" type="date" class="date-input" @change="load" />
        <a-checkbox v-model:checked="dates.includeCancelled" @change="load">含已取消</a-checkbox>
        <a-button class="export-button" :disabled="!report" @click="exportCsv">导出 CSV</a-button>
      </div>

      <a-spin :spinning="loading">
        <div v-if="report" class="metrics">
          <div class="metric">
            <div class="metric-value">{{ report.overview.orderCount }}</div>
            <div class="metric-label">订单数</div>
          </div>
          <div class="metric">
            <div class="metric-value">{{ formatMoney(report.overview.receivableTotal) }}</div>
            <div class="metric-label">应收合计</div>
          </div>
          <div class="metric">
            <div class="metric-value">{{ formatMoney(report.overview.payableTotal) }}</div>
            <div class="metric-label">应付合计</div>
          </div>
          <div class="metric">
            <div class="metric-value">{{ formatMoney(report.overview.profit) }}</div>
            <div class="metric-label">利润</div>
          </div>
        </div>

        <div v-if="report" class="finance-grid">
          <div class="finance-item">
            <span class="finance-label">已确认收款</span>
            <span class="finance-value">{{ formatMoney(report.finance.confirmedIn) }}</span>
          </div>
          <div class="finance-item">
            <span class="finance-label">在途收款</span>
            <span class="finance-value pending">{{ formatMoney(report.finance.pendingIn) }}</span>
          </div>
          <div class="finance-item">
            <span class="finance-label">已确认付款</span>
            <span class="finance-value">{{ formatMoney(report.finance.confirmedOut) }}</span>
          </div>
          <div class="finance-item">
            <span class="finance-label">在途付款</span>
            <span class="finance-value pending">{{ formatMoney(report.finance.pendingOut) }}</span>
          </div>
        </div>

        <div v-if="report" class="status-line">
          <span class="status-label">状态分布</span>
          <span v-for="(count, status) in report.byStatus" :key="status" class="status-chip">
            {{ STATUS_LABELS[status] ?? status }} · {{ count }}
          </span>
          <span v-if="Object.keys(report.byStatus).length === 0" class="muted">无数据</span>
        </div>

        <!-- 普通标题元素。不能写成 a-table 的 title：那个 prop 是渲染函数，传字符串挂载时就抛 TypeError。 -->
        <div class="section-title">供应商统计</div>
        <a-table
          class="supplier-table"
          :data-source="suppliers"
          :columns="supplierColumns"
          :pagination="false"
          row-key="supplierId"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key.includes('Amount')">
              {{ formatMoney(record[column.key as keyof typeof record] as number) }}
            </template>
          </template>
          <template #emptyText><div class="empty">该区间暂无供应商数据</div></template>
        </a-table>
      </a-spin>
    </a-card>
  </div>
</template>

<style scoped>
.report-card {
  max-width: 1080px;
}
.note {
  margin-bottom: var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.error-note {
  margin-bottom: var(--space-16);
  color: var(--color-error-text);
  font-size: var(--font-size-sm);
}
.filters {
  display: flex;
  gap: var(--space-12);
  align-items: center;
  margin-bottom: var(--space-24);
}
.date-input {
  width: 160px;
}
.separator {
  color: var(--color-secondary-text);
}
.export-button {
  margin-left: auto;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-12);
  margin-bottom: var(--space-24);
}
.metric {
  padding: var(--space-16);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border-subtle);
  border-radius: 6px;
}
.metric-value {
  font: 650 20px/1.2 var(--font-mono, monospace);
}
.metric-label {
  margin-top: var(--space-4);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.finance-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-12);
  margin-bottom: var(--space-16);
}
.finance-item {
  display: flex;
  flex-direction: column;
}
.finance-label {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.finance-value {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-base);
}
.finance-value.pending {
  color: var(--color-primary);
}
.status-line {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-8);
  align-items: center;
  margin-bottom: var(--space-24);
}
.status-label {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.status-chip {
  padding: var(--space-4) var(--space-8);
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  font-size: var(--font-size-sm);
}
.muted {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.section-title {
  margin-bottom: var(--space-4);
  font-weight: 600;
}
.supplier-table {
  margin-top: var(--space-8);
}
.empty {
  padding: var(--space-24) 0;
  color: var(--color-secondary-text);
  text-align: center;
}
</style>
