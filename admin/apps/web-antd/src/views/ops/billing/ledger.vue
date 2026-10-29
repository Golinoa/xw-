<script lang="ts" setup>
import type { LedgerEntry } from './timeline';

import type { BillingErrorView } from '#/api/ops/billing/errors';
import type { Receipt, Receivable } from '#/api/ops/billing/types';

import { computed, onMounted, ref, shallowRef, watch } from 'vue';

import {
  Alert,
  Card,
  Empty,
  Radio,
  Select,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  describeBillingError,
  fetchReceipt,
  fetchReceipts,
  fetchReceivable,
  fetchReceivables,
  formatDate,
  formatMoney,
  receiptStatusView,
  receivableStatusView,
} from '#/api/ops/billing';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import DevDataNotice from './components/dev-data-notice.vue';
import {
  buildReceiptLedger,
  buildReceivableLedger,
  formatLedgerTime,
} from './timeline';

defineOptions({ name: 'BillingLedger' });

const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.RECEIVABLE_READ));

type LedgerMode = 'receipt' | 'receivable';

const mode = ref<LedgerMode>('receivable');
const options = ref<{ label: string; value: string }[]>([]);
const optionsLoading = ref(false);
const optionsError = shallowRef<BillingErrorView | null>(null);
const selectedId = ref<string | undefined>();

const entries = ref<LedgerEntry[]>([]);
const loading = ref(false);
const error = shallowRef<BillingErrorView | null>(null);
const header = shallowRef<null | string>(null);

const kindLabel: Record<LedgerEntry['kind'], string> = {
  allocation: '核销',
  allocation_reversal: '撤销核销',
  extension: '展期',
  receipt_approved: '审核',
  receipt_recorded: '登记收款',
  receipt_reversal: '收款冲正',
  refund: '退款',
};

const timelineColumns = [
  { dataIndex: 'at', key: 'at', title: '时间', width: 150 },
  { dataIndex: 'title', key: 'title', title: '事件', width: 190 },
  { dataIndex: 'actor', key: 'actor', title: '操作者', width: 140 },
  { dataIndex: 'amount', key: 'amount', title: '金额', width: 140 },
  { dataIndex: 'reason', key: 'reason', title: '原因', width: 220 },
  { dataIndex: 'related', key: 'related', title: '关联对象', width: 260 },
];

async function loadOptions() {
  optionsLoading.value = true;
  optionsError.value = null;
  selectedId.value = undefined;
  entries.value = [];
  header.value = null;
  try {
    if (mode.value === 'receivable') {
      const result = await fetchReceivables({
        order: 'asc',
        page: 1,
        pageSize: 100,
        sort: 'dueDate',
      });
      options.value = result.items.map((item: Receivable) => ({
        label: `${item.contractNo} 第 ${item.periodNo} 期 · ${item.customer.name} · ${formatDate(item.dueDate)} 到期`,
        value: item.id,
      }));
    } else {
      const result = await fetchReceipts({
        order: 'desc',
        page: 1,
        pageSize: 100,
      });
      options.value = result.items.map((item: Receipt) => ({
        label: `${item.receiptNo} · ${item.customer.name} · ${formatMoney(item.amount, item.currency)}`,
        value: item.id,
      }));
    }
  } catch (error_: unknown) {
    options.value = [];
    optionsError.value = describeBillingError(error_);
  } finally {
    optionsLoading.value = false;
  }
}

async function loadLedger() {
  const targetId = selectedId.value;
  if (!targetId) {
    entries.value = [];
    header.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    if (mode.value === 'receivable') {
      const detail = await fetchReceivable(targetId);
      entries.value = buildReceivableLedger(detail);
      header.value = `应收 · ${detail.receivable.contractNo} 第 ${detail.receivable.periodNo} 期（${receivableStatusView(detail.receivable.status).label}）`;
    } else {
      const detail = await fetchReceipt(targetId);
      entries.value = buildReceiptLedger(detail);
      header.value = `收款 · ${detail.receipt.receiptNo}（${receiptStatusView(detail.receipt.status).label}）`;
    }
  } catch (error_: unknown) {
    entries.value = [];
    error.value = describeBillingError(error_);
  } finally {
    loading.value = false;
  }
}

watch(mode, () => {
  void loadOptions();
});

watch(selectedId, () => {
  void loadLedger();
});

onMounted(() => {
  if (canRead.value) {
    void loadOptions();
  }
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="billing-permission-denied"
      description="当前账号缺少 receivable.read 动作码，本页不展示任何金额。"
      message="无查看账款权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-center gap-3">
          <Radio.Group v-model:value="mode" button-style="solid">
            <Radio.Button value="receivable">按应收查看</Radio.Button>
            <Radio.Button value="receipt">按收款查看</Radio.Button>
          </Radio.Group>
          <Select
            v-model:value="selectedId"
            :loading="optionsLoading"
            :options="options"
            :placeholder="
              mode === 'receivable' ? '选择一条应收' : '选择一笔收款'
            "
            show-search
            style="min-width: 460px"
          />
          <Tag color="blue">流水只追加，不覆盖历史</Tag>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          契约未提供跨对象账款明细端点，本页按契约详情端点（应收 /
          收款）聚合其核销、撤销、冲正、退款与展期流水；金额直接取服务端字段，不在前端汇总。
        </p>
      </Card>

      <Card>
        <Alert
          v-if="optionsError"
          :message="optionsError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ optionsError.description }}</p>
            <p v-if="optionsError.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{
                optionsError.requestId
              }}</span>
            </p>
          </template>
        </Alert>

        <Alert v-if="error" :message="error.title" show-icon type="error">
          <template #description>
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
            </p>
          </template>
        </Alert>

        <div v-if="header" class="mb-2 text-sm font-medium">{{ header }}</div>

        <Spin :spinning="loading">
          <Table
            v-if="entries.length > 0"
            :columns="timelineColumns"
            :data-source="entries"
            :pagination="false"
            :row-key="(row: LedgerEntry) => row.id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'at'">
                {{ formatLedgerTime(record.at) }}
              </template>
              <template v-else-if="column.key === 'title'">
                <Tag>{{ kindLabel[record.kind as LedgerEntry['kind']] }}</Tag>
                {{ record.title }}
              </template>
              <template v-else-if="column.key === 'actor'">
                {{ record.actor }}
              </template>
              <template v-else-if="column.key === 'amount'">
                {{
                  record.amount === null
                    ? '—'
                    : formatMoney(record.amount, record.currency)
                }}
              </template>
            </template>
          </Table>
          <Empty
            v-else
            :description="
              selectedId
                ? '该对象暂无可展示的账款流水'
                : '请选择左侧对象查看其完整流水'
            "
          />
        </Spin>
      </Card>
    </template>
  </div>
</template>
