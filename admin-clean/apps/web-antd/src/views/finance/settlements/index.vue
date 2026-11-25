<script lang="ts" setup>
import type { PaymentMethod, SettlementBatch, SettlementBatchDetail, SettlementStatus } from '@erp/contracts';

import { computed, onMounted, ref } from 'vue';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  DescriptionsItem,
  Drawer,
  Modal,
  Pagination,
  Select,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime, formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { PAYMENT_METHOD_LABEL_KEYS } from '../finance-application-display';
import SettlementCreateModal from './settlement-create-modal.vue';
import {
  cancelNeedsReason,
  formatPeriodMonth,
  SETTLEMENT_STATUS_COLORS,
  SETTLEMENT_STATUS_LABEL_KEYS,
  SETTLEMENT_STATUSES_ORDER,
} from './settlement-display';

defineOptions({ name: 'FinanceSettlements' });

const authStore = useAuthStore();
const canRead = (() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions.includes(PERMISSIONS.FINANCE_WRITE) : false;
})();

const items = ref<SettlementBatch[]>([]);
const total = ref(0);
const loading = ref(true);
const listError = ref('');
const forbidden = ref(false);
const supplierFilter = ref<string | undefined>(undefined);
const statusFilter = ref<SettlementStatus | undefined>(undefined);
const page = ref(1);
const pageSize = ref(DEFAULT_PAGE_SIZE);
let requestSeq = 0;

const createOpen = ref(false);
const detailOpen = ref(false);
const detail = ref<null | SettlementBatchDetail>(null);
const detailLoading = ref(false);
const actingId = ref('');

const cancelTarget = ref<null | SettlementBatch | SettlementBatchDetail>(null);
const cancelReason = ref('');
const cancelling = ref(false);

const statusOptions = computed(() =>
  SETTLEMENT_STATUSES_ORDER.map((value) => ({
    label: $t(SETTLEMENT_STATUS_LABEL_KEYS[value]),
    value,
  })),
);
const supplierOptions = ref<{ label: string; value: string }[]>([]);


async function loadSuppliers() {
  try {
    const result = await authStore.api.call('listSuppliers', {
      body: { order: 'asc', page: 1, pageSize: 100, sort: 'name' },
    });
    supplierOptions.value = result.items.map((item) => ({ label: item.name, value: item.id }));
  } catch {
    supplierOptions.value = [];
  }
}

async function load() {
  if (!canRead) {
    items.value = [];
    total.value = 0;
    loading.value = false;
    forbidden.value = true;
    return;
  }
  const seq = ++requestSeq;
  forbidden.value = false;
  loading.value = true;
  listError.value = '';
  try {
    const result = await authStore.api.call('listSettlements', {
      body: {
        order: 'desc',
        page: page.value,
        pageSize: pageSize.value,
        sort: 'createdAt',
        ...(statusFilter.value ? { status: statusFilter.value } : {}),
        ...(supplierFilter.value ? { supplierId: supplierFilter.value } : {}),
      },
    });
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    listError.value = error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.loadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function onFilterChange() {
  page.value = 1;
  void load();
}
function onPageChange(nextPage: number, nextPageSize: number) {
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void load();
}

async function openDetail(row: SettlementBatch) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const result = await authStore.api.call('getSettlement', { params: { batchId: row.id } });
    detail.value = result.settlement;
  } catch (error_) {
    listError.value = error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.detailFailed');
  } finally {
    detailLoading.value = false;
  }
}

async function confirm(row: SettlementBatch) {
  if (actingId.value) return;
  actingId.value = row.id;
  try {
    await authStore.api.call('confirmSettlement', { params: { batchId: row.id } });
    await load();
    if (detailOpen.value && detail.value) await openDetail(detail.value);
  } catch (error_) {
    listError.value = error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.actionFailed');
  } finally {
    actingId.value = '';
  }
}

function askCancel(row: SettlementBatch | SettlementBatchDetail) {
  cancelTarget.value = row;
  cancelReason.value = '';
}

async function submitCancel() {
  const target = cancelTarget.value;
  if (!target || cancelling.value) return;
  const reason = cancelReason.value.trim();
  if (cancelNeedsReason(target.status) && !reason) {
    listError.value = $t('shell.settlements.cancelReasonRequired');
    return;
  }
  cancelling.value = true;
  try {
    await authStore.api.call('cancelSettlement', {
      body: { ...(reason ? { reason } : {}) },
      params: { batchId: target.id },
    });
    cancelTarget.value = null;
    await load();
    if (detailOpen.value && detail.value) await openDetail(detail.value);
  } catch (error_) {
    listError.value = error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.actionFailed');
  } finally {
    cancelling.value = false;
  }
}

const columns = computed(() => [
  { dataIndex: 'supplierName', key: 'supplierName', title: $t('shell.settlements.colSupplier'), width: 160 },
  { dataIndex: 'periodMonth', key: 'periodMonth', title: $t('shell.settlements.colPeriod'), width: 120 },
  { align: 'right' as const, dataIndex: 'totalAmount', key: 'totalAmount', title: $t('shell.settlements.colAmount'), width: 140 },
  { align: 'right' as const, dataIndex: 'itemCount', key: 'itemCount', title: $t('shell.settlements.colItems'), width: 100 },
  { dataIndex: 'method', key: 'method', title: $t('shell.settlements.colMethod'), width: 110 },
  { dataIndex: 'status', key: 'status', title: $t('shell.settlements.colStatus'), width: 100 },
  { dataIndex: 'createdAt', key: 'createdAt', title: $t('shell.settlements.colCreatedAt'), width: 170 },
  { key: 'action', title: $t('shell.settlements.colAction'), width: 200 },
]);

async function onCreated() {
  await load();
}

onMounted(() => {
  if (!canRead) return;
  void loadSuppliers();
  void load();
});
</script>

<template>
  <Page :description="$t('shell.settlements.description')" :title="$t('shell.menu.settlements')">
    <Alert v-if="!canRead || forbidden" :message="$t('shell.settlements.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p v-if="listError" class="mb-4 text-sm text-red-600" role="alert">{{ listError }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <Select
          v-model:value="supplierFilter"
          allow-clear
          class="w-48"
          :options="supplierOptions"
          :placeholder="$t('shell.settlements.supplierPlaceholder')"
          @change="onFilterChange"
        />
        <Select
          v-model:value="statusFilter"
          allow-clear
          class="w-36"
          :options="statusOptions"
          :placeholder="$t('shell.settlements.statusPlaceholder')"
          @change="onFilterChange"
        />
        <span class="text-sm text-muted-foreground">{{ $t('shell.settlements.total', { total }) }}</span>
        <Button class="ml-auto" type="primary" @click="createOpen = true">
          {{ $t('shell.settlements.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :locale="{ emptyText: $t('shell.settlements.empty') }"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'periodMonth'">{{ formatPeriodMonth(record.periodMonth) }}</template>
          <template v-else-if="['totalAmount'].includes(String(column.key))">{{ formatMoney(record.totalAmount) }}</template>
          <template v-else-if="column.key === 'method'">
            {{ $t(PAYMENT_METHOD_LABEL_KEYS[record.method as PaymentMethod]) }}
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="SETTLEMENT_STATUS_COLORS[record.status as SettlementStatus]">
              {{ $t(SETTLEMENT_STATUS_LABEL_KEYS[record.status as SettlementStatus]) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ formatDateTime(record.createdAt) }}</template>
          <template v-else-if="column.key === 'action'">
            <div class="flex flex-wrap gap-1">
              <Button size="small" type="link" @click="openDetail(record as SettlementBatch)">
                {{ $t('shell.settlements.detail') }}
              </Button>
              <Button
                v-if="record.status === 'draft'"
                :loading="actingId === record.id"
                size="small"
                type="link"
                @click="confirm(record as SettlementBatch)"
              >
                {{ $t('shell.settlements.confirm') }}
              </Button>
              <Button
                v-if="record.status !== 'cancelled'"
                danger
                size="small"
                type="link"
                @click="askCancel(record as SettlementBatch)"
              >
                {{ $t('shell.settlements.cancel') }}
              </Button>
            </div>
          </template>
        </template>
      </Table>

      <div v-if="total > 0" class="mt-4 flex justify-end">
        <Pagination
          :current="page"
          :page-size="pageSize"
          :page-size-options="PAGE_SIZE_OPTIONS.map(String)"
          :total="total"
          @change="onPageChange"
        />
      </div>
    </Card>

    <Drawer
      :open="detailOpen"
      :title="$t('shell.settlements.detailTitle')"
      :width="720"
      @close="detailOpen = false"
    >
      <div v-if="detailLoading" class="py-12 text-center text-sm text-muted-foreground">
        {{ $t('shell.settlements.detailLoading') }}
      </div>
      <template v-else-if="detail">
        <Descriptions :column="2" bordered size="small">
          <DescriptionsItem :label="$t('shell.settlements.colSupplier')">{{ detail.supplierName }}</DescriptionsItem>
          <DescriptionsItem :label="$t('shell.settlements.colPeriod')">{{ formatPeriodMonth(detail.periodMonth) }}</DescriptionsItem>
          <DescriptionsItem :label="$t('shell.settlements.colAmount')">{{ formatMoney(detail.totalAmount) }}</DescriptionsItem>
          <DescriptionsItem :label="$t('shell.settlements.colItems')">{{ detail.itemCount }}</DescriptionsItem>
          <DescriptionsItem :label="$t('shell.settlements.colMethod')">{{ $t(PAYMENT_METHOD_LABEL_KEYS[detail.method]) }}</DescriptionsItem>
          <DescriptionsItem :label="$t('shell.settlements.colStatus')">
            <Tag :color="SETTLEMENT_STATUS_COLORS[detail.status]">{{ $t(SETTLEMENT_STATUS_LABEL_KEYS[detail.status]) }}</Tag>
          </DescriptionsItem>
          <DescriptionsItem v-if="detail.cancelReason" :label="$t('shell.settlements.colCancelReason')" :span="2">
            {{ detail.cancelReason }}
          </DescriptionsItem>
        </Descriptions>

        <h4 class="mb-3 mt-6 text-base font-semibold">{{ $t('shell.settlements.itemsSection') }}</h4>
        <Table
          :columns="[
            { dataIndex: 'orderNumber', key: 'orderNumber', title: $t('shell.settlements.itemOrder') },
            { dataIndex: 'payableName', key: 'payableName', title: $t('shell.settlements.itemName') },
            { align: 'right', dataIndex: 'amount', key: 'amount', title: $t('shell.settlements.colAmount') },
            { key: 'confirmed', title: $t('shell.settlements.itemLocked'), width: 100 },
          ]"
          :data-source="detail.items"
          :pagination="false"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'amount'">{{ formatMoney(record.amount) }}</template>
            <template v-else-if="column.key === 'confirmed'">
              {{ record.confirmed ? $t('shell.settlements.itemYes') : $t('shell.settlements.itemNo') }}
            </template>
          </template>
        </Table>

        <div class="mt-6 flex gap-2">
          <Button v-if="detail.status === 'draft'" :loading="actingId === detail.id" type="primary" @click="confirm(detail)">
            {{ $t('shell.settlements.confirm') }}
          </Button>
          <Button v-if="detail.status !== 'cancelled'" danger @click="askCancel(detail)">
            {{ $t('shell.settlements.cancel') }}
          </Button>
        </div>
      </template>
    </Drawer>

    <SettlementCreateModal
      v-model:open="createOpen"
      :supplier-options="supplierOptions"
      @created="onCreated"
      @error="(message) => listError = message"
    />

    <Modal
      :cancel-text="$t('shell.common.cancel')"
      :confirm-loading="cancelling"
      :ok-text="$t('shell.settlements.cancel')"
      :ok-button-props="{ danger: true }"
      :open="cancelTarget !== null"
      :title="$t('shell.settlements.cancelTitle')"
      @cancel="cancelTarget = null"
      @ok="submitCancel"
    >
      <p class="mb-3 text-sm text-muted-foreground">{{ $t('shell.settlements.cancelHint') }}</p>
      <Textarea
        v-model:value="cancelReason"
        :maxlength="500"
        :placeholder="$t('shell.settlements.cancelReasonPlaceholder')"
        :rows="3"
        show-count
      />
    </Modal>
  </Page>
</template>
