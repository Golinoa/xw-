<script lang="ts" setup>
import type { ContactFormValues } from './components/contact-form.vue';
import type { CustomerFormValues } from './components/customer-form.vue';

import type { OpsApiError } from '#/api/adapter/errors';
import type {
  CustomerContact,
  CustomerDetail,
  CustomerTransitionAction,
} from '#/api/ops/customer';

/**
 * 客户详情：档案、联系人、关联概览与状态迁移。
 *
 * 状态迁移只能走 `POST /customers/{id}/transition`（契约 §3.1），并要求携带 `version`；
 * 终止前展示关联事实摘要，被引用时后端返回 409 `OBJECT_REFERENCED`，页面保留原因输入。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Input,
  message,
  Modal,
  Result,
  Space,
  Spin,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createCustomerContact,
  deleteCustomerContact,
  fetchCustomer,
  transitionCustomer,
  updateCustomer,
  updateCustomerContact,
} from '#/api/ops/customer';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import ContactForm from './components/contact-form.vue';
import ContactTable from './components/contact-table.vue';
import CustomerForm from './components/customer-form.vue';
import OpsDevDataNotice from './components/ops-dev-data-notice.vue';
import OpsErrorAlert from './components/ops-error-alert.vue';
import OpsPermissionDenied from './components/ops-permission-denied.vue';
import {
  CUSTOMER_ACTION_LABEL,
  CUSTOMER_ALLOWED_ACTIONS,
  CUSTOMER_REASON_REQUIRED,
  customerStatusColor,
  customerStatusLabel,
  displayText,
  formatDateTime,
} from './format';

defineOptions({ name: 'CustomerDetail' });

const route = useRoute();
const router = useRouter();
const { hasPermission } = useOpsPermission();

const customerId = computed(() => String(route.params.customerId ?? ''));

const canRead = computed(() => hasPermission(OPS_PERMISSION.CUSTOMER_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CUSTOMER_WRITE));
const canReadSensitive = computed(() =>
  hasPermission(OPS_PERMISSION.CUSTOMER_SENSITIVE_READ),
);

const detail = ref<CustomerDetail | null>(null);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    detail.value = await fetchCustomer(customerId.value);
  } catch (error_) {
    error.value = toOpsApiError(error_);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

const availableActions = computed<CustomerTransitionAction[]>(() => {
  const status = detail.value?.customer.status;
  if (!status) {
    return [];
  }
  return CUSTOMER_ALLOWED_ACTIONS[status] ?? [];
});

/** 终态客户不再提供任何写操作入口（契约 §3.1：仅可读取）。 */
const isTerminal = computed(
  () => detail.value?.customer.status === 'terminated',
);

/* ---------------- 编辑档案 ---------------- */

const editDrawer = reactive<{ open: boolean }>({ open: false });
const editSubmitting = ref(false);
const editServerMessage = ref<null | string>(null);

function openEdit() {
  editServerMessage.value = null;
  editDrawer.open = true;
}

/** 客户档案 → 表单值：把 `null` 统一映射为空串，避免把 `null` 当成已填值。 */
const editInitial = computed<null | Partial<CustomerFormValues>>(() => {
  const customer = detail.value?.customer;
  if (!customer) {
    return null;
  }
  return {
    internalNote: customer.internalNote ?? '',
    name: customer.name,
    regionCode: customer.regionCode ?? '',
    sourceNote: customer.sourceNote ?? '',
    unifiedSocialCreditCode: customer.unifiedSocialCreditCode ?? '',
  };
});

async function submitEdit(values: CustomerFormValues) {
  if (!detail.value) {
    return;
  }
  editSubmitting.value = true;
  editServerMessage.value = null;
  try {
    await updateCustomer(customerId.value, {
      internalNote: values.internalNote,
      name: values.name,
      regionCode: values.regionCode,
      sourceNote: values.sourceNote,
      unifiedSocialCreditCode: values.unifiedSocialCreditCode,
      version: detail.value.customer.version,
    });
    editDrawer.open = false;
    message.success('客户档案已更新');
    await load();
  } catch (error_) {
    // 409：版本冲突，保留用户输入；400：字段级校验
    editServerMessage.value = toOpsApiError(error_).displayMessage;
  } finally {
    editSubmitting.value = false;
  }
}

/* ---------------- 状态迁移 ---------------- */

const transition = reactive<{
  action: CustomerTransitionAction;
  confirmed: boolean;
  errorMessage: null | string;
  open: boolean;
  reason: string;
  submitting: boolean;
}>({
  action: 'suspend',
  confirmed: false,
  errorMessage: null,
  open: false,
  reason: '',
  submitting: false,
});

function openTransition(action: CustomerTransitionAction) {
  transition.open = true;
  transition.action = action;
  transition.reason = '';
  transition.confirmed = false;
  transition.errorMessage = null;
}

const isDestructive = computed(() => transition.action === 'terminate');

async function submitTransition() {
  if (!detail.value) {
    return;
  }
  const needsReason = CUSTOMER_REASON_REQUIRED.has(transition.action);
  if (needsReason && transition.reason.trim() === '') {
    transition.errorMessage = '该操作必须填写原因';
    return;
  }
  if (isDestructive.value && !transition.confirmed) {
    transition.errorMessage = '请先确认影响摘要';
    return;
  }
  transition.submitting = true;
  transition.errorMessage = null;
  try {
    const result = await transitionCustomer(customerId.value, {
      action: transition.action,
      reason: transition.reason.trim(),
      version: detail.value.customer.version,
    });
    transition.open = false;
    message.success(
      `已完成：${CUSTOMER_ACTION_LABEL[transition.action]}（版本 v${result.customer.version}）`,
    );
    await load();
  } catch (error_) {
    transition.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    transition.submitting = false;
  }
}

/* ---------------- 联系人 ---------------- */

const contactModal = reactive<{
  editing: CustomerContact | null;
  errorMessage: null | string;
  open: boolean;
  submitting: boolean;
}>({
  editing: null,
  errorMessage: null,
  open: false,
  submitting: false,
});

function openContactCreate() {
  contactModal.editing = null;
  contactModal.errorMessage = null;
  contactModal.open = true;
}

const contactInitial = computed(() =>
  contactModal.editing
    ? {
        email: contactModal.editing.email,
        isPrimary: contactModal.editing.isPrimary,
        jobTitle: contactModal.editing.jobTitle,
        name: contactModal.editing.name,
        phone: contactModal.editing.phone,
        usageScene: contactModal.editing.usageScene,
      }
    : null,
);

async function submitContact(values: ContactFormValues) {
  contactModal.submitting = true;
  contactModal.errorMessage = null;
  try {
    await (contactModal.editing
      ? updateCustomerContact(customerId.value, contactModal.editing.id, {
          email: values.email || undefined,
          isPrimary: values.isPrimary,
          jobTitle: values.jobTitle || undefined,
          name: values.name,
          phone: values.phone || undefined,
          usageScene: values.usageScene || undefined,
          version: contactModal.editing.version,
        })
      : createCustomerContact(customerId.value, {
          email: values.email || undefined,
          isPrimary: values.isPrimary,
          jobTitle: values.jobTitle || undefined,
          name: values.name,
          phone: values.phone || undefined,
          usageScene: values.usageScene || undefined,
        }));
    contactModal.open = false;
    message.success('联系人已保存');
    await load();
  } catch (error_) {
    contactModal.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    contactModal.submitting = false;
  }
}

function confirmDeleteContact(contact: CustomerContact) {
  Modal.confirm({
    content: `删除后不可恢复；若删的是唯一主要联系人，后端会拒绝（契约 §5.2）。`,
    okButtonProps: { danger: true },
    okText: '删除联系人',
    onOk: async () => {
      try {
        await deleteCustomerContact(customerId.value, contact.id);
        message.success('联系人已删除');
        await load();
      } catch (error_) {
        message.error(toOpsApiError(error_).displayMessage);
        // 让 Modal 保持打开，便于用户看到失败原因
        throw error_;
      }
    },
    title: `确认删除联系人「${contact.name}」？`,
  });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CUSTOMER_READ]"
      title="软件客户"
    />

    <template v-else>
      <div class="mb-3 flex items-center justify-between">
        <Space>
          <Button @click="router.push({ name: 'CustomerList' })">
            返回列表
          </Button>
          <span class="text-lg font-medium">客户详情</span>
        </Space>
        <Button v-if="canWrite && !isTerminal" type="primary" @click="openEdit">
          编辑档案
        </Button>
      </div>

      <Card v-if="loading" class="mb-4">
        <div class="flex justify-center py-10"><Spin /></div>
      </Card>

      <OpsErrorAlert
        v-else-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Result
        v-else-if="!detail"
        status="404"
        title="客户不存在或已被移除"
        sub-title="可能是链接有误，或该客户已不在当前运营范围内。"
      />

      <template v-else>
        <Card class="mb-4" :title="detail.customer.name">
          <template #extra>
            <Space>
              <Tag :color="customerStatusColor(detail.customer.status)">
                {{ customerStatusLabel(detail.customer.status) }}
              </Tag>
              <span class="text-xs text-muted-foreground">
                版本 v{{ detail.customer.version }}
              </span>
            </Space>
          </template>

          <div
            class="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 xl:grid-cols-3"
          >
            <div>
              <span class="text-muted-foreground">客户编号：</span>
              {{ detail.customer.customerNo }}
            </div>
            <div>
              <span class="text-muted-foreground">负责人：</span>
              {{ displayText(detail.customer.owner?.displayName) }}
            </div>
            <div>
              <span class="text-muted-foreground">地区码：</span>
              {{ displayText(detail.customer.regionCode) }}
            </div>
            <div>
              <span class="text-muted-foreground">统一社会信用代码：</span>
              {{ displayText(detail.customer.unifiedSocialCreditCode) }}
            </div>
            <div>
              <span class="text-muted-foreground">来源说明：</span>
              {{ displayText(detail.customer.sourceNote) }}
            </div>
            <div>
              <span class="text-muted-foreground">创建时间：</span>
              {{ formatDateTime(detail.customer.createdAt) }}
            </div>
            <div class="md:col-span-2 xl:col-span-3">
              <span class="text-muted-foreground">内部备注：</span>
              {{ displayText(detail.customer.internalNote) }}
            </div>
            <div
              v-if="detail.customer.archiveReason"
              class="md:col-span-2 xl:col-span-3"
            >
              <span class="text-muted-foreground">归档原因：</span>
              {{ detail.customer.archiveReason }}
            </div>
          </div>

          <div v-if="canWrite" class="mt-5 flex flex-wrap gap-2">
            <Button
              v-for="action in availableActions"
              :key="action"
              :danger="action === 'terminate'"
              @click="openTransition(action)"
            >
              {{ CUSTOMER_ACTION_LABEL[action] }}
            </Button>
            <span
              v-if="availableActions.length === 0"
              class="text-xs text-muted-foreground"
            >
              当前状态没有可执行的迁移动作。
            </span>
          </div>
          <div v-else class="mt-5 text-xs text-muted-foreground">
            当前账号无
            customer.write，状态迁移入口已隐藏（授权仍由服务端判定）。
          </div>
        </Card>

        <Card class="mb-4" title="关联概览">
          <div
            class="grid grid-cols-2 gap-3 text-sm md:grid-cols-3 xl:grid-cols-6"
          >
            <div>合同：{{ detail.counts.contracts }}</div>
            <div>应收：{{ detail.counts.receivables }}</div>
            <div>订阅：{{ detail.counts.subscriptions }}</div>
            <div>授权：{{ detail.counts.licenses }}</div>
            <div>部署实例：{{ detail.counts.deployments }}</div>
            <div>工单：{{ detail.counts.tickets }}</div>
          </div>
          <p class="mt-3 text-xs text-muted-foreground">
            客户状态与合同、账款和租户状态彼此独立，这里的计数只用于影响预览（PRD
            §6.2）。
          </p>
        </Card>

        <Card title="联系人">
          <ContactTable
            :contacts="detail.contacts"
            :can-read-sensitive="canReadSensitive"
            :can-write="canWrite && !isTerminal"
            :loading="loading"
            @add="openContactCreate"
            @edit="
              (contact) => {
                contactModal.editing = contact;
                contactModal.errorMessage = null;
                contactModal.open = true;
              }
            "
            @delete="confirmDeleteContact"
          />
        </Card>
      </template>
    </template>

    <Drawer
      v-model:open="editDrawer.open"
      title="编辑客户档案"
      width="480"
      destroy-on-close
    >
      <CustomerForm
        :initial="editInitial"
        :server-message="editServerMessage"
        :submitting="editSubmitting"
        submit-text="保存修改"
        @cancel="editDrawer.open = false"
        @submit="submitEdit"
      />
    </Drawer>

    <Modal
      v-model:open="transition.open"
      :title="CUSTOMER_ACTION_LABEL[transition.action]"
      :ok-text="isDestructive ? '确认终止' : '确认'"
      cancel-text="取消"
      :ok-button-props="isDestructive ? { danger: true } : {}"
      :confirm-loading="transition.submitting"
      @ok="submitTransition"
    >
      <Alert
        v-if="isDestructive"
        class="mb-3"
        type="warning"
        show-icon
        message="终止后该客户进入终态，不可物理删除也无法恢复（契约 §3.1）"
        :description="`仍有关联合同/授权/工单/部署时后端会拒绝（409 OBJECT_REFERENCED）。当前计数：合同 ${detail?.counts.contracts ?? 0}、订阅 ${detail?.counts.subscriptions ?? 0}、授权 ${detail?.counts.licenses ?? 0}、部署 ${detail?.counts.deployments ?? 0}、工单 ${detail?.counts.tickets ?? 0}。`"
      />

      <OpsErrorAlert
        v-if="transition.errorMessage"
        :message="transition.errorMessage"
        :retryable="false"
      />

      <label class="mb-1 block text-sm" for="transition-reason">
        原因{{
          CUSTOMER_REASON_REQUIRED.has(transition.action)
            ? '（必填，写入审计）'
            : '（选填）'
        }}
      </label>
      <Input.TextArea
        id="transition-reason"
        v-model:value="transition.reason"
        :maxlength="200"
        :rows="3"
        placeholder="说明本次状态变更的业务原因"
      />

      <Checkbox
        v-if="isDestructive"
        v-model:checked="transition.confirmed"
        class="mt-3"
      >
        我已确认上述影响摘要
      </Checkbox>
    </Modal>

    <Modal
      v-model:open="contactModal.open"
      :title="contactModal.editing ? '编辑联系人' : '新增联系人'"
      :footer="null"
      :width="520"
      destroy-on-close
    >
      <ContactForm
        :initial="contactInitial"
        :server-message="contactModal.errorMessage"
        :submitting="contactModal.submitting"
        @cancel="contactModal.open = false"
        @submit="submitContact"
      />
    </Modal>
  </div>
</template>
