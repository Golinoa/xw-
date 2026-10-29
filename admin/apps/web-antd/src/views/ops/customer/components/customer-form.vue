<script lang="ts" setup>
/**
 * 客户新建/编辑表单。
 *
 * 校验只在客户端做「格式与必填」；唯一性、编号、重复档案提示一律由服务端返回
 * （PRD §6.2：名称/信用代码只做重复提示，不自动合并）。
 *
 * 409 冲突时父组件通过 `serverMessage` 回传可读文案，本组件**不清空**已填内容，
 * 让用户补改后重试（实施计划全局约束：冲突保留输入）。
 */
import { reactive, ref, watch } from 'vue';

import { Alert, Button, Form, FormItem, Input, Space } from 'ant-design-vue';

defineOptions({ name: 'CustomerForm' });

const props = withDefaults(
  defineProps<{
    /** 编辑时传入当前值；新建时为 null */
    initial?: null | Partial<CustomerFormValues>;
    /** 服务端返回的可读文案（409 冲突 / 400 校验） */
    serverMessage?: null | string;
    submitText?: string;
    submitting?: boolean;
  }>(),
  {
    initial: null,
    serverMessage: null,
    submitText: '保存',
    submitting: false,
  },
);

const emit = defineEmits<{
  cancel: [];
  submit: [values: CustomerFormValues];
}>();

/**
 * 表单实例的最小契约（antd-vue 只暴露 `ComponentPublicInstance`，
 * 这里按实际调用面声明，避免把整个组件类型带进业务代码）。
 */
interface CustomerFormRef {
  validate: () => Promise<unknown>;
}

/** 校验规则的最小形状；`trigger`/`type` 用字面量联合，避免被推断成 `string`。 */
interface CustomerFormRule {
  message?: string;
  pattern?: RegExp;
  required?: boolean;
  trigger?: 'blur' | 'change';
  type?: 'email';
  max?: number;
}

export interface CustomerFormValues {
  name: string;
  unifiedSocialCreditCode: string;
  regionCode: string;
  sourceNote: string;
  internalNote: string;
}

function emptyValues(): CustomerFormValues {
  return {
    internalNote: '',
    name: '',
    regionCode: '',
    sourceNote: '',
    unifiedSocialCreditCode: '',
  };
}

const form = reactive<CustomerFormValues>(emptyValues());
const formRef = ref<CustomerFormRef>();

watch(
  () => props.initial,
  (value) => {
    Object.assign(form, emptyValues(), {
      internalNote: value?.internalNote ?? '',
      name: value?.name ?? '',
      regionCode: value?.regionCode ?? '',
      sourceNote: value?.sourceNote ?? '',
      unifiedSocialCreditCode: value?.unifiedSocialCreditCode ?? '',
    });
  },
  { immediate: true },
);

/** 统一社会信用代码：18 位数字/大写字母（PRD 未强制，仅格式校验，可留空）。 */
const CREDIT_CODE_PATTERN = /^[0-9A-Z]{18}$/;
/** 地区码：GB/T 2260 六位行政区划码（契约 §11 U-16）。 */
const REGION_CODE_PATTERN = /^\d{6}$/;

const rules: Record<string, CustomerFormRule[]> = {
  internalNote: [
    { max: 500, message: '内部备注不超过 500 字', trigger: 'blur' },
  ],
  name: [
    { message: '请输入客户企业名称', required: true, trigger: 'blur' },
    { max: 120, message: '客户名称不超过 120 字', trigger: 'blur' },
  ],
  regionCode: [
    {
      message: '地区码为 6 位数字（GB/T 2260）',
      pattern: REGION_CODE_PATTERN,
      trigger: 'blur',
    },
  ],
  sourceNote: [{ max: 200, message: '来源说明不超过 200 字', trigger: 'blur' }],
  unifiedSocialCreditCode: [
    {
      message: '统一社会信用代码为 18 位数字或大写字母',
      pattern: CREDIT_CODE_PATTERN,
      trigger: 'blur',
    },
  ],
};

async function handleSubmit() {
  try {
    await formRef.value?.validate();
  } catch {
    // 校验失败：antd 已在字段下方标出原因并定位到字段，这里只需阻止提交
    return;
  }
  emit('submit', {
    internalNote: form.internalNote.trim(),
    name: form.name.trim(),
    regionCode: form.regionCode.trim(),
    sourceNote: form.sourceNote.trim(),
    unifiedSocialCreditCode: form.unifiedSocialCreditCode.trim(),
  });
}
</script>

<template>
  <div>
    <Alert
      v-if="props.serverMessage"
      class="mb-4"
      type="error"
      show-icon
      :message="props.serverMessage"
      description="已保留你填写的内容，请按提示修改后重试；如提示版本冲突，请刷新页面后重新编辑。"
    />

    <Form
      ref="formRef"
      layout="vertical"
      :model="form"
      @submit.prevent="handleSubmit"
    >
      <FormItem label="客户企业名称" name="name" :rules="rules.name">
        <Input
          v-model:value="form.name"
          allow-clear
          placeholder="例如：示例旅行社甲"
          :maxlength="120"
        />
      </FormItem>

      <FormItem
        label="统一社会信用代码"
        name="unifiedSocialCreditCode"
        :rules="rules.unifiedSocialCreditCode"
      >
        <Input
          v-model:value="form.unifiedSocialCreditCode"
          allow-clear
          placeholder="18 位，客户提供时填写"
          :maxlength="18"
        />
      </FormItem>

      <FormItem label="地区码" name="regionCode" :rules="rules.regionCode">
        <Input
          v-model:value="form.regionCode"
          allow-clear
          placeholder="GB/T 2260 六位行政区划码，如 310000"
          :maxlength="6"
        />
      </FormItem>

      <FormItem label="来源说明" name="sourceNote" :rules="rules.sourceNote">
        <Input
          v-model:value="form.sourceNote"
          allow-clear
          placeholder="例如：行业展会、老客户转介绍"
          :maxlength="200"
        />
      </FormItem>

      <FormItem
        label="内部备注"
        name="internalNote"
        :rules="rules.internalNote"
      >
        <Input.TextArea
          v-model:value="form.internalNote"
          :maxlength="500"
          :rows="3"
          show-count
          placeholder="仅内部可见，不对外展示"
        />
      </FormItem>
    </Form>

    <Space class="mt-2">
      <Button :disabled="props.submitting" @click="emit('cancel')">取消</Button>
      <Button type="primary" :loading="props.submitting" @click="handleSubmit">
        {{ props.submitText }}
      </Button>
    </Space>
  </div>
</template>
