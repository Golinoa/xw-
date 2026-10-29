<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CustomerDetail, CustomerTag } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import { formatCustomerIdType, formatDateTime } from './customer-display';

const props = defineProps<{
  open: boolean;
  customerId: string | null;
  /** 仅用于控制操作入口；服务端仍会独立校验 customer.write。 */
  canWrite: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  edit: [customer: CustomerDetail];
  deleted: [];
}>();

const auth = useAuthStore();
const detail = ref<CustomerDetail | null>(null);
const loading = ref(false);
const error = ref('');
const deleteOpen = ref(false);
const deleting = ref(false);
const deleteError = ref('');

let requestSeq = 0;

async function load(customerId: string) {
  const seq = ++requestSeq;
  loading.value = true;
  error.value = '';
  try {
    const result = await auth.api.call('getCustomer', { params: { customerId } });
    // 快速切换客户时丢弃过期响应，避免详情串号。
    if (seq !== requestSeq) return;
    detail.value = result.customer;
  } catch (cause) {
    if (seq !== requestSeq) return;
    detail.value = null;
    error.value = cause instanceof ApiClientError ? cause.message : '客户详情加载失败，请稍后重试';
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.customerId] as const,
  ([open, customerId]) => {
    if (!open) {
      detail.value = null;
      error.value = '';
      deleteError.value = '';
      deleteOpen.value = false;
      return;
    }
    if (customerId) void load(customerId);
  },
  { immediate: true },
);

/**
 * 原值只由服务端按权限决定是否下发：有原值才展示原值，否则退回掩码字段。
 * 前端不按角色自行拼接或推断原值。
 */
function sensitiveText(original?: string, masked?: string): string {
  if (original) return original;
  if (masked) return `${masked}（掩码）`;
  return '—';
}

const phoneText = computed(() => {
  const customer = detail.value;
  return customer ? sensitiveText(customer.phone, customer.phoneMasked) : '—';
});

const emailText = computed(() => {
  const customer = detail.value;
  if (!customer) return '—';
  return sensitiveText(customer.email, customer.emailMasked);
});

const idNumberText = computed(() => {
  const customer = detail.value;
  return customer ? sensitiveText(customer.idNumber, customer.idNumberMasked) : '—';
});

const tags = computed<CustomerTag[]>(() => detail.value?.tags ?? []);

function close() {
  emit('update:open', false);
}

function retry() {
  if (props.customerId) void load(props.customerId);
}

function startEdit() {
  if (!detail.value) return;
  emit('edit', detail.value);
}

async function confirmDelete() {
  if (!props.customerId || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await auth.api.call('deleteCustomer', { params: { customerId: props.customerId } });
    deleteOpen.value = false;
    emit('deleted');
    emit('update:open', false);
  } catch (cause) {
    deleteError.value = cause instanceof ApiClientError ? cause.message : '删除失败，请稍后重试';
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <a-drawer :open="open" title="客户详情" width="520" @close="close">
    <div v-if="loading" class="detail-status" role="status">
      <a-spin />
      <p>正在加载客户详情…</p>
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
      <a-descriptions :column="1" size="small" bordered>
        <a-descriptions-item label="姓名">{{ detail.name }}</a-descriptions-item>
        <a-descriptions-item label="电话">{{ phoneText }}</a-descriptions-item>
        <a-descriptions-item label="邮箱">{{ emailText }}</a-descriptions-item>
        <a-descriptions-item label="证件类型">{{
          formatCustomerIdType(detail.idType)
        }}</a-descriptions-item>
        <a-descriptions-item label="证件号">{{ idNumberText }}</a-descriptions-item>
        <a-descriptions-item label="生日">{{ detail.birthday ?? '—' }}</a-descriptions-item>
        <a-descriptions-item label="来源">{{ detail.sourceName ?? '—' }}</a-descriptions-item>
        <a-descriptions-item label="标签">
          <template v-if="tags.length">
            <a-tag
              v-for="tag in tags"
              :key="tag.id"
              :bordered="false"
              :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
            >
              {{ tag.name }}
            </a-tag>
          </template>
          <template v-else>—</template>
        </a-descriptions-item>
        <a-descriptions-item label="备注">
          <span class="detail-remark">{{ detail.remark ?? '—' }}</span>
        </a-descriptions-item>
        <a-descriptions-item label="创建时间">{{
          formatDateTime(detail.createdAt)
        }}</a-descriptions-item>
        <a-descriptions-item label="最近更新">{{
          formatDateTime(detail.updatedAt)
        }}</a-descriptions-item>
        <a-descriptions-item label="版本">{{ detail.version }}</a-descriptions-item>
      </a-descriptions>
      <a-alert
        v-if="canWrite && deleteError"
        class="delete-error"
        type="error"
        show-icon
        :message="deleteError"
      />
    </template>

    <template #extra>
      <a-space v-if="detail && canWrite">
        <a-button @click="startEdit">编辑</a-button>
        <a-button danger @click="deleteOpen = true">删除</a-button>
      </a-space>
    </template>
  </a-drawer>

  <a-modal
    :open="deleteOpen"
    title="确认删除客户"
    ok-text="确认删除"
    cancel-text="取消"
    :confirm-loading="deleting"
    :mask-closable="!deleting"
    :closable="!deleting"
    :ok-button-props="{ danger: true }"
    @ok="confirmDelete"
    @cancel="deleteOpen = false"
  >
    <p>将删除客户「{{ detail?.name }}」。删除后该客户不再出现在客户列表，历史单据仍保留引用。</p>
    <p>当前版本暂不支持自助恢复，请确认后继续。</p>
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

.detail-remark {
  white-space: pre-wrap;
}

.delete-error {
  margin-top: var(--space-16);
}
</style>
