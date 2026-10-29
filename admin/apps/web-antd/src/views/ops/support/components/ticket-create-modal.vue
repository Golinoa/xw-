<script lang="ts" setup>
import type {
  CreateTicketInput,
  TicketErrorView,
  TicketPriority,
} from '#/api/ops/support';

import { computed, ref, watch } from 'vue';

import { Alert, Input, Modal, Select, Tag } from 'ant-design-vue';

import { TICKET_PRIORITY_OPTIONS } from '#/api/ops/support';

import { useCustomerOptions } from '../composables/use-customer-options';

defineOptions({ name: 'SupportTicketCreateModal' });

/**
 * 新建工单（契约 §5.8 `POST /tickets`，`ticket.create`，幂等必填）。
 *
 * 问题类型：契约 §3.8 是 `text`（PRD §6.9「问题类型配置可扩展」→ `ops.dictionaries`），
 * 没有固定枚举，因此这里用可输入的下拉（预置 PRD 列出的五类作为建议值），
 * 不把某一版枚举写死进前端。
 *
 * 关联对象（合同/租户/部署）不在建单时强填：契约允许后续用
 * `POST /tickets/{id}/references` 补齐，详情页提供该入口。
 */
const props = withDefaults(
  defineProps<{
    error: null | TicketErrorView;
    open: boolean;
    submitting?: boolean;
  }>(),
  { submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [payload: CreateTicketInput];
}>();

const ISSUE_TYPE_SUGGESTIONS = [
  '使用咨询',
  '故障反馈',
  '数据/权限问题',
  '部署/升级问题',
  '合同/授权咨询',
];

const {
  ensureLoaded: ensureCustomerOptions,
  error: customerError,
  loading: customerLoading,
  options: customerOptionList,
  search: searchCustomer,
} = useCustomerOptions();

const customerId = ref<string | undefined>(undefined);
const subject = ref('');
const description = ref('');
const issueType = ref('使用咨询');
const priority = ref<TicketPriority>('normal');
const errors = ref<
  Partial<
    Record<'customerId' | 'description' | 'issueType' | 'subject', string>
  >
>({});

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    customerId.value = undefined;
    subject.value = '';
    description.value = '';
    issueType.value = '使用咨询';
    priority.value = 'normal';
    errors.value = {};
    void ensureCustomerOptions();
  },
);

const priorityOptions = TICKET_PRIORITY_OPTIONS;

const issueTypeOptions = computed(() =>
  ISSUE_TYPE_SUGGESTIONS.map((value) => ({ label: value, value })),
);

function onOk() {
  if (props.submitting) {
    return;
  }
  const selectedCustomerId = customerId.value;
  const next: typeof errors.value = {};
  if (!selectedCustomerId) {
    next.customerId = '工单必须关联一个客户（契约 §3.8：至少关联客户）';
  }
  if (subject.value.trim() === '') {
    next.subject = '请填写工单主题';
  }
  if (description.value.trim() === '') {
    next.description = '请填写问题描述，便于接手人理解上下文';
  }
  if (issueType.value.trim() === '') {
    next.issueType = '请填写问题类型';
  }
  if (Object.keys(next).length > 0 || !selectedCustomerId) {
    errors.value = next;
    return;
  }
  errors.value = {};
  emit('submit', {
    customerId: selectedCustomerId,
    description: description.value.trim(),
    issueType: issueType.value.trim(),
    priority: priority.value,
    subject: subject.value.trim(),
  });
}

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('cancel');
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    ok-text="创建工单"
    :open="open"
    title="新建工单"
    :width="620"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm">客户</span><Tag color="orange">必填</Tag>
        </div>
        <Select
          v-model:value="customerId"
          class="w-full"
          data-testid="ticket-create-customer"
          :filter-option="false"
          :loading="customerLoading"
          :options="customerOptionList"
          placeholder="按客户名称/编号搜索"
          show-search
          :status="errors.customerId ? 'error' : undefined"
          @search="searchCustomer"
        />
        <p v-if="errors.customerId" class="mt-1 text-xs text-red-500">
          {{ errors.customerId }}
        </p>
        <p v-else-if="customerError" class="mt-1 text-xs text-red-500">
          {{ customerError }}
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm">主题</span><Tag color="orange">必填</Tag>
        </div>
        <Input
          v-model:value="subject"
          :maxlength="120"
          placeholder="一句话说明问题，例如：发票抬头修改"
          :status="errors.subject ? 'error' : undefined"
        />
        <p v-if="errors.subject" class="mt-1 text-xs text-red-500">
          {{ errors.subject }}
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm">问题描述</span><Tag color="orange">必填</Tag>
        </div>
        <Input.TextArea
          v-model:value="description"
          :maxlength="2000"
          :rows="4"
          placeholder="写清现象、发生时间、客户诉求；后续处理说明请走时间线备注"
          show-count
          :status="errors.description ? 'error' : undefined"
        />
        <p v-if="errors.description" class="mt-1 text-xs text-red-500">
          {{ errors.description }}
        </p>
      </div>

      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div class="mb-1 flex items-center gap-2">
            <span class="text-sm">问题类型</span><Tag color="orange">必填</Tag>
          </div>
          <Select
            v-model:value="issueType"
            class="w-full"
            :options="issueTypeOptions"
            show-search
            :status="errors.issueType ? 'error' : undefined"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            类型由字典配置（PRD §6.9「问题类型可扩展」），可直接输入新值
          </p>
        </div>

        <div>
          <div class="mb-1 text-sm">优先级</div>
          <Select
            v-model:value="priority"
            class="w-full"
            :options="priorityOptions"
          />
        </div>
      </div>

      <Alert
        message="创建后状态为「待受理」，需要分派给具体负责人（ticket.assign）才会进入处理流程"
        show-icon
        type="info"
      />

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <p>{{ error.description }}</p>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
