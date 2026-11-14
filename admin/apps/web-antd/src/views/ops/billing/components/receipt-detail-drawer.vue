<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { HighRiskSummary } from '../composables/use-high-risk-action';

import type { BillingErrorView } from '#/api/ops/billing/errors';
import type {
  Receipt,
  ReceiptAllocationLine,
  ReceiptDetail,
} from '#/api/ops/billing/types';

import { computed, ref, watch } from 'vue';

import { useUserStore } from '@vben/stores';

import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  actorName,
  allocateReceipt,
  AMOUNT_ERROR_MESSAGE,
  canAllocateReceipt,
  canRefundReceipt,
  canReverseAllocation,
  canReverseReceipt,
  canReviewReceipt,
  createRefund,
  describeBillingError,
  fetchReceipt,
  formatDate,
  formatDateTime,
  formatMoney,
  methodLabel,
  parseAmountInput,
  receiptStatusView,
  reverseAllocation,
  reverseReceipt,
  transitionReceipt,
} from '#/api/ops/billing';
import { isHighRiskPermission, OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import { useHighRiskAction } from '../composables/use-high-risk-action';
import AllocationModal from './allocation-modal.vue';
import HighRiskModal from './high-risk-modal.vue';

defineOptions({ name: 'BillingReceiptDetailDrawer' });

const props = defineProps<{
  open: boolean;
  receiptId: null | string;
}>();

const emit = defineEmits<{
  changed: [];
  'update:open': [boolean];
}>();

const { hasPermission } = useOpsPermission();
const userStore = useUserStore();

const detail = ref<null | ReceiptDetail>(null);
const loading = ref(false);
const error = ref<BillingErrorView | null>(null);

const receipt = computed<null | Receipt>(() => detail.value?.receipt ?? null);
const currentOperatorId = computed<null | string>(
  () => userStore.userInfo?.userId ?? null,
);

/** 明确区分「已登记未审核（不计入实收）」与「已审核计入实收」。 */
const actualIncomeNote = computed(() => {
  switch (receipt.value?.status) {
    case 'pending_reconcile': {
      return '已计入实收（已审核，待核销）';
    }
    case 'reconciled': {
      return '已计入实收（已审核并核销）';
    }
    case 'recorded': {
      return '未计入实收（已登记，等待登记人以外的运营人员审核）';
    }
    case 'refunded': {
      return '已计入实收后全额退款';
    }
    case 'reversed': {
      return '已冲正，不计入实收';
    }
    default: {
      return '未知状态，请刷新确认';
    }
  }
});

async function load() {
  if (!props.receiptId) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    detail.value = await fetchReceipt(props.receiptId);
  } catch (error_: unknown) {
    detail.value = null;
    error.value = describeBillingError(error_);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.receiptId] as const,
  ([open]) => {
    if (open) {
      void load();
    }
  },
  { immediate: true },
);

// ------------------------------------------------------------------ 动作可用性

const reviewDecision = computed(() =>
  canReviewReceipt({
    currentOperatorId: currentOperatorId.value,
    hasApprovePermission: hasPermission(OPS_PERMISSION.RECEIPT_APPROVE),
    recordedBy: receipt.value?.recordedBy,
    status: receipt.value?.status ?? 'recorded',
  }),
);

const activeAllocations = computed(() =>
  (detail.value?.allocations ?? []).filter(
    (item) => item.amount - (item.reversedAmount ?? 0) > 0,
  ),
);

const allocateDecision = computed(() =>
  canAllocateReceipt({
    hasPermission: hasPermission(OPS_PERMISSION.RECEIPT_RECONCILE),
    status: receipt.value?.status ?? 'recorded',
  }),
);

const reverseDecision = computed(() =>
  canReverseReceipt({
    hasActiveAllocations: activeAllocations.value.length > 0,
    hasPermission: hasPermission(OPS_PERMISSION.RECEIPT_REVERSE),
    status: receipt.value?.status ?? 'recorded',
  }),
);

const refundDecision = computed(() =>
  canRefundReceipt({
    hasPermission: hasPermission(OPS_PERMISSION.RECEIPT_REFUND),
    status: receipt.value?.status ?? 'recorded',
  }),
);

/** 高风险动作一律用 `isHighRiskPermission` 判定，页面不手写动作码字符串。 */
const approveIsHighRisk = isHighRiskPermission(OPS_PERMISSION.RECEIPT_APPROVE);

// ------------------------------------------------------------------ 高风险确认

type PendingAction =
  | {
      allocationId: string;
      amount: number;
      kind: 'reverse_allocation';
      summary: HighRiskSummary;
    }
  | {
      kind: 'allocate';
      lines: { amount: number; receivableId: string }[];
      summary: HighRiskSummary;
    }
  | {
      kind: 'approve' | 'reject' | 'reverse';
      summary: HighRiskSummary;
    }
  | {
      kind: 'refund';
      refund: {
        amount: number;
        externalVoucherRef?: string;
        refundDate: string;
      };
      summary: HighRiskSummary;
    };

const pending = ref<null | PendingAction>(null);

const action = useHighRiskAction<unknown>({
  actionLabel: '账款操作',
  execute: async ({ reason }) => {
    const context = pending.value;
    const current = receipt.value;
    if (!context || !current) {
      throw new Error('缺少待执行动作上下文');
    }
    switch (context.kind) {
      case 'allocate': {
        return allocateReceipt(current.id, {
          allocations: context.lines,
          reason,
        });
      }
      case 'approve': {
        if (current.version === undefined) {
          throw new Error('缺少收款版本号');
        }
        return transitionReceipt(current.id, {
          action: 'approve',
          reason,
          version: current.version,
        });
      }
      case 'refund': {
        return createRefund({
          amount: context.refund.amount,
          reason,
          receiptId: current.id,
          refundDate: context.refund.refundDate,
          ...(context.refund.externalVoucherRef === undefined
            ? {}
            : { externalVoucherRef: context.refund.externalVoucherRef }),
        });
      }
      case 'reject': {
        if (current.version === undefined) {
          throw new Error('缺少收款版本号');
        }
        return transitionReceipt(current.id, {
          action: 'reject',
          reason,
          version: current.version,
        });
      }
      case 'reverse': {
        if (current.version === undefined) {
          throw new Error('缺少收款版本号');
        }
        return reverseReceipt(current.id, { reason, version: current.version });
      }
      case 'reverse_allocation': {
        return reverseAllocation(context.allocationId, {
          amount: context.amount,
          reason,
        });
      }
      default: {
        throw new Error('未知动作');
      }
    }
  },
  onSuccess: async () => {
    message.success('操作已提交');
    pending.value = null;
    await load();
    emit('changed');
  },
});

function requestApprove() {
  const current = receipt.value;
  if (!reviewDecision.value.allowed || !current) {
    message.warning(reviewDecision.value.message ?? '当前不可审核');
    return;
  }
  pending.value = {
    kind: 'approve',
    summary: {
      impact:
        '审核通过后该笔收款计入实收并进入待核销状态；申请人不能审核自己登记的收款。',
      rows: [
        { label: '收款编号', value: current.receiptNo },
        {
          emphasis: true,
          label: '收款金额',
          value: formatMoney(current.amount, current.currency),
        },
        { label: '客户', value: current.customer.name },
        { label: '登记人', value: actorName(current.recordedBy) },
      ],
      title: '审核收款',
    },
  };
  action.prepare(pending.value.summary);
}

function requestReject() {
  const current = receipt.value;
  if (!reviewDecision.value.allowed || !current) {
    message.warning(reviewDecision.value.message ?? '当前不可审核');
    return;
  }
  pending.value = {
    kind: 'reject',
    summary: {
      impact:
        '驳回只写入审计并保留收款记录，不删除数据；登记人可修正后重新登记。',
      rows: [
        { label: '收款编号', value: current.receiptNo },
        {
          emphasis: true,
          label: '收款金额',
          value: formatMoney(current.amount, current.currency),
        },
        { label: '客户', value: current.customer.name },
      ],
      title: '驳回收款',
    },
  };
  action.prepare(pending.value.summary);
}

function requestReverse() {
  const current = receipt.value;
  if (!reverseDecision.value.allowed || !current) {
    message.warning(reverseDecision.value.message ?? '当前不可冲正');
    return;
  }
  pending.value = {
    kind: 'reverse',
    summary: {
      impact:
        '冲正生成反向流水并把收款置为「已冲正」，原收款金额与交易信息保持不变。',
      rows: [
        { label: '收款编号', value: current.receiptNo },
        {
          emphasis: true,
          label: '冲正金额',
          value: formatMoney(current.amount, current.currency),
        },
        { label: '客户', value: current.customer.name },
        { label: '当前状态', value: receiptStatusView(current.status).label },
      ],
      title: '收款冲正',
    },
  };
  action.prepare(pending.value.summary);
}

// ------------------------------------------------------------------ 核销

const allocationOpen = ref(false);

function requestAllocate() {
  if (!allocateDecision.value.allowed) {
    message.warning(allocateDecision.value.message ?? '当前不可核销');
    return;
  }
  allocationOpen.value = true;
}

function onAllocationContinue(payload: {
  allocatable: string;
  lines: { amount: number; receivableId: string }[];
  total: string;
}) {
  const current = receipt.value;
  if (!current) {
    return;
  }
  allocationOpen.value = false;
  pending.value = {
    kind: 'allocate',
    lines: payload.lines,
    summary: {
      impact: `把 ${payload.lines.length} 条应收的核销一次性提交，服务端会在单事务内校验余额并写入核销流水。`,
      rows: [
        { label: '收款编号', value: current.receiptNo },
        { emphasis: true, label: '本次核销合计', value: payload.total },
        { label: '可分配余额', value: payload.allocatable },
        { label: '分配应收条数', value: `${payload.lines.length} 条` },
        { label: '客户', value: current.customer.name },
      ],
      title: '核销分配',
    },
  };
  action.prepare(pending.value.summary);
}

// ------------------------------------------------------------------ 退款登记

const refundOpen = ref(false);
const refundAmount = ref('');
const refundDate = ref<Dayjs>();
const refundVoucher = ref('');
const refundFormError = ref<null | string>(null);

function requestRefund() {
  if (!refundDecision.value.allowed) {
    message.warning(refundDecision.value.message ?? '当前不可登记退款');
    return;
  }
  refundAmount.value = '';
  refundDate.value = undefined;
  refundVoucher.value = '';
  refundFormError.value = null;
  refundOpen.value = true;
}

function submitRefundForm() {
  const current = receipt.value;
  if (!current) {
    return;
  }
  if (!refundDate.value) {
    refundFormError.value = '请选择退款日期';
    return;
  }
  const parsed = parseAmountInput(refundAmount.value);
  if (!parsed.ok) {
    refundFormError.value = AMOUNT_ERROR_MESSAGE[parsed.error];
    return;
  }
  if (parsed.value > current.allocatedAmount) {
    refundFormError.value = `退款金额不能超过可退款净额 ${formatMoney(current.allocatedAmount, current.currency)}`;
    return;
  }
  refundFormError.value = null;
  refundOpen.value = false;
  const voucher = refundVoucher.value.trim();
  const refundDateText = refundDate.value.format('YYYY-MM-DD');
  pending.value = {
    kind: 'refund',
    refund: {
      amount: parsed.value,
      refundDate: refundDateText,
      ...(voucher === '' ? {} : { externalVoucherRef: voucher }),
    },
    summary: {
      impact:
        '登记退款会生成独立退款记录并关联原收款，原收款金额不变；退款需审核后才计入退款事实。',
      rows: [
        { label: '收款编号', value: current.receiptNo },
        {
          emphasis: true,
          label: '本次退款金额',
          value: formatMoney(parsed.value, current.currency),
        },
        { label: '退款日期', value: refundDateText },
        { label: '客户', value: current.customer.name },
        { label: '外部凭证', value: voucher === '' ? '—' : voucher },
      ],
      title: '登记退款',
    },
  };
  action.prepare(pending.value.summary);
}

// ------------------------------------------------------------------ 撤销核销

const reverseAllocationOpen = ref(false);
const reverseAllocationTarget = ref<{
  amount: string;
  id: string;
  max: number;
  periodNo?: number;
}>({ amount: '', id: '', max: 0 });
const reverseAllocationError = ref<null | string>(null);

function requestReverseAllocation(allocation: {
  amount: number;
  id: string;
  receivablePeriodNo?: number;
  reversedAmount?: number;
}) {
  const remaining = allocation.amount - (allocation.reversedAmount ?? 0);
  const decision = canReverseAllocation({
    hasPermission: hasPermission(OPS_PERMISSION.RECEIPT_REVERSE),
    remainingAmount: remaining,
  });
  if (!decision.allowed) {
    message.warning(decision.message ?? '当前不可撤销核销');
    return;
  }
  reverseAllocationTarget.value = {
    amount: String(remaining),
    id: allocation.id,
    max: remaining,
    ...(allocation.receivablePeriodNo === undefined
      ? {}
      : { periodNo: allocation.receivablePeriodNo }),
  };
  reverseAllocationError.value = null;
  reverseAllocationOpen.value = true;
}

function submitReverseAllocation() {
  const target = reverseAllocationTarget.value;
  const current = receipt.value;
  if (!current || target.id === '') {
    return;
  }
  const parsed = parseAmountInput(target.amount);
  if (!parsed.ok) {
    reverseAllocationError.value = AMOUNT_ERROR_MESSAGE[parsed.error];
    return;
  }
  if (parsed.value > target.max) {
    reverseAllocationError.value = `撤销金额不能超过该笔核销的有效金额 ${formatMoney(target.max, current.currency)}`;
    return;
  }
  reverseAllocationError.value = null;
  reverseAllocationOpen.value = false;
  pending.value = {
    allocationId: target.id,
    amount: parsed.value,
    kind: 'reverse_allocation',
    summary: {
      impact:
        '撤销核销会追加反向流水并回滚对应应收的已核销金额，原核销记录保留可追溯。',
      rows: [
        { label: '收款编号', value: current.receiptNo },
        {
          emphasis: true,
          label: '本次撤销金额',
          value: formatMoney(parsed.value, current.currency),
        },
        {
          label: '关联应收期次',
          value:
            target.periodNo === undefined ? '—' : `第 ${target.periodNo} 期`,
        },
      ],
      title: '撤销核销',
    },
  };
  action.prepare(pending.value.summary);
}

function closeDrawer() {
  emit('update:open', false);
}
</script>

<template>
  <Drawer :open="open" :width="920" title="收款详情" @close="closeDrawer">
    <Spin :spinning="loading">
      <Alert
        v-if="error"
        data-testid="receipt-detail-error"
        :message="error.title"
        show-icon
        type="error"
      >
        <template #description>
          <div class="space-y-1">
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
            </p>
            <Button size="small" @click="load">重试</Button>
          </div>
        </template>
      </Alert>

      <template v-if="receipt">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Tag :color="receiptStatusView(receipt.status).color">
            {{ receiptStatusView(receipt.status).label }}
          </Tag>
          <span class="text-sm text-muted-foreground">{{
            actualIncomeNote
          }}</span>
        </div>

        <Descriptions bordered :column="2" size="small" title="收款信息">
          <Descriptions.Item label="收款编号">
            {{ receipt.receiptNo }}
          </Descriptions.Item>
          <Descriptions.Item label="客户">
            {{ receipt.customer.name }}
          </Descriptions.Item>
          <Descriptions.Item label="合同">
            {{ receipt.contractNo ?? '未指定合同' }}
          </Descriptions.Item>
          <Descriptions.Item label="交易日期">
            {{ formatDate(receipt.transactionDate) }}
          </Descriptions.Item>
          <Descriptions.Item label="金额">
            {{ formatMoney(receipt.amount, receipt.currency) }}
          </Descriptions.Item>
          <Descriptions.Item label="已核销净额">
            {{ formatMoney(receipt.allocatedAmount, receipt.currency) }}
          </Descriptions.Item>
          <Descriptions.Item label="收款方式">
            {{ methodLabel(receipt.method) }}
          </Descriptions.Item>
          <Descriptions.Item label="流水号">
            {{ receipt.referenceNo ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="凭证引用">
            {{ receipt.voucherRef ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="登记人">
            {{ actorName(receipt.recordedBy) }}
          </Descriptions.Item>
          <Descriptions.Item label="审核人">
            {{ receipt.approvedBy ? actorName(receipt.approvedBy) : '未审核' }}
          </Descriptions.Item>
          <Descriptions.Item label="审核时间">
            {{ receipt.approvedAt ? formatDateTime(receipt.approvedAt) : '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="登记原因" :span="2">
            {{ receipt.recordedReason ?? '—' }}
          </Descriptions.Item>
        </Descriptions>

        <div class="mt-4 flex flex-wrap gap-2">
          <Tooltip :title="reviewDecision.message ?? ''">
            <span>
              <Button
                :disabled="!reviewDecision.allowed"
                :type="approveIsHighRisk ? 'primary' : 'default'"
                data-testid="receipt-approve"
                @click="requestApprove"
              >
                审核通过
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="reviewDecision.message ?? ''">
            <span>
              <Button
                :disabled="!reviewDecision.allowed"
                danger
                @click="requestReject"
              >
                驳回
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="allocateDecision.message ?? ''">
            <span>
              <Button
                :disabled="!allocateDecision.allowed"
                @click="requestAllocate"
              >
                核销分配
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="refundDecision.message ?? ''">
            <span>
              <Button
                :disabled="!refundDecision.allowed"
                @click="requestRefund"
              >
                登记退款
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="reverseDecision.message ?? ''">
            <span>
              <Button
                :disabled="!reverseDecision.allowed"
                danger
                @click="requestReverse"
              >
                收款冲正
              </Button>
            </span>
          </Tooltip>
        </div>
        <p
          v-if="
            !reviewDecision.allowed &&
            reviewDecision.code === 'segregation_of_duty'
          "
          class="mt-2 text-xs text-orange-600"
          data-testid="receipt-sod-note"
        >
          {{ reviewDecision.message }}
        </p>

        <div class="mt-6">
          <h4 class="mb-2 font-medium">核销分配明细</h4>
          <Table
            :columns="[
              { dataIndex: 'receivableId', key: 'receivableId', title: '应收' },
              { dataIndex: 'amount', key: 'amount', title: '核销金额' },
              {
                dataIndex: 'reversedAmount',
                key: 'reversedAmount',
                title: '已撤销',
              },
              { dataIndex: 'allocatedBy', key: 'allocatedBy', title: '操作者' },
              { dataIndex: 'allocatedAt', key: 'allocatedAt', title: '时间' },
              { key: 'actions', title: '操作' },
            ]"
            :data-source="detail?.allocations ?? []"
            :pagination="false"
            :row-key="(row: { id: string }) => row.id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'receivableId'">
                第 {{ record.receivablePeriodNo ?? '—' }} 期
                <span class="text-xs text-muted-foreground">
                  （{{ formatDate(record.receivableDueDate) }} 到期）
                </span>
              </template>
              <template v-else-if="column.key === 'amount'">
                {{ formatMoney(record.amount, receipt.currency) }}
              </template>
              <template v-else-if="column.key === 'reversedAmount'">
                {{ formatMoney(record.reversedAmount ?? 0, receipt.currency) }}
              </template>
              <template v-else-if="column.key === 'allocatedBy'">
                {{ actorName(record.allocatedBy) }}
              </template>
              <template v-else-if="column.key === 'allocatedAt'">
                {{ formatDateTime(record.allocatedAt) }}
              </template>
              <template v-else-if="column.key === 'actions'">
                <Button
                  :disabled="!hasPermission(OPS_PERMISSION.RECEIPT_REVERSE)"
                  danger
                  size="small"
                  type="link"
                  @click="
                    requestReverseAllocation(record as ReceiptAllocationLine)
                  "
                >
                  撤销核销
                </Button>
              </template>
            </template>
            <template #emptyText>
              <Empty description="暂无核销记录" />
            </template>
          </Table>
        </div>

        <div class="mt-6">
          <h4 class="mb-2 font-medium">冲正与撤销流水</h4>
          <Alert
            class="mb-2"
            :message="`原收款金额 ${formatMoney(receipt.amount, receipt.currency)} 保持不变；冲正与撤销以独立反向流水记录，并关联原收款 ${receipt.receiptNo}`"
            show-icon
            type="info"
          />
          <Table
            :columns="[
              { dataIndex: 'type', key: 'type', title: '类型' },
              { dataIndex: 'amount', key: 'amount', title: '金额' },
              { dataIndex: 'reason', key: 'reason', title: '原因' },
              { dataIndex: 'createdBy', key: 'createdBy', title: '操作者' },
              { dataIndex: 'createdAt', key: 'createdAt', title: '时间' },
              {
                dataIndex: 'allocationId',
                key: 'allocationId',
                title: '关联对象',
              },
            ]"
            :data-source="detail?.reversals ?? []"
            :pagination="false"
            :row-key="(row: { id: string }) => row.id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'type'">
                {{
                  record.type === 'receipt_reversal' ? '收款冲正' : '撤销核销'
                }}
              </template>
              <template v-else-if="column.key === 'amount'">
                {{ formatMoney(record.amount, receipt.currency) }}
              </template>
              <template v-else-if="column.key === 'createdBy'">
                {{ actorName(record.createdBy) }}
              </template>
              <template v-else-if="column.key === 'createdAt'">
                {{ formatDateTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'allocationId'">
                原收款 {{ receipt.receiptNo }}
                <span
                  v-if="record.allocationId"
                  class="text-xs text-muted-foreground"
                >
                  / 核销流水 {{ String(record.allocationId).slice(0, 8) }}
                </span>
              </template>
            </template>
            <template #emptyText>
              <Empty description="暂无冲正记录（原始收款未被修改）" />
            </template>
          </Table>
        </div>

        <div class="mt-6">
          <h4 class="mb-2 font-medium">关联退款</h4>
          <Table
            :columns="[
              { dataIndex: 'refundNo', key: 'refundNo', title: '退款编号' },
              { dataIndex: 'amount', key: 'amount', title: '金额' },
              { dataIndex: 'refundDate', key: 'refundDate', title: '退款日期' },
              { dataIndex: 'status', key: 'status', title: '状态' },
              { dataIndex: 'reason', key: 'reason', title: '原因' },
            ]"
            :data-source="detail?.refunds ?? []"
            :pagination="false"
            :row-key="(row: { id: string }) => row.id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'amount'">
                {{ formatMoney(record.amount, receipt.currency) }}
              </template>
              <template v-else-if="column.key === 'refundDate'">
                {{ formatDate(record.refundDate) }}
              </template>
            </template>
            <template #emptyText>
              <Empty description="暂无退款记录" />
            </template>
          </Table>
        </div>
      </template>
    </Spin>

    <AllocationModal
      v-if="receipt"
      :open="allocationOpen"
      :currency="receipt.currency"
      :customer-id="receipt.customer.id"
      :customer-name="receipt.customer.name"
      :receipt-allocated-amount="receipt.allocatedAmount"
      :receipt-amount="receipt.amount"
      :receipt-id="receipt.id"
      :receipt-no="receipt.receiptNo"
      @continue="onAllocationContinue"
      @update:open="allocationOpen = $event"
    />

    <HighRiskModal
      :action-label="pending?.summary.title ?? '账款操作'"
      :error="action.error.value"
      :open="action.open.value"
      :reason="action.reason.value"
      :reason-error="action.reasonError.value"
      :submitting="action.submitting.value"
      :summary="pending?.summary ?? null"
      confirm-text="确认执行"
      @confirm="action.confirm()"
      @update:open="action.open.value = $event"
      @update:reason="action.reason.value = $event"
    />

    <!-- 退款登记表单 -->
    <Modal
      v-model:open="refundOpen"
      :mask-closable="false"
      ok-text="下一步：确认"
      title="登记退款"
      @ok="submitRefundForm"
    >
      <Alert
        class="mb-3"
        message="首期不调用支付渠道发起退款，只登记线下退款事实；退款记录会关联原收款。"
        show-icon
        type="info"
      />
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            退款金额（可退款净额上限
            {{ formatMoney(receipt?.allocatedAmount, receipt?.currency) }}）
          </div>
          <Input v-model:value="refundAmount" placeholder="如 5000.00" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">退款日期</div>
          <DatePicker v-model:value="refundDate" style="width: 100%" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">外部退款凭证引用</div>
          <Input
            v-model:value="refundVoucher"
            placeholder="银行回单号等，可空"
          />
        </div>
        <Alert
          v-if="refundFormError"
          :message="refundFormError"
          show-icon
          type="error"
        />
      </div>
    </Modal>

    <!-- 撤销核销金额 -->
    <Modal
      v-model:open="reverseAllocationOpen"
      :mask-closable="false"
      ok-text="下一步：确认"
      title="撤销核销"
      @ok="submitReverseAllocation"
    >
      <div class="space-y-3">
        <div>
          <div class="mb-1 text-xs text-muted-foreground">
            本次撤销金额（上限
            {{ formatMoney(reverseAllocationTarget?.max, receipt?.currency) }}）
          </div>
          <Input v-model:value="reverseAllocationTarget.amount" />
        </div>
        <Alert
          message="撤销核销会追加反向流水并回滚应收已核销额，不会删除原核销记录。"
          show-icon
          type="info"
        />
        <Alert
          v-if="reverseAllocationError"
          :message="reverseAllocationError"
          show-icon
          type="error"
        />
      </div>
    </Modal>
  </Drawer>
</template>
