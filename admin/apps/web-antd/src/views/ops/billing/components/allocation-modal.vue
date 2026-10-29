<script lang="ts" setup>
import type { BillingErrorView } from '#/api/ops/billing/errors';
import type { Receivable } from '#/api/ops/billing/types';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Empty,
  Input,
  Modal,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  checkAllocations,
  describeBillingError,
  fetchReceivables,
  formatDate,
  formatMoney,
  formatMoneyText,
  parseAmountInput,
  receivableStatusView,
  subtractAmounts,
  sumAmountStrings,
} from '#/api/ops/billing';

defineOptions({ name: 'BillingAllocationModal' });

/**
 * 核销分配（把一笔已审核收款分配到多条应收）。
 *
 * 本弹窗只做「填写 + 前端预校验」，真正的提交由上游走高风险二次确认：
 * - 超额（单期 / 合计）在点「下一步」时就被拦截，不发请求；
 * - 服务端仍可能因并发返回 409，由上游统一提示「余额已变化，请刷新后重试」。
 */
const props = defineProps<{
  currency: string;
  customerId: string;
  customerName: string;
  open: boolean;
  receiptAllocatedAmount: number;
  receiptAmount: number;
  receiptId: null | string;
  receiptNo: string;
}>();

const emit = defineEmits<{
  continue: [
    payload: {
      allocatable: string;
      lines: { amount: number; receivableId: string }[];
      total: string;
    },
  ];
  'update:open': [boolean];
}>();

const candidates = ref<Receivable[]>([]);
const amounts = ref<Record<string, string>>({});
const lineIssues = ref<Record<string, string>>({});
const formIssues = ref<string[]>([]);
const loading = ref(false);
const loadError = ref<BillingErrorView | null>(null);

const allocatableText = computed(() =>
  formatMoneyText(
    subtractAmounts(props.receiptAmount, props.receiptAllocatedAmount),
    props.currency,
  ),
);

const enteredTotal = computed(() =>
  formatMoneyText(
    sumAmountStrings(Object.values(amounts.value)),
    props.currency,
  ),
);

async function loadCandidates() {
  if (!props.customerId) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchReceivables({
      customerId: props.customerId,
      order: 'asc',
      page: 1,
      pageSize: 100,
      sort: 'dueDate',
    });
    // 只能核销同客户、同币种、尚未结清的应收；已结清/已冲销不进入候选
    candidates.value = result.items.filter(
      (item) =>
        item.currency === props.currency &&
        item.customer.id === props.customerId &&
        item.status !== 'paid' &&
        item.status !== 'reversed',
    );
    amounts.value = {};
    lineIssues.value = {};
    formIssues.value = [];
  } catch (error: unknown) {
    loadError.value = describeBillingError(error);
    candidates.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.receiptId] as const,
  ([open]) => {
    if (open) {
      void loadCandidates();
    }
  },
  { immediate: true },
);

function onClose() {
  emit('update:open', false);
}

function onContinue() {
  const lines = candidates.value
    .map((item) => ({
      line: {
        amountInput: (amounts.value[item.id] ?? '').trim(),
        currency: item.currency,
        customerId: item.customer.id,
        outstanding: item.outstanding,
        periodNo: item.periodNo,
        receivableId: item.id,
      },
      receivable: item,
    }))
    .filter((entry) => entry.line.amountInput !== '');

  if (lines.length === 0) {
    formIssues.value = ['请至少为一期应收填写核销金额'];
    lineIssues.value = {};
    return;
  }

  const result = checkAllocations({
    lines: lines.map((entry) => entry.line),
    receiptAllocatedAmount: props.receiptAllocatedAmount,
    receiptAmount: props.receiptAmount,
    receiptCurrency: props.currency,
    receiptCustomerId: props.customerId,
  });

  const issues: Record<string, string> = {};
  for (const issue of result.lineIssues) {
    issues[issue.receivableId] = issue.message;
  }
  lineIssues.value = issues;
  formIssues.value = result.formIssues.map((issue) => issue.message);

  if (!result.ok) {
    return;
  }

  emit('continue', {
    allocatable: result.allocatable,
    lines: lines.map((entry) => {
      const parsed = parseAmountInput(entry.line.amountInput);
      return {
        amount: parsed.ok ? parsed.value : 0,
        receivableId: entry.line.receivableId,
      };
    }),
    total: result.total,
  });
}
</script>

<template>
  <Modal
    :open="open"
    :width="900"
    destroy-on-close
    title="核销分配"
    @cancel="onClose"
  >
    <Alert
      class="mb-3"
      message="分配总额不得超过收款可分配余额，单期不得超过该期未收余额；提交前会先做校验，服务端还会在事务内再次校验（并发超额会被拒绝）。"
      show-icon
      type="info"
    />

    <div class="mb-3 grid gap-2 text-sm md:grid-cols-3">
      <div>
        <span class="text-muted-foreground">收款编号：</span>{{ receiptNo }}
      </div>
      <div>
        <span class="text-muted-foreground">收款金额：</span>
        {{ formatMoney(receiptAmount, currency) }}
      </div>
      <div>
        <span class="text-muted-foreground">可分配余额：</span>
        <span class="font-medium">{{ allocatableText }}</span>
      </div>
      <div>
        <span class="text-muted-foreground">客户：</span>{{ customerName }}
      </div>
      <div>
        <span class="text-muted-foreground">本次录入合计：</span>
        <span class="font-medium">{{ enteredTotal }}</span>
      </div>
      <div class="text-xs text-muted-foreground">
        可分配余额 = 收款金额 −
        已核销净额（前端按服务端字段精确相减，仅用于提示）
      </div>
    </div>

    <Alert v-if="loadError" :message="loadError.title" show-icon type="error">
      <template #description>
        <p>{{ loadError.description }}</p>
        <p v-if="loadError.requestId" class="text-xs">
          请求 ID：<span class="font-mono">{{ loadError.requestId }}</span>
        </p>
        <Button size="small" @click="loadCandidates">重试</Button>
      </template>
    </Alert>

    <Alert
      v-for="(issue, index) in formIssues"
      :key="`form-${index}`"
      class="mb-2"
      :message="issue"
      show-icon
      type="error"
    />

    <Spin :spinning="loading">
      <Table
        :columns="[
          { dataIndex: 'contractNo', key: 'contractNo', title: '合同号' },
          { dataIndex: 'periodNo', key: 'periodNo', title: '期次' },
          { dataIndex: 'dueDate', key: 'dueDate', title: '到期日' },
          { dataIndex: 'outstanding', key: 'outstanding', title: '未收余额' },
          { dataIndex: 'status', key: 'status', title: '状态' },
          { key: 'allocation', title: '本次核销金额' },
        ]"
        :data-source="candidates"
        :pagination="false"
        :row-key="(row: Receivable) => row.id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'dueDate'">
            {{ formatDate(record.dueDate) }}
          </template>
          <template v-else-if="column.key === 'outstanding'">
            {{ formatMoney(record.outstanding, record.currency) }}
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="receivableStatusView(record.status).color">
              {{ receivableStatusView(record.status).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'allocation'">
            <div>
              <Input
                v-model:value="amounts[record.id]"
                :status="lineIssues[record.id] ? 'error' : undefined"
                placeholder="不核销请留空"
                size="small"
                style="width: 140px"
              />
              <p v-if="lineIssues[record.id]" class="mt-1 text-xs text-red-500">
                {{ lineIssues[record.id] }}
              </p>
            </div>
          </template>
        </template>
        <template #emptyText>
          <Empty description="该客户没有可核销的应收（已结清或已冲销）" />
        </template>
      </Table>
    </Spin>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button @click="onClose">取消</Button>
        <Button type="primary" @click="onContinue">下一步：确认核销</Button>
      </div>
    </template>
  </Modal>
</template>
