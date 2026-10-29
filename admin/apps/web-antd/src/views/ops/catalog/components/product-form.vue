<script lang="ts" setup>
/**
 * 产品表单（新建/编辑）。
 *
 * 校验：编码必填且符合 `A-Z0-9-` 约定、名称必填、至少开放一种销售方式
 * （未开放的销售方式在后端签约时会被拒绝，契约 §3.2）。
 * 唯一性（编码重复 → 409 `CONFLICT`）由服务端判定，页面保留用户输入。
 */
import { reactive, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Checkbox,
  Form,
  FormItem,
  Input,
  Space,
} from 'ant-design-vue';

defineOptions({ name: 'CatalogProductForm' });

const props = withDefaults(
  defineProps<{
    /** 编辑态编码不可改（编码是产品的稳定标识） */
    codeReadonly?: boolean;
    initial?: null | {
      code?: string;
      description?: null | string;
      name?: string;
      salesModes?: { isEnabled: boolean; mode: 'private' | 'saas' }[];
    };
    serverMessage?: null | string;
    submitText?: string;
    submitting?: boolean;
  }>(),
  {
    codeReadonly: false,
    initial: null,
    serverMessage: null,
    submitText: '保存',
    submitting: false,
  },
);

const emit = defineEmits<{
  cancel: [];
  submit: [values: ProductFormValues];
}>();

export interface ProductFormValues {
  code: string;
  name: string;
  description: string;
  saasEnabled: boolean;
  privateEnabled: boolean;
}

interface ProductFormRef {
  validate: () => Promise<unknown>;
}

interface ProductFormRule {
  max?: number;
  message?: string;
  pattern?: RegExp;
  required?: boolean;
  trigger?: 'blur' | 'change';
}

const form = reactive<ProductFormValues>({
  code: '',
  description: '',
  name: '',
  privateEnabled: false,
  saasEnabled: true,
});

const formRef = ref<ProductFormRef>();
const modeError = ref('');

watch(
  () => props.initial,
  (value) => {
    // 新建态（initial 为 null）保留默认值，避免把默认开启的 SaaS 覆盖为关闭
    if (!value) {
      return;
    }
    const modes = value.salesModes ?? [];
    form.code = value?.code ?? '';
    form.description = value?.description ?? '';
    form.name = value?.name ?? '';
    form.saasEnabled = modes.some(
      (item) => item.mode === 'saas' && item.isEnabled,
    );
    form.privateEnabled = modes.some(
      (item) => item.mode === 'private' && item.isEnabled,
    );
  },
  { immediate: true },
);

/** 产品编码：大写字母、数字与连字符，3–32 位。 */
const CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;

const rules: Record<string, ProductFormRule[]> = {
  code: [
    { message: '请输入产品编码', required: true, trigger: 'blur' },
    {
      message: '编码只能包含大写字母、数字与连字符（3–32 位）',
      pattern: CODE_PATTERN,
      trigger: 'blur',
    },
  ],
  description: [{ max: 200, message: '描述不超过 200 字', trigger: 'blur' }],
  name: [
    { message: '请输入产品名称', required: true, trigger: 'blur' },
    { max: 80, message: '产品名称不超过 80 字', trigger: 'blur' },
  ],
};

async function handleSubmit() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (!form.saasEnabled && !form.privateEnabled) {
    modeError.value = '至少开放一种销售方式（SaaS 或私有化）';
    return;
  }
  modeError.value = '';
  emit('submit', {
    code: form.code.trim(),
    description: form.description.trim(),
    name: form.name.trim(),
    privateEnabled: form.privateEnabled,
    saasEnabled: form.saasEnabled,
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
      description="已保留你填写的内容，请修改后重试。"
    />

    <Form ref="formRef" layout="vertical" :model="form">
      <FormItem label="产品编码" name="code" :rules="rules.code">
        <Input
          v-model:value="form.code"
          :disabled="props.codeReadonly"
          :maxlength="32"
          placeholder="例如 OPS-SAAS-CORE（创建后不可修改）"
        />
      </FormItem>

      <FormItem label="产品名称" name="name" :rules="rules.name">
        <Input
          v-model:value="form.name"
          :maxlength="80"
          placeholder="对外展示的产品名称"
        />
      </FormItem>

      <FormItem label="产品描述" name="description" :rules="rules.description">
        <Input.TextArea
          v-model:value="form.description"
          :maxlength="200"
          :rows="3"
          placeholder="一两句话说明产品定位"
        />
      </FormItem>

      <FormItem label="可销售方式" required>
        <Space direction="vertical">
          <Checkbox v-model:checked="form.saasEnabled">
            SaaS（多租户订阅）
          </Checkbox>
          <Checkbox v-model:checked="form.privateEnabled">
            私有化（客户环境部署）
          </Checkbox>
        </Space>
        <p v-if="modeError" class="mt-1 text-xs text-red-500">
          {{ modeError }}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          未开放的销售方式不得签约（契约
          §3.2）；此处只控制可选项，签约校验以服务端为准。
        </p>
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
