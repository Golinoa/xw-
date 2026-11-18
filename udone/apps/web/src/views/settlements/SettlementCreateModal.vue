<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  moneySchema,
  type PaymentMethod,
  type SettlementBatchDetail,
  type SettlementCandidate,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { useSupplierOptions, filterSupplierOption } from '../suppliers/supplier-options';
import { PAYMENT_METHOD_OPTIONS } from '../finance/finance-application-display';

/**
 * 新建结算批次（草稿）。
 *
 * 明细一次全部提交：批次总额是明细之和，分两步写就会出现「有批次没明细」的半截数据。
 * 提交后进入「二次确认」——草稿本身不锁额度，确认才锁。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [boolean]; created: [SettlementBatchDetail] }>();

const auth = useAuthStore();
const suppliers = useSupplierOptions();

const supplierId = ref<string | undefined>();
const periodMonth = ref<string>();
const method = ref<PaymentMethod>('bank');
const note = ref('');
const selected = ref<string[]>([]);
const amounts = reactive<Record<string, number>>({});
const candidates = ref<SettlementCandidate[]>([]);
const candidateStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
const candidateError = ref('');
const submitting = ref(false);

/** 只给最近 12 个月 + 未来 1 个月：结算按自然月，不提供任意历史月份的选择困难。 */
const periodOptions = computed(() => {
  const now = new Date();
  const options: Array<{ value: string; label: string }> = [];
  for (let offset = 1; offset >= -12; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    options.push({ value, label: value.replace('-', ' 年 ') + ' 月' });
  }
  return options;
});

const rows = computed(() => candidates.value);
const selectedTotal = computed(() =>
  selected.value.reduce((sum, payableId) => sum + (amounts[payableId] ?? 0), 0),
);

async function loadCandidates() {
  if (!supplierId.value) {
    candidates.value = [];
    candidateStatus.value = 'idle';
    return;
  }
  candidateStatus.value = 'loading';
  candidateError.value = '';
  try {
    const result = await auth.api.call('listSettlementCandidates', {
      body: { supplierId: supplierId.value },
    });
    candidates.value = result.items;
    for (const item of result.items) {
      if (amounts[item.payableId] === undefined) amounts[item.payableId] = item.remainingAmount;
    }
    // 换供应商后原来的勾选全部作废，否则会把别家的应付行提交进去（服务端会拒，但没必要跑一趟）。
    selected.value = [];
    candidateStatus.value = 'ready';
  } catch (cause) {
    candidates.value = [];
    candidateStatus.value = 'error';
    candidateError.value = cause instanceof ApiClientError ? cause.message : '待结算项加载失败';
  }
}

watch(supplierId, loadCandidates);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    selected.value = [];
    note.value = '';
    if (!periodMonth.value) periodMonth.value = periodOptions.value[0]?.value;
    void suppliers.load();
    if (supplierId.value) void loadCandidates();
  },
);

const selectedRowKeys = computed({
  get: () => selected.value,
  set: (keys: string[]) => {
    selected.value = keys;
  },
});

const rowSelection = computed(() => ({
  selectedRowKeys: selectedRowKeys.value,
  onChange: (keys: Array<string | number>) => {
    selectedRowKeys.value = keys.map(String);
  },
}));

const columns = [
  { title: '订单号', dataIndex: 'orderNumber', key: 'orderNumber', width: 150 },
  { title: '应付项目', dataIndex: 'payableName', key: 'payableName' },
  { title: '应付金额', dataIndex: 'payableAmount', key: 'payableAmount', width: 120 },
  { title: '已结算', dataIndex: 'settledAmount', key: 'settledAmount', width: 110 },
  { title: '可结算', dataIndex: 'remainingAmount', key: 'remainingAmount', width: 110 },
  { title: '本次结算', key: 'amount', width: 150 },
];

function amountError(payableId: string): string {
  const amount = amounts[payableId];
  const candidate = candidates.value.find((item) => item.payableId === payableId);
  if (amount === undefined || candidate === undefined) return '';
  if (amount <= 0) return '金额必须大于 0';
  if (amount > candidate.remainingAmount) return '不能超过可结算金额';
  if (!moneySchema.safeParse(amount).success) return '最多两位小数';
  return '';
}

const canSubmit = computed(
  () =>
    Boolean(supplierId.value) &&
    Boolean(periodMonth.value) &&
    selected.value.length > 0 &&
    selected.value.every((payableId) => amountError(payableId) === '') &&
    !submitting.value,
);

async function submit() {
  if (!canSubmit.value || !supplierId.value || !periodMonth.value) return;
  submitting.value = true;
  try {
    const result = await auth.api.call('createSettlement', {
      body: {
        supplierId: supplierId.value,
        periodMonth: periodMonth.value,
        method: method.value,
        ...(note.value.trim() ? { note: note.value.trim() } : {}),
        items: selected.value.map((payableId) => ({ payableId, amount: amounts[payableId] ?? 0 })),
      },
    });
    message.success('已保存为草稿，核对无误后再确认');
    emit('created', result.settlement);
    emit('update:open', false);
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '保存结算批次失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    title="新建结算批次"
    width="920px"
    :confirm-loading="submitting"
    ok-text="保存为草稿"
    cancel-text="取消"
    :ok-button-props="{ disabled: !canSubmit }"
    @ok="submit"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical">
      <a-row :gutter="16">
        <a-col :span="8">
          <a-form-item label="供应商" required>
            <a-select
              v-model:value="supplierId"
              show-search
              placeholder="选择供应商"
              :filter-option="filterSupplierOption"
              :loading="suppliers.loading.value"
              :options="suppliers.options.value"
            />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="结算月份" required>
            <a-select v-model:value="periodMonth" :options="periodOptions" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="结算方式" required>
            <a-select v-model:value="method" :options="PAYMENT_METHOD_OPTIONS" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="备注">
        <a-input v-model:value="note" :maxlength="500" placeholder="选填" />
      </a-form-item>
    </a-form>

    <a-alert
      v-if="!supplierId"
      type="info"
      show-icon
      message="先在左侧选择供应商，下面会列出这家供应商还没结清的应付明细。"
    />
    <a-alert
      v-else-if="candidateStatus === 'error'"
      type="error"
      show-icon
      :message="candidateError"
      description="待结算项没有加载成功，此时提交会漏掉应付明细。"
    />
    <a-alert
      v-else-if="candidateStatus === 'ready' && rows.length === 0"
      type="success"
      show-icon
      message="这家供应商没有待结算的应付明细（全部已结清）。"
    />
    <a-table
      v-else
      row-key="payableId"
      size="small"
      :columns="columns"
      :data-source="rows"
      :pagination="false"
      :loading="candidateStatus === 'loading'"
      :row-selection="rowSelection"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'payableAmount'">
          {{ formatMoney(record.payableAmount) }}
        </template>
        <template v-else-if="column.key === 'settledAmount'">
          {{ formatMoney(record.settledAmount) }}
        </template>
        <template v-else-if="column.key === 'remainingAmount'">
          {{ formatMoney(record.remainingAmount) }}
        </template>
        <template v-else-if="column.key === 'amount'">
          <a-input-number
            v-model:value="amounts[record.payableId]"
            :min="0"
            :max="record.remainingAmount"
            :precision="2"
            :disabled="!selected.includes(record.payableId)"
            size="small"
            style="width: 100%"
          />
          <span
            v-if="selected.includes(record.payableId) && amountError(record.payableId)"
            class="amount-error"
          >
            {{ amountError(record.payableId) }}
          </span>
        </template>
      </template>
    </a-table>

    <div v-if="selected.length > 0" class="summary">
      已选 {{ selected.length }} 笔，合计 <strong>{{ formatMoney(selectedTotal) }}</strong>
    </div>
  </a-modal>
</template>

<style scoped>
.summary {
  margin-top: var(--space-12);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
  text-align: right;
}

.amount-error {
  color: var(--color-error-text);
  font-size: var(--font-size-xs);
}
</style>
