<script lang="ts" setup>
import type { OrderAction, OrderDetail, OrderFinanceSummary } from '@erp/contracts';

import type { ApplicationTarget } from '../../finance/finance-application-form-modal.vue';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Drawer,
  Form,
  FormItem,
  Modal,
  Skeleton,
  Space,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime, formatMoney, formatRatio } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import FinanceApplicationFormModal from '../../finance/finance-application-form-modal.vue';
import {
  availableOrderActions,
  isEditable,
  ORDER_ACTION_EFFECT_KEYS,
  ORDER_ACTION_LABEL_KEYS,
  ORDER_STATUS_LABEL_KEYS,
  ORDER_STATUS_TAG_COLORS,
  ORDER_TYPE_LABEL_KEYS,
  requiresReason,
} from './order-display';
import TouristRosterSection from './tourist-roster-section.vue';

const props = defineProps<{
  /** 发起收付款申请需要 finance.write，与订单编辑是两回事。 */
  canApply: boolean;
  /** 仅控制操作入口；服务端独立校验 order.write。 */
  canWrite: boolean;
  open: boolean;
  orderId: null | string;
  /** 保存/状态迁移响应里的服务端订单：先展示，再后台回读最新版本。 */
  seed: null | OrderDetail;
}>();

const emit = defineEmits<{
  changed: [order: OrderDetail];
  edit: [order: OrderDetail];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const detail = ref<null | OrderDetail>(null);
/** 财务摘要由服务端算，前端只展示，不自己再除一遍。 */
const finance = ref<null | OrderFinanceSummary>(null);
const loading = ref(false);
const error = ref('');

const pendingAction = ref<null | OrderAction>(null);
const reason = ref('');
const transitionError = ref('');
const transitioning = ref(false);

let requestSeq = 0;

/** 财务摘要单独取，失败静默降级为「不显示」：用户至少要能看到订单主体。 */
async function loadFinance(orderId: string, seq: number) {
  try {
    const result = await authStore.api.call('getOrderFinance', { params: { orderId } });
    if (seq !== requestSeq) return;
    finance.value = result.finance;
  } catch {
    if (seq === requestSeq) finance.value = null;
  }
}

async function load(orderId: string) {
  const seq = ++requestSeq;
  loading.value = detail.value === null;
  error.value = '';
  try {
    const result = await authStore.api.call('getOrder', { params: { orderId } });
    if (seq !== requestSeq) return;
    detail.value = result.order;
    finance.value = null;
    void loadFinance(orderId, seq);
  } catch (error_) {
    if (seq !== requestSeq) return;
    const text = error_ instanceof ApiClientError ? error_.message : $t('shell.orders.detailLoadFailed');
    if (detail.value) {
      // 已有内容时只是刷新失败，不把整页变成错误态。
      return;
    }
    error.value = text;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.orderId] as const,
  ([open, orderId]) => {
    if (!open) {
      detail.value = null;
      finance.value = null;
      error.value = '';
      pendingAction.value = null;
      transitionError.value = '';
      reason.value = '';
      return;
    }
    if (!orderId) return;
    const seed = props.seed;
    detail.value = seed && seed.id === orderId ? seed : null;
    if (detail.value) loading.value = false;
    void load(orderId);
  },
  { immediate: true },
);

const actions = computed<readonly OrderAction[]>(() =>
  detail.value ? availableOrderActions(detail.value.status) : [],
);
const editable = computed(() => (detail.value ? isEditable(detail.value.status) : false));

const receivableColumns = computed(() => [
  { title: $t('shell.orders.colName'), dataIndex: 'name', key: 'name' },
  { align: 'right' as const, dataIndex: 'amount', key: 'amount', title: $t('shell.orders.colAmount'), width: 130 },
  { align: 'right' as const, dataIndex: 'confirmedAmount', key: 'confirmedAmount', title: $t('shell.orders.colConfirmed'), width: 130 },
  { align: 'right' as const, dataIndex: 'pendingAmount', key: 'pendingAmount', title: $t('shell.orders.colPending'), width: 130 },
  { align: 'right' as const, dataIndex: 'availableAmount', key: 'availableAmount', title: $t('shell.orders.colApplicable'), width: 140 },
  { key: 'apply', title: $t('shell.orders.colAction'), width: 110 },
]);

const payableColumns = computed(() => [
  { dataIndex: 'supplierName', key: 'supplierName', title: $t('shell.orders.colSupplier'), width: 160 },
  { dataIndex: 'name', key: 'name', title: $t('shell.orders.colName') },
  { align: 'right' as const, dataIndex: 'amount', key: 'amount', title: $t('shell.orders.colAmount'), width: 140 },
  { align: 'right' as const, dataIndex: 'availableAmount', key: 'availableAmount', title: $t('shell.orders.colApplicable'), width: 140 },
  { key: 'apply', title: $t('shell.orders.colAction'), width: 110 },
]);

/** 已取消不再产生资金流动；已锁团仍可收款（尾款出团后结是常态），锁团约束的是改价。 */
const canApplyHere = computed(() => props.canApply && detail.value?.status !== 'cancelled');

const applicationTarget = ref<ApplicationTarget | null>(null);
const applicationOpen = ref(false);

function startApplication(
  kind: 'payment' | 'receipt',
  line: { availableAmount: number; id: string; name: string },
) {
  const order = detail.value;
  if (!order) return;
  applicationTarget.value = {
    availableAmount: line.availableAmount,
    kind,
    lineId: line.id,
    lineName: line.name,
    orderId: order.id,
    orderNumber: order.orderNumber,
  };
  applicationOpen.value = true;
}

/** 申请后在途金额变了，回读订单与摘要；只改本地数字会让上限停在旧值。 */
async function onApplicationCreated() {
  if (props.orderId) await load(props.orderId);
}

function close() {
  emit('update:open', false);
}

function retry() {
  if (props.orderId) void load(props.orderId);
}

function startEdit() {
  if (detail.value) emit('edit', detail.value);
}

function startAction(action: OrderAction) {
  pendingAction.value = action;
  reason.value = '';
  transitionError.value = '';
}

function closeAction() {
  if (transitioning.value) return;
  pendingAction.value = null;
}

async function confirmAction() {
  const action = pendingAction.value;
  const order = detail.value;
  if (!action || !order || transitioning.value) return;

  const trimmed = reason.value.trim();
  if (requiresReason(action) && !trimmed) {
    transitionError.value = $t('shell.orders.reasonRequired');
    return;
  }

  transitioning.value = true;
  transitionError.value = '';
  try {
    const result = await authStore.api.call('transitionOrder', {
      body: { action, version: order.version, ...(trimmed ? { reason: trimmed } : {}) },
      params: { orderId: order.id },
    });
    detail.value = result.order;
    pendingAction.value = null;
    emit('changed', result.order);
  } catch (error_) {
    if (
      error_ instanceof ApiClientError &&
      (error_.code === 'ORDER_STATE_CONFLICT' || error_.code === 'CONFLICT')
    ) {
      // 状态被别人改过：回读最新版本，避免继续展示可点但必然失败的按钮。
      pendingAction.value = null;
      if (props.orderId) await load(props.orderId);
      return;
    }
    transitionError.value =
      error_ instanceof ApiClientError ? error_.message : $t('shell.orders.actionFailed');
  } finally {
    transitioning.value = false;
  }
}

function actionLabel(action: OrderAction): string {
  return $t(ORDER_ACTION_LABEL_KEYS[action]);
}
</script>

<template>
  <Drawer
    :open="open"
    :title="$t('shell.orders.detailTitle')"
    :width="760"
    @close="close"
  >
    <template #extra>
      <Space v-if="detail && canWrite" wrap>
        <Button :disabled="!editable" @click="startEdit">{{ $t('shell.orders.edit') }}</Button>
        <Button
          v-for="action in actions"
          :key="action"
          :danger="action === 'cancel'"
          :type="action === 'confirm' ? 'primary' : 'default'"
          @click="startAction(action)"
        >
          {{ actionLabel(action) }}
        </Button>
      </Space>
    </template>

    <div v-if="loading" class="py-12 text-center text-sm text-muted-foreground" role="status">
      {{ $t('shell.orders.detailLoading') }}
    </div>
    <Alert
      v-else-if="error"
      show-icon
      type="error"
      :message="error"
      :description="$t('shell.orders.detailErrorHint')"
    >
      <template #action>
        <Button size="small" @click="retry">{{ $t('shell.common.retry') }}</Button>
      </template>
    </Alert>
    <template v-else-if="detail">
      <Alert
        v-if="canWrite && !editable"
        class="mb-4"
        show-icon
        type="info"
        :message="$t('shell.orders.notEditable')"
        :description="
          detail.status === 'completed'
            ? $t('shell.orders.lockedHint')
            : $t('shell.orders.cancelledHint')
        "
      />

      <Descriptions :column="2" bordered size="small">
        <DescriptionsItem :label="$t('shell.orders.colOrderNumber')">{{ detail.orderNumber }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colStatus')">
          <Tag :color="ORDER_STATUS_TAG_COLORS[detail.status]">
            {{ $t(ORDER_STATUS_LABEL_KEYS[detail.status]) }}
          </Tag>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colType')">
          {{ $t(ORDER_TYPE_LABEL_KEYS[detail.orderType]) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colCustomer')">{{ detail.customerName }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colRoute')">{{ detail.routeName ?? '—' }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colDates')">
          {{ detail.departureDate ?? '—' }} → {{ detail.returnDate ?? '—' }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colPeople')">
          {{ detail.adultCount }} / {{ detail.childCount }} / {{ detail.personCount }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colReceivableTotal')">
          {{ formatMoney(detail.receivableTotal) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colPayableTotal')">
          {{ formatMoney(detail.payableTotal) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colProfit')">
          <span :class="detail.profit < 0 ? 'text-red-600' : 'text-green-600'">
            {{ formatMoney(detail.profit) }}
          </span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colCreatedAt')">
          {{ formatDateTime(detail.createdAt) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colUpdatedAt')">
          {{ formatDateTime(detail.updatedAt) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colRemark')" :span="2">
          <span class="whitespace-pre-wrap">{{ detail.remark ?? '—' }}</span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colStatusReason')" :span="2">
          {{ detail.statusReason ?? '—' }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.colVersion')">{{ detail.version }}</DescriptionsItem>
      </Descriptions>

      <h4 class="mb-3 mt-6 text-base font-semibold">{{ $t('shell.orders.financeSection') }}</h4>
      <Descriptions v-if="finance" :column="2" bordered size="small">
        <DescriptionsItem :label="$t('shell.orders.finReceivedUncollected')">
          {{ formatMoney(finance.confirmedReceivable) }} / {{ formatMoney(finance.uncollectedAmount) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finPaidUnpaid')">
          {{ formatMoney(finance.confirmedPayable) }} / {{ formatMoney(finance.unpaidAmount) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finCollectionProgress')">
          {{ formatRatio(finance.collectionProgress) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finPaymentProgress')">
          {{ formatRatio(finance.paymentProgress) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finPendingReceivable')">
          {{ formatMoney(finance.pendingReceivable) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finPendingPayable')">
          {{ formatMoney(finance.pendingPayable) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finApplicableReceivable')">
          {{ formatMoney(finance.applicableReceivable) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finApplicablePayable')">
          {{ formatMoney(finance.applicablePayable) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finGrossMargin')">
          <span :class="(finance.grossMargin ?? 0) < 0 ? 'text-red-600' : 'text-green-600'">
            {{ formatRatio(finance.grossMargin) }}
          </span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finRevenuePerPerson')">
          {{ formatMoney(finance.revenuePerPerson) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finNetCashflow')">
          <span :class="finance.netCashflow < 0 ? 'text-red-600' : 'text-green-600'">
            {{ formatMoney(finance.netCashflow) }}
          </span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.orders.finPersonCount')">{{ finance.personCount }}</DescriptionsItem>
      </Descriptions>
      <Skeleton v-else active :paragraph="{ rows: 2 }" />

      <h4 class="mb-3 mt-6 text-base font-semibold">{{ $t('shell.orders.receivablesSection') }}</h4>
      <Table
        :columns="receivableColumns"
        :data-source="detail.receivables"
        :locale="{ emptyText: $t('shell.orders.noReceivables') }"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="['amount', 'confirmedAmount', 'pendingAmount', 'availableAmount'].includes(String(column.key))">
            {{ formatMoney(record[column.dataIndex as keyof typeof record]) }}
          </template>
          <template v-else-if="column.key === 'apply'">
            <Button
              v-if="canApplyHere && record.availableAmount > 0"
              size="small"
              type="link"
              @click="startApplication('receipt', record as { availableAmount: number; id: string; name: string })"
            >
              {{ $t('shell.orders.applyReceipt') }}
            </Button>
            <span v-else class="text-xs text-muted-foreground">
              {{ record.availableAmount > 0 ? '—' : $t('shell.orders.fullAmount') }}
            </span>
          </template>
        </template>
      </Table>

      <h4 class="mb-3 mt-6 text-base font-semibold">{{ $t('shell.orders.payablesSection') }}</h4>
      <Table
        :columns="payableColumns"
        :data-source="detail.payables"
        :locale="{ emptyText: $t('shell.orders.noPayables') }"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="['amount', 'availableAmount'].includes(String(column.key))">
            {{ formatMoney(record[column.dataIndex as keyof typeof record]) }}
          </template>
          <template v-else-if="column.key === 'apply'">
            <Button
              v-if="canApplyHere && record.availableAmount > 0"
              size="small"
              type="link"
              @click="startApplication('payment', record as { availableAmount: number; id: string; name: string })"
            >
              {{ $t('shell.orders.applyPayment') }}
            </Button>
            <span v-else class="text-xs text-muted-foreground">
              {{ record.availableAmount > 0 ? '—' : $t('shell.orders.fullAmount') }}
            </span>
          </template>
        </template>
      </Table>
      <p class="mt-2 text-xs text-muted-foreground">{{ $t('shell.orders.availableNote') }}</p>

      <div class="mt-6">
        <TouristRosterSection
          :can-write="canWrite"
          :order-id="detail.id"
          @changed="() => emit('changed', detail!)"
        />
      </div>
    </template>
  </Drawer>

  <Modal
    :cancel-text="$t('shell.common.cancel')"
    :confirm-loading="transitioning"
    :closable="!transitioning"
    :mask-closable="!transitioning"
    :ok-text="pendingAction ? actionLabel(pendingAction) : $t('shell.common.confirm')"
    :ok-button-props="{ danger: pendingAction === 'cancel' }"
    :open="pendingAction !== null"
    :title="pendingAction ? actionLabel(pendingAction) : ''"
    @cancel="closeAction"
    @ok="confirmAction"
  >
    <template v-if="pendingAction">
      <p class="mb-4">{{ $t(ORDER_ACTION_EFFECT_KEYS[pendingAction]) }}</p>
      <Form layout="vertical">
        <FormItem
          :label="requiresReason(pendingAction) ? $t('shell.orders.reasonRequiredLabel') : $t('shell.orders.reasonOptionalLabel')"
          :required="requiresReason(pendingAction)"
        >
          <Textarea
            v-model:value="reason"
            :maxlength="500"
            :placeholder="requiresReason(pendingAction) ? $t('shell.orders.reasonPlaceholder') : $t('shell.orders.reasonOptionalPlaceholder')"
            :rows="3"
            show-count
          />
        </FormItem>
      </Form>
      <Alert v-if="transitionError" show-icon type="error" :message="transitionError" />
    </template>
  </Modal>

  <FinanceApplicationFormModal
    v-model:open="applicationOpen"
    :target="applicationTarget"
    @created="onApplicationCreated"
  />
</template>
