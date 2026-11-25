<script lang="ts" setup>
import type { PaymentMethod, SettlementCandidate } from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import { PAYMENT_METHODS } from '@erp/contracts';
import {
  Alert,
  Form,
  FormItem,
  InputNumber,
  Modal,
  Select,
  Table,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { PAYMENT_METHOD_LABEL_KEYS } from '../finance-application-display';
import { formatPeriodMonth } from './settlement-display';

/** 下拉项，列表页把已加载的供应商传进来，避免弹窗里再拉一次。 */
interface SupplierOption {
  label: string;
  value: string;
}

const props = defineProps<{
  open: boolean;
  supplierOptions: SupplierOption[];
}>();

const emit = defineEmits<{
  created: [];
  error: [message: string];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const creating = ref(false);
const candidates = ref<SettlementCandidate[]>([]);
const candidatesLoading = ref(false);
const selectedPayableIds = ref<string[]>([]);
const itemAmounts = reactive<Record<string, number>>({});
const createForm = reactive({
  method: 'bank' as PaymentMethod,
  periodMonth: '',
  supplierId: undefined as string | undefined,
});

const methodOptions = computed(() =>
  PAYMENT_METHODS.map((method) => ({
    label: $t(PAYMENT_METHOD_LABEL_KEYS[method]),
    value: method,
  })),
);

/** 只给最近 12 个月 + 未来 1 个月：结算按自然月，不提供任意历史月份的选择困难。 */
const periodOptions = computed(() => {
  const now = new Date();
  const options: SupplierOption[] = [];
  for (let offset = 1; offset >= -12; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const value = `${date.getFullYear()}-${month}`;
    options.push({ label: formatPeriodMonth(value), value });
  }
  return options;
});

const selectedTotal = computed(() =>
  selectedPayableIds.value.reduce((sum, id) => sum + (itemAmounts[id] ?? 0), 0),
);

watch(
  () => [props.open, props.supplierOptions] as const,
  ([open]) => {
    if (!open) return;
    createForm.method = 'bank';
    createForm.periodMonth = periodOptions.value[0]?.value ?? '';
    createForm.supplierId = undefined;
    candidates.value = [];
    selectedPayableIds.value = [];
    for (const key of Object.keys(itemAmounts)) delete itemAmounts[key];
  },
  { immediate: true },
);

watch(
  () => createForm.supplierId,
  (supplierId) => {
    candidates.value = [];
    selectedPayableIds.value = [];
    if (!supplierId) return;
    void loadCandidates(supplierId);
  },
);

async function loadCandidates(supplierId: string) {
  candidatesLoading.value = true;
  try {
    const result = await authStore.api.call('listSettlementCandidates', { body: { supplierId } });
    candidates.value = result.items;
    // 默认金额取「还能结多少」，用户可改；换供应商后勾选全部作废。
    for (const item of result.items) itemAmounts[item.payableId] = item.remainingAmount;
    selectedPayableIds.value = [];
  } catch (error_) {
    candidates.value = [];
    emit('error', error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.loadFailed'));
  } finally {
    candidatesLoading.value = false;
  }
}

async function submitCreate() {
  if (creating.value || !createForm.supplierId || !createForm.periodMonth) return;
  if (selectedPayableIds.value.length === 0) {
    emit('error', $t('shell.settlements.selectItemsRequired'));
    return;
  }
  creating.value = true;
  try {
    await authStore.api.call('createSettlement', {
      body: {
        items: selectedPayableIds.value.map((payableId) => ({
          amount: itemAmounts[payableId] ?? 0,
          payableId,
        })),
        method: createForm.method,
        periodMonth: createForm.periodMonth,
        supplierId: createForm.supplierId,
      },
    });
    emit('created');
    emit('update:open', false);
  } catch (error_) {
    emit('error', error_ instanceof ApiClientError ? error_.message : $t('shell.settlements.createFailed'));
  } finally {
    creating.value = false;
  }
}

function close() {
  if (creating.value) return;
  emit('update:open', false);
}
</script>

<template>
  <Modal
    :cancel-text="$t('shell.common.cancel')"
    :confirm-loading="creating"
    :mask-closable="!creating"
    :ok-text="$t('shell.settlements.create')"
    :open="open"
    :title="$t('shell.settlements.createTitle')"
    @cancel="close"
    @ok="submitCreate"
  >
    <Form layout="vertical">
      <FormItem html-for="settle-supplier" :label="$t('shell.settlements.colSupplier')" required>
        <Select
          id="settle-supplier"
          v-model:value="createForm.supplierId"
          :options="supplierOptions"
          :placeholder="$t('shell.settlements.supplierPlaceholder')"
          show-search
        />
      </FormItem>
      <FormItem html-for="settle-period" :label="$t('shell.settlements.colPeriod')" required>
        <Select
          id="settle-period"
          v-model:value="createForm.periodMonth"
          :loading="candidatesLoading"
          :options="periodOptions"
          :placeholder="$t('shell.settlements.periodPlaceholder')"
        />
      </FormItem>
      <FormItem html-for="settle-method" :label="$t('shell.settlements.colMethod')" required>
        <Select id="settle-method" v-model:value="createForm.method" :options="methodOptions" />
      </FormItem>
    </Form>
    <Alert
      v-if="createForm.supplierId && candidates.length === 0 && !candidatesLoading"
      :message="$t('shell.settlements.noCandidates')"
      show-icon
      type="info"
    />
    <template v-else-if="candidates.length > 0">
      <p class="mb-2 text-sm font-semibold">{{ $t('shell.settlements.candidatesSection') }}</p>
      <Table
        :columns="[
          { dataIndex: 'orderNumber', key: 'orderNumber', title: $t('shell.settlements.itemOrder') },
          { dataIndex: 'payableName', key: 'payableName', title: $t('shell.settlements.itemName') },
          { align: 'right', dataIndex: 'remainingAmount', key: 'remaining', title: $t('shell.settlements.itemRemaining') },
        ]"
        :data-source="candidates"
        :loading="candidatesLoading"
        :pagination="false"
        :row-selection="{ selectedRowKeys: selectedPayableIds, onChange: (keys: (number | string)[]) => selectedPayableIds = keys as string[] }"
        row-key="payableId"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'remaining'">{{ formatMoney(record.remainingAmount) }}</template>
        </template>
      </Table>
      <div class="mt-3 flex items-center gap-2 text-sm">
        <span>{{ $t('shell.settlements.itemAmount') }}</span>
        <InputNumber
          v-for="id in selectedPayableIds"
          :key="id"
          v-model:value="itemAmounts[id]"
          :max="candidates.find((item) => item.payableId === id)?.remainingAmount"
          :min="0.01"
          :precision="2"
          class="w-32"
        />
        <span class="ml-auto font-semibold">
          {{ $t('shell.settlements.selectedTotal', { total: formatMoney(selectedTotal) }) }}
        </span>
      </div>
    </template>
  </Modal>
</template>
