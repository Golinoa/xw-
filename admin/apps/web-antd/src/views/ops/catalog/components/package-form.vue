<script lang="ts" setup>
/**
 * 套餐表单（新建）。
 *
 * 金额只接受 `number` 且限于 `numeric(14,2)` 值域（0 – 999,999,999,999.99），
 * 前端不换算、不做分/元转换（契约 §2.2）。
 * 创建套餐会同时写入第 1 个价格版本（契约 §5.3），因此不在此处再填版本号。
 */
import type {
  FeatureDefinition,
  PackageCreateInput,
  ProductListItem,
  SalesMode,
} from '#/api/ops/catalog';

import { computed, reactive, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Form,
  FormItem,
  Input,
  InputNumber,
  Select,
  Space,
} from 'ant-design-vue';

import { AMOUNT_MAX, BILLING_TYPE_LABEL, SALES_MODE_LABEL } from '../format';

defineOptions({ name: 'CatalogPackageForm' });

const props = withDefaults(
  defineProps<{
    features: FeatureDefinition[];
    products: ProductListItem[];
    serverMessage?: null | string;
    submitting?: boolean;
  }>(),
  { serverMessage: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [values: PackageCreateInput];
}>();

interface PackageFormRef {
  validate: () => Promise<unknown>;
}

interface PackageFormRule {
  max?: number;
  message?: string;
  min?: number;
  required?: boolean;
  trigger?: 'blur' | 'change';
  type?: 'number' | 'string';
}

const form = reactive<{
  billingType: PackageCreateInput['billingType'];
  currency: string;
  customerName: string;
  defaultTermMonths: number | undefined;
  effectiveFrom: string;
  featureKeys: string[];
  internalName: string;
  listPrice: number | undefined;
  productId: string;
  salesMode: SalesMode;
}>({
  billingType: 'periodic',
  currency: 'CNY',
  customerName: '',
  defaultTermMonths: 12,
  effectiveFrom: '',
  featureKeys: [],
  internalName: '',
  listPrice: undefined,
  productId: '',
  salesMode: 'saas',
});

const formRef = ref<PackageFormRef>();

const selectedProduct = computed(() =>
  props.products.find((item) => item.id === form.productId),
);

const availableModes = computed<SalesMode[]>(() =>
  (selectedProduct.value?.salesModes ?? [])
    .filter((item) => item.isEnabled)
    .map((item) => item.mode),
);

const productOptions = computed(() =>
  props.products.map((item) => ({
    label: `${item.name}（${item.code}）`,
    value: item.id,
  })),
);

const modeOptions = computed(() =>
  availableModes.value.map((mode) => ({
    label: SALES_MODE_LABEL[mode],
    value: mode,
  })),
);

const billingOptions = Object.entries(BILLING_TYPE_LABEL).map(
  ([value, label]) => ({
    label,
    value,
  }),
);

const activeFeatures = computed(() =>
  props.features.filter((item) => item.isActive),
);

/** 产品切换后，若当前销售方式未被开放则自动落到第一个可用方式。 */
watch(availableModes, (modes) => {
  if (modes.length > 0 && !modes.includes(form.salesMode)) {
    form.salesMode = modes[0] as SalesMode;
  }
});

const rules: Record<string, PackageFormRule[]> = {
  customerName: [
    { message: '请输入客户可见名称', required: true, trigger: 'blur' },
    { max: 80, message: '客户可见名称不超过 80 字', trigger: 'blur' },
  ],
  effectiveFrom: [
    { message: '请选择生效日', required: true, trigger: 'change' },
  ],
  internalName: [
    { message: '请输入内部名称', required: true, trigger: 'blur' },
    { max: 80, message: '内部名称不超过 80 字', trigger: 'blur' },
  ],
  listPrice: [
    { message: '请输入挂牌价', required: true, trigger: 'change' },
    {
      message: `挂牌价必须在 0 到 ${AMOUNT_MAX.toLocaleString('zh-CN')} 之间`,
      min: 0,
      type: 'number',
      trigger: 'change',
    },
    {
      message: `挂牌价不得超过 ${AMOUNT_MAX.toLocaleString('zh-CN')}`,
      max: AMOUNT_MAX,
      type: 'number',
      trigger: 'change',
    },
  ],
  productId: [{ message: '请选择产品', required: true, trigger: 'change' }],
};

async function handleSubmit() {
  const listPrice = form.listPrice;
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (listPrice === undefined || !Number.isFinite(listPrice)) {
    return;
  }
  if (availableModes.value.length === 0) {
    return;
  }
  emit('submit', {
    billingType: form.billingType,
    currency: form.currency.trim().toUpperCase(),
    customerName: form.customerName.trim(),
    defaultTermMonths: form.defaultTermMonths,
    effectiveFrom: form.effectiveFrom,
    features: form.featureKeys.map((featureKey) => ({
      appliesTo: 'both',
      enabled: true,
      featureKey,
    })),
    internalName: form.internalName.trim(),
    listPrice,
    productId: form.productId,
    salesMode: form.salesMode,
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
      <FormItem label="产品" name="productId" :rules="rules.productId">
        <Select
          v-model:value="form.productId"
          option-filter-prop="label"
          placeholder="选择所属产品"
          show-search
          :options="productOptions"
        />
      </FormItem>

      <FormItem
        label="内部名称"
        name="internalName"
        :rules="rules.internalName"
      >
        <Input
          v-model:value="form.internalName"
          :maxlength="80"
          placeholder="内部识别用，例如：标准版（2026）"
        />
      </FormItem>

      <FormItem
        label="客户可见名称"
        name="customerName"
        :rules="rules.customerName"
      >
        <Input
          v-model:value="form.customerName"
          :maxlength="80"
          placeholder="合同/报价上展示的名称"
        />
      </FormItem>

      <FormItem label="销售方式" name="salesMode">
        <Select
          v-model:value="form.salesMode"
          placeholder="先选择产品"
          :options="modeOptions"
          :disabled="availableModes.length === 0"
        />
        <p v-if="availableModes.length === 0" class="mt-1 text-xs text-red-500">
          该产品未开放任何销售方式，不能创建套餐（契约 §5.3 返回 400）。
        </p>
      </FormItem>

      <FormItem label="计费类型" name="billingType">
        <Select v-model:value="form.billingType" :options="billingOptions" />
      </FormItem>

      <FormItem label="默认期限（月）" name="defaultTermMonths">
        <InputNumber
          v-model:value="form.defaultTermMonths"
          class="w-full"
          :min="1"
          :max="120"
          :precision="0"
          placeholder="一次性授权可留空"
        />
      </FormItem>

      <FormItem label="币种" name="currency">
        <Input
          v-model:value="form.currency"
          :maxlength="3"
          placeholder="ISO-4217，默认 CNY"
        />
      </FormItem>

      <FormItem label="挂牌价" name="listPrice" :rules="rules.listPrice">
        <InputNumber
          v-model:value="form.listPrice"
          class="w-full"
          :max="AMOUNT_MAX"
          :min="0"
          :precision="2"
          :step="1000"
          placeholder="0.00"
        />
      </FormItem>

      <FormItem
        label="生效日"
        name="effectiveFrom"
        :rules="rules.effectiveFrom"
      >
        <DatePicker
          v-model:value="form.effectiveFrom"
          class="w-full"
          value-format="YYYY-MM-DD"
        />
      </FormItem>

      <FormItem label="包含权益（功能键）" name="featureKeys">
        <Checkbox.Group
          v-model:value="form.featureKeys"
          class="flex flex-col gap-1"
        >
          <Checkbox
            v-for="feature in activeFeatures"
            :key="feature.featureKey"
            :value="feature.featureKey"
          >
            {{ feature.displayName }}（{{ feature.featureKey }}）
          </Checkbox>
        </Checkbox.Group>
        <p class="mt-1 text-xs text-muted-foreground">
          权益按稳定功能键定义，产品显示名变化不影响功能键（PRD
          §6.3）。额度/期限的精细配置在套餐详情中维护。
        </p>
      </FormItem>
    </Form>

    <Space class="mt-2">
      <Button :disabled="props.submitting" @click="emit('cancel')">取消</Button>
      <Button type="primary" :loading="props.submitting" @click="handleSubmit">
        创建套餐
      </Button>
    </Space>
  </div>
</template>
