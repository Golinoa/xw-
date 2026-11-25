<script lang="ts" setup>
import type { CustomerDetail, CustomerTag } from '@erp/contracts';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Drawer,
  Modal,
  Space,
  Spin,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { displayText, formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { CUSTOMER_ID_TYPE_LABEL_KEYS } from '../display';

/**
 * 详情抽屉。原值只由服务端按权限决定是否下发，前端不按角色自行拼接或推断。
 *
 * 「删除」按钮的文案必须说实话：B2 之后删除是**软删除**，数据进回收站、
 * 有 `customer.restore` 的同事可以还原。旧页面写「暂不支持自助恢复」是过期口径。
 */
const props = defineProps<{
  canWrite: boolean;
  customerId: null | string;
  open: boolean;
}>();

const emit = defineEmits<{
  deleted: [];
  edit: [customer: CustomerDetail];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
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
    const result = await authStore.api.call('getCustomer', { params: { customerId } });
    // 快速切换客户时丢弃过期响应，避免详情串号。
    if (seq !== requestSeq) return;
    detail.value = result.customer;
  } catch (error_) {
    if (seq !== requestSeq) return;
    detail.value = null;
    error.value =
      error_ instanceof ApiClientError ? error_.message : $t('shell.customers.detailLoadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.customerId] as const,
  ([open, customerId]) => {
    if (!open) {
      requestSeq += 1;
      detail.value = null;
      error.value = '';
      deleteError.value = '';
      deleteOpen.value = false;
      loading.value = false;
      return;
    }
    if (customerId) void load(customerId);
  },
  { immediate: true },
);

/** 有原值就显示原值，否则退回掩码并标注「掩码」，绝不让掩码冒充原值。 */
function sensitiveText(original?: string, masked?: string): string {
  if (original) return original;
  if (masked) return `${masked}${$t('shell.customers.maskedSuffix')}`;
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

const idTypeText = computed(() => {
  const value = detail.value?.idType;
  return value ? $t(CUSTOMER_ID_TYPE_LABEL_KEYS[value]) : '—';
});

const tags = computed<readonly CustomerTag[]>(() => detail.value?.tags ?? []);

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
    await authStore.api.call('deleteCustomer', { params: { customerId: props.customerId } });
    deleteOpen.value = false;
    emit('deleted');
    emit('update:open', false);
  } catch (error_) {
    deleteError.value =
      error_ instanceof ApiClientError ? error_.message : $t('shell.customers.deleteFailed');
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <Drawer
    :open="open"
    :title="$t('shell.customers.detailTitle')"
    :width="520"
    @close="close"
  >
    <div v-if="loading" class="flex items-center justify-center gap-3 py-12 text-sm text-muted-foreground">
      <Spin />
      <span>{{ $t('shell.customers.detailLoading') }}</span>
    </div>
    <Alert
      v-else-if="error"
      show-icon
      type="error"
      :message="error"
      :description="$t('shell.customers.detailErrorHint')"
    >
      <template #action>
        <Button size="small" @click="retry">{{ $t('shell.customers.retry') }}</Button>
      </template>
    </Alert>
    <template v-else-if="detail">
      <Descriptions bordered :column="1" size="small">
        <DescriptionsItem :label="$t('shell.customers.labelName')">{{ detail.name }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelPhone')">{{ phoneText }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelEmail')">{{ emailText }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelIdType')">{{ idTypeText }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelIdNumber')">
          {{ idNumberText }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelBirthday')">
          {{ displayText(detail.birthday) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelSource')">
          {{ displayText(detail.sourceName) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelTags')">
          <Space v-if="tags.length > 0" :size="4" wrap>
            <Tag
              v-for="tag in tags"
              :key="tag.id"
              :bordered="false"
              :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
            >
              {{ tag.name }}
            </Tag>
          </Space>
          <span v-else>—</span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelRemark')">
          <span class="whitespace-pre-wrap">{{ displayText(detail.remark) }}</span>
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelCreatedAt')">
          {{ formatDateTime(detail.createdAt) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelUpdatedAt')">
          {{ formatDateTime(detail.updatedAt) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.customers.labelVersion')">
          {{ detail.version }}
        </DescriptionsItem>
      </Descriptions>
      <Alert
        v-if="canWrite && deleteError"
        class="mt-4"
        show-icon
        type="error"
        :message="deleteError"
      />
    </template>

    <template #extra>
      <Space v-if="detail && canWrite">
        <Button @click="startEdit">{{ $t('shell.customers.edit') }}</Button>
        <Button danger @click="deleteOpen = true">{{ $t('shell.customers.delete') }}</Button>
      </Space>
    </template>
  </Drawer>

  <Modal
    :cancel-text="$t('shell.customers.cancel')"
    :closable="!deleting"
    :confirm-loading="deleting"
    :mask-closable="!deleting"
    :ok-button-props="{ danger: true }"
    :ok-text="$t('shell.customers.deleteConfirm')"
    :open="deleteOpen"
    :title="$t('shell.customers.deleteTitle')"
    @cancel="deleteOpen = false"
    @ok="confirmDelete"
  >
    <p>{{ $t('shell.customers.deleteBody', { name: detail?.name ?? '' }) }}</p>
    <p>{{ $t('shell.customers.deleteRecycleHint') }}</p>
  </Modal>
</template>
