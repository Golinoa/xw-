<script lang="ts" setup>
/**
 * 联系人表单（新增/编辑）。
 *
 * 校验只做格式与必填；「主要联系人唯一」由服务端保证（契约 §3.1 唯一索引 +
 * §5.2「主要联系人冲突时自动降级旧主要」），前端不做本地抢占逻辑。
 */
import { reactive, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Form,
  FormItem,
  Input,
  Space,
  Switch,
} from 'ant-design-vue';

defineOptions({ name: 'CustomerContactForm' });

const props = withDefaults(
  defineProps<{
    initial?: null | {
      email?: null | string;
      isPrimary?: boolean;
      jobTitle?: null | string;
      name?: string;
      phone?: null | string;
      usageScene?: null | string;
    };
    serverMessage?: null | string;
    submitting?: boolean;
  }>(),
  { initial: null, serverMessage: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [values: ContactFormValues];
}>();

/** 表单实例的最小契约（只用到 `validate`）。 */
interface ContactFormRef {
  validate: () => Promise<unknown>;
}

/** 校验规则的最小形状。 */
interface ContactFormRule {
  message?: string;
  pattern?: RegExp;
  required?: boolean;
  trigger?: 'blur' | 'change';
  type?: 'email';
  max?: number;
}

export interface ContactFormValues {
  name: string;
  jobTitle: string;
  phone: string;
  email: string;
  usageScene: string;
  isPrimary: boolean;
}

function emptyValues(): ContactFormValues {
  return {
    email: '',
    isPrimary: false,
    jobTitle: '',
    name: '',
    phone: '',
    usageScene: '',
  };
}

const form = reactive<ContactFormValues>(emptyValues());
const formRef = ref<ContactFormRef>();

watch(
  () => props.initial,
  (value) => {
    Object.assign(form, emptyValues(), {
      email: value?.email ?? '',
      isPrimary: value?.isPrimary ?? false,
      jobTitle: value?.jobTitle ?? '',
      name: value?.name ?? '',
      phone: value?.phone ?? '',
      usageScene: value?.usageScene ?? '',
    });
  },
  { immediate: true },
);

/** 手机号：11 位大陆号码（仅格式校验，不做归属地判断）。 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

const rules: Record<string, ContactFormRule[]> = {
  email: [{ message: '请输入有效的邮箱地址', trigger: 'blur', type: 'email' }],
  name: [
    { message: '请输入联系人姓名', required: true, trigger: 'blur' },
    { max: 60, message: '联系人姓名不超过 60 字', trigger: 'blur' },
  ],
  phone: [
    {
      message: '手机号应为 11 位大陆号码',
      pattern: PHONE_PATTERN,
      trigger: 'blur',
    },
  ],
};

async function handleSubmit() {
  try {
    await formRef.value?.validate();
  } catch {
    // 校验失败：字段级错误已渲染，阻止提交
    return;
  }
  emit('submit', {
    email: form.email.trim(),
    isPrimary: form.isPrimary,
    jobTitle: form.jobTitle.trim(),
    name: form.name.trim(),
    phone: form.phone.trim(),
    usageScene: form.usageScene.trim(),
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
    />

    <Form ref="formRef" layout="vertical" :model="form">
      <FormItem label="姓名" name="name" :rules="rules.name">
        <Input
          v-model:value="form.name"
          :maxlength="60"
          placeholder="联系人姓名"
        />
      </FormItem>
      <FormItem label="职务" name="jobTitle">
        <Input
          v-model:value="form.jobTitle"
          :maxlength="60"
          placeholder="如：信息部经理"
        />
      </FormItem>
      <FormItem label="手机" name="phone" :rules="rules.phone">
        <Input
          v-model:value="form.phone"
          :maxlength="11"
          placeholder="11 位手机号"
        />
      </FormItem>
      <FormItem label="邮箱" name="email" :rules="rules.email">
        <Input v-model:value="form.email" placeholder="name@example.com" />
      </FormItem>
      <FormItem label="使用场景" name="usageScene">
        <Input
          v-model:value="form.usageScene"
          :maxlength="60"
          placeholder="如：日常对接、账款对账"
        />
      </FormItem>
      <FormItem label="设为主要联系人" name="isPrimary">
        <Switch v-model:checked="form.isPrimary" />
      </FormItem>
    </Form>

    <Space>
      <Button :disabled="props.submitting" @click="emit('cancel')">取消</Button>
      <Button type="primary" :loading="props.submitting" @click="handleSubmit">
        保存联系人
      </Button>
    </Space>
  </div>
</template>
