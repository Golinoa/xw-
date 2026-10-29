<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { OrderAction, OrderDetail } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import {
  ORDER_ACTION_EFFECTS,
  ORDER_ACTION_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_TAG_COLORS,
  ORDER_TYPE_LABELS,
  availableOrderActions,
  requiresReason,
} from './order-display';

const props = defineProps<{
  open: boolean;
  orderId: string | null;
  /** 仅用于控制操作入口；服务端仍会独立校验 order.write。 */
  canWrite: boolean;
  /** 保存/状态迁移响应里的服务端订单：先立即展示，再后台回读一次确保是最新版本。 */
  seed: OrderDetail | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  edit: [order: OrderDetail];
  /** 状态变化后通知列表刷新。 */
  changed: [order: OrderDetail];
}>();

const auth = useAuthStore();
const detail = ref<OrderDetail | null>(null);
const loading = ref(false);
const error = ref('');

const pendingAction = ref<OrderAction | null>(null);
const reason = ref('');
const transitionError = ref('');
const transitioning = ref(false);

let requestSeq = 0;

async function load(orderId: string) {
  const seq = ++requestSeq;
  // 已有服务端返回的订单时不要整页转圈，只做静默刷新。
  loading.value = detail.value === null;
  error.value = '';
  try {
    const result = await auth.api.call('getOrder', { params: { orderId } });
    // 快速切换订单时丢弃过期响应，避免详情串号。
    if (seq !== requestSeq) return;
    detail.value = result.order;
  } catch (cause) {
    if (seq !== requestSeq) return;
    const text = cause instanceof ApiClientError ? cause.message : '订单详情加载失败，请稍后重试';
    if (detail.value) {
      message.warning(`详情刷新失败：${text}`);
    } else {
      // 失败不能渲染成「订单不存在」，否则用户会误以为订单被删了。
      error.value = text;
    }
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.orderId] as const,
  ([open, orderId]) => {
    if (!open) {
      detail.value = null;
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

/** 已锁团与已取消的订单在服务端禁止编辑（会返回 ORDER_STATE_CONFLICT），入口同步禁用。 */
const editable = computed(
  () =>
    detail.value !== null &&
    (detail.value.status === 'booking' || detail.value.status === 'active'),
);

const receivableColumns = [
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '金额', dataIndex: 'amount', key: 'amount', width: 130, align: 'right' },
  {
    title: '已确认',
    dataIndex: 'confirmedAmount',
    key: 'confirmedAmount',
    width: 130,
    align: 'right',
  },
  { title: '待确认', dataIndex: 'pendingAmount', key: 'pendingAmount', width: 130, align: 'right' },
  {
    title: '可申请余额',
    dataIndex: 'availableAmount',
    key: 'availableAmount',
    width: 140,
    align: 'right',
  },
];

const payableColumns = [
  { title: '供应商', dataIndex: 'supplierName', key: 'supplierName', width: 160 },
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '金额', dataIndex: 'amount', key: 'amount', width: 140, align: 'right' },
  {
    title: '可申请余额',
    dataIndex: 'availableAmount',
    key: 'availableAmount',
    width: 140,
    align: 'right',
  },
];

function close() {
  emit('update:open', false);
}

function retry() {
  if (props.orderId) void load(props.orderId);
}

function startEdit() {
  if (!detail.value) return;
  emit('edit', detail.value);
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
    transitionError.value = '请填写操作原因';
    return;
  }

  transitioning.value = true;
  transitionError.value = '';
  try {
    const result = await auth.api.call('transitionOrder', {
      params: { orderId: order.id },
      body: {
        action,
        version: order.version,
        ...(trimmed ? { reason: trimmed } : {}),
      },
    });
    detail.value = result.order;
    pendingAction.value = null;
    message.success(`已${ORDER_ACTION_LABELS[action]}`);
    emit('changed', result.order);
  } catch (cause) {
    if (cause instanceof ApiClientError && cause.code === 'ORDER_STATE_CONFLICT') {
      // 状态被别人改过：先告知，再回读最新版本，避免继续展示可点但必然失败的动作。
      message.warning('状态已变化，请刷新');
      pendingAction.value = null;
      if (props.orderId) await load(props.orderId);
      return;
    }
    if (cause instanceof ApiClientError && cause.code === 'CONFLICT') {
      message.error('数据已被他人修改');
      pendingAction.value = null;
      if (props.orderId) await load(props.orderId);
      return;
    }
    transitionError.value =
      cause instanceof ApiClientError ? cause.message : '操作失败，请稍后重试';
  } finally {
    transitioning.value = false;
  }
}
</script>

<template>
  <a-drawer :open="open" title="订单详情" width="760" @close="close">
    <div v-if="loading" class="detail-status" role="status">
      <a-spin />
      <p>正在加载订单详情…</p>
    </div>
    <a-alert
      v-else-if="error"
      type="error"
      show-icon
      :message="error"
      description="详情没有加载成功，请重试。"
    >
      <template #action>
        <a-button size="small" @click="retry">重试</a-button>
      </template>
    </a-alert>
    <template v-else-if="detail">
      <a-alert
        v-if="canWrite && !editable"
        class="detail-hint"
        type="info"
        show-icon
        message="当前状态下订单不可编辑"
        :description="
          detail.status === 'completed'
            ? '订单已锁团，需要先执行「解锁」才能修改客户、线路与金额。'
            : '订单已取消，需要先执行「恢复订单」才能修改。'
        "
      />

      <a-descriptions :column="2" size="small" bordered>
        <a-descriptions-item label="订单号">{{ detail.orderNumber }}</a-descriptions-item>
        <a-descriptions-item label="状态">
          <a-tag :bordered="false" :color="ORDER_STATUS_TAG_COLORS[detail.status]">
            {{ ORDER_STATUS_LABELS[detail.status] }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="订单类型">
          {{ ORDER_TYPE_LABELS[detail.orderType] }}
        </a-descriptions-item>
        <a-descriptions-item label="客户">{{ detail.customerName }}</a-descriptions-item>
        <a-descriptions-item label="线路">{{ detail.routeName ?? '—' }}</a-descriptions-item>
        <a-descriptions-item label="出团 / 回团">
          {{ detail.departureDate ?? '—' }} → {{ detail.returnDate ?? '—' }}
        </a-descriptions-item>
        <a-descriptions-item label="成人 / 儿童 / 总人数">
          {{ detail.adultCount }} / {{ detail.childCount }} / {{ detail.personCount }}
        </a-descriptions-item>
        <a-descriptions-item label="应收合计">
          {{ formatMoney(detail.receivableTotal) }}
        </a-descriptions-item>
        <a-descriptions-item label="应付合计">
          {{ formatMoney(detail.payableTotal) }}
        </a-descriptions-item>
        <a-descriptions-item label="利润">
          <span :class="detail.profit < 0 ? 'profit-neg' : 'profit-pos'">{{
            formatMoney(detail.profit)
          }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="创建时间">
          {{ formatDateTime(detail.createdAt) }}
        </a-descriptions-item>
        <a-descriptions-item label="最近更新">
          {{ formatDateTime(detail.updatedAt) }}
        </a-descriptions-item>
        <a-descriptions-item label="备注" :span="2">
          <span class="detail-remark">{{ detail.remark ?? '—' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="最近状态说明" :span="2">
          {{ detail.statusReason ?? '—' }}
        </a-descriptions-item>
        <a-descriptions-item label="版本">{{ detail.version }}</a-descriptions-item>
      </a-descriptions>

      <h4 class="section-title">应收明细</h4>
      <a-table
        row-key="id"
        size="small"
        :columns="receivableColumns"
        :data-source="detail.receivables"
        :pagination="false"
        :locale="{ emptyText: '暂无应收明细' }"
      >
        <template #bodyCell="{ column, record }">
          <template
            v-if="
              column.key === 'amount' ||
              column.key === 'confirmedAmount' ||
              column.key === 'pendingAmount' ||
              column.key === 'availableAmount'
            "
          >
            {{ formatMoney(record[column.dataIndex]) }}
          </template>
        </template>
      </a-table>

      <h4 class="section-title">应付明细</h4>
      <a-table
        row-key="id"
        size="small"
        :columns="payableColumns"
        :data-source="detail.payables"
        :pagination="false"
        :locale="{ emptyText: '暂无应付明细' }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'amount' || column.key === 'availableAmount'">
            {{ formatMoney(record[column.dataIndex]) }}
          </template>
        </template>
      </a-table>
      <p class="detail-note">
        「可申请余额」直接取服务端计算值（金额 − 已确认 − 待确认），前端不做减法。
      </p>
    </template>

    <template #extra>
      <a-space v-if="detail && canWrite" wrap>
        <a-button :disabled="!editable" @click="startEdit">编辑</a-button>
        <a-button
          v-for="action in actions"
          :key="action"
          :type="action === 'confirm' ? 'primary' : 'default'"
          :danger="action === 'cancel'"
          @click="startAction(action)"
        >
          {{ ORDER_ACTION_LABELS[action] }}
        </a-button>
      </a-space>
    </template>
  </a-drawer>

  <a-modal
    :open="pendingAction !== null"
    :title="pendingAction ? ORDER_ACTION_LABELS[pendingAction] : ''"
    :ok-text="pendingAction ? ORDER_ACTION_LABELS[pendingAction] : '确定'"
    cancel-text="取消"
    :confirm-loading="transitioning"
    :mask-closable="!transitioning"
    :closable="!transitioning"
    :ok-button-props="{ danger: pendingAction === 'cancel' }"
    @ok="confirmAction"
    @cancel="closeAction"
  >
    <template v-if="pendingAction">
      <p class="action-effect">{{ ORDER_ACTION_EFFECTS[pendingAction] }}</p>
      <a-form layout="vertical">
        <a-form-item
          :label="requiresReason(pendingAction) ? '操作原因（必填）' : '操作原因（选填）'"
          :required="requiresReason(pendingAction)"
        >
          <a-textarea
            v-model:value="reason"
            :maxlength="500"
            :rows="3"
            show-count
            :placeholder="
              requiresReason(pendingAction) ? '请说明本次操作原因，会记录在订单上' : '可留空'
            "
          />
        </a-form-item>
      </a-form>
      <a-alert v-if="transitionError" type="error" show-icon :message="transitionError" />
    </template>
  </a-modal>
</template>

<style scoped>
.detail-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-12);
  padding: var(--space-48) 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.detail-hint {
  margin-bottom: var(--space-16);
}

.detail-remark {
  white-space: pre-wrap;
}

.section-title {
  margin: var(--space-24) 0 var(--space-12);
  color: var(--color-heading);
  font-size: var(--font-size-md);
  font-weight: 600;
}

.detail-note {
  margin: var(--space-8) 0 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
}

.profit-pos {
  color: var(--color-success-text);
}

.profit-neg {
  color: var(--color-error-text);
}

.action-effect {
  margin-bottom: var(--space-16);
  color: var(--color-text);
}
</style>
