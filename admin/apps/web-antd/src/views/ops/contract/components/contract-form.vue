<script lang="ts" setup>
import type {
  PackageListItem,
  PackagePriceVersion,
  ProductListItem,
} from '#/api/ops/catalog';
/**
 * 合同草拟表单（条目编辑）。
 *
 * 金额口径：条目金额 = 数量 × 单价，**由服务端复算**（契约 §3.3）；前端只展示合计，
 * 不把合计提交给接口（契约 §2.2「API 不接受客户端提交的合计字段」）。
 *
 * 价格版本必须显式选择，页面上能看出「这一行按哪一版价格签约」；
 * 快照由后端在生效时写入 `contract_items.package_price_version_id`。
 */
import type {
  ContractCreateInput,
  ContractItemInput,
  ContractSalesMode,
} from '#/api/ops/contract';
import type { CustomerListItem } from '#/api/ops/customer';

import { computed, reactive, ref } from 'vue';

import {
  Alert,
  Button,
  Form,
  FormItem,
  Input,
  InputNumber,
  Select,
  Space,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import { fetchPackagePriceVersions } from '#/api/ops/catalog';

import { formatMoney, priceVersionLabel } from '../format';

defineOptions({ name: 'ContractForm' });

const props = withDefaults(
  defineProps<{
    customers: CustomerListItem[];
    packages: PackageListItem[];
    products: ProductListItem[];
    serverMessage?: null | string;
    submitting?: boolean;
  }>(),
  { serverMessage: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [values: ContractCreateInput];
}>();

interface ItemRow {
  key: number;
  productId: string;
  packageId: string;
  /** 提交给 `priceVersionId` 的值：优先用版本 id，缺失时退化为 versionNo（见 README 待确认项） */
  priceVersionKey: string;
  quantity: number;
  unitPrice: number;
  termMonths: number | undefined;
  versions: PackagePriceVersion[];
  versionsLoading: boolean;
  error: string;
}

let rowSeed = 0;

const form = reactive<{
  businessNote: string;
  currency: string;
  customerId: string;
  paymentTerms: string;
  salesMode: ContractSalesMode;
  taxNote: string;
}>({
  businessNote: '',
  currency: 'CNY',
  customerId: '',
  paymentTerms: '',
  salesMode: 'saas',
  taxNote: '',
});

const rows = ref<ItemRow[]>([]);
const headerError = ref('');

const customerOptions = computed(() =>
  props.customers.map((item) => ({
    label: `${item.name}（${item.customerNo}）`,
    value: item.id,
  })),
);

const productOptions = computed(() =>
  props.products.map((item) => ({ label: item.name, value: item.id })),
);

const salesModeOptions = [
  { label: 'SaaS', value: 'saas' },
  { label: '私有化', value: 'private' },
];

/** 展示合计：仅用于界面，服务端会按条目复算（契约 §3.3）。 */
const displayTotal = computed(() =>
  rows.value.reduce(
    (sum, row) => sum + (row.quantity || 0) * (row.unitPrice || 0),
    0,
  ),
);

const firstRowError = computed(
  () => rows.value.find((row) => row.error !== '')?.error ?? '',
);

function priceVersionKeyOf(version: PackagePriceVersion): string {
  return version.id ?? String(version.versionNo);
}

function packagesOf(productId: string) {
  return props.packages
    .filter((item) => item.productId === productId)
    .map((item) => ({
      label: `${item.internalName}（${item.salesMode === 'saas' ? 'SaaS' : '私有化'}）`,
      value: item.id,
    }));
}

function versionOptions(row: ItemRow) {
  return row.versions.map((version) => ({
    label: `${priceVersionLabel(version.versionNo)} · ${formatMoney(version.price, version.currency)}`,
    value: priceVersionKeyOf(version),
  }));
}

function addRow() {
  rowSeed += 1;
  rows.value = [
    ...rows.value,
    {
      error: '',
      key: rowSeed,
      packageId: '',
      priceVersionKey: '',
      productId: '',
      quantity: 1,
      termMonths: undefined,
      unitPrice: 0,
      versions: [],
      versionsLoading: false,
    },
  ];
}

function removeRow(key: number) {
  rows.value = rows.value.filter((row) => row.key !== key);
}

function patchRow(key: number, patch: Partial<ItemRow>) {
  rows.value = rows.value.map((row) =>
    row.key === key ? { ...row, ...patch } : row,
  );
}

function handleProductChange(row: ItemRow, productId: string) {
  patchRow(row.key, {
    error: '',
    packageId: '',
    priceVersionKey: '',
    productId,
    unitPrice: 0,
    versions: [],
  });
}

async function handlePackageChange(row: ItemRow, packageId: string) {
  patchRow(row.key, {
    error: '',
    packageId,
    priceVersionKey: '',
    unitPrice: 0,
    versions: [],
    versionsLoading: true,
  });
  if (packageId === '') {
    patchRow(row.key, { versionsLoading: false });
    return;
  }
  try {
    const result = await fetchPackagePriceVersions(packageId);
    const latest = result.items[0];
    patchRow(row.key, {
      priceVersionKey: latest ? priceVersionKeyOf(latest) : '',
      termMonths: latest?.termMonths ?? undefined,
      unitPrice: latest?.price ?? 0,
      versions: result.items,
      versionsLoading: false,
    });
  } catch (error) {
    patchRow(row.key, {
      error: `价格版本加载失败：${toOpsApiError(error).displayMessage}`,
      versionsLoading: false,
    });
  }
}

function handleVersionChange(row: ItemRow, key: string) {
  const version = row.versions.find((item) => priceVersionKeyOf(item) === key);
  patchRow(row.key, {
    priceVersionKey: key,
    termMonths: version?.termMonths ?? row.termMonths,
    unitPrice: version?.price ?? row.unitPrice,
  });
}

function validate(): ContractItemInput[] | null {
  headerError.value = '';
  if (form.customerId === '') {
    headerError.value = '请选择客户';
    return null;
  }
  if (rows.value.length === 0) {
    headerError.value = '合同至少需要一条条目';
    return null;
  }
  let invalid = false;
  rows.value = rows.value.map((row) => {
    let error = '';
    if (row.productId === '' || row.packageId === '') {
      error = '请选择产品与套餐';
    } else if (row.priceVersionKey === '') {
      error = '请选择价格版本';
    } else if (!(row.quantity > 0)) {
      error = '数量必须大于 0';
    } else if (!(row.unitPrice >= 0)) {
      error = '单价必须大于或等于 0';
    }
    if (error !== '') {
      invalid = true;
    }
    return { ...row, error };
  });
  if (invalid) {
    return null;
  }
  return rows.value.map((row) => ({
    packageId: row.packageId,
    priceVersionId: row.priceVersionKey,
    productId: row.productId,
    quantity: row.quantity,
    termMonths: row.termMonths ?? undefined,
    unitPrice: row.unitPrice,
  }));
}

function handleSubmit() {
  const items = validate();
  if (!items) {
    return;
  }
  emit('submit', {
    businessNote: form.businessNote || undefined,
    currency: form.currency.trim().toUpperCase(),
    customerId: form.customerId,
    items,
    paymentTerms: form.paymentTerms || undefined,
    salesMode: form.salesMode,
    taxNote: form.taxNote || undefined,
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

    <Form layout="vertical">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <FormItem label="客户" required>
          <Select
            v-model:value="form.customerId"
            option-filter-prop="label"
            placeholder="选择已签约 / 交付中的客户"
            show-search
            :options="customerOptions"
          />
        </FormItem>
        <FormItem label="销售方式" required>
          <Select v-model:value="form.salesMode" :options="salesModeOptions" />
        </FormItem>
        <FormItem label="币种" required>
          <Input
            v-model:value="form.currency"
            :maxlength="3"
            placeholder="ISO-4217，默认 CNY"
          />
        </FormItem>
        <FormItem label="付款条款">
          <Input
            v-model:value="form.paymentTerms"
            placeholder="如：签约后 15 日内支付 50%"
          />
        </FormItem>
        <FormItem label="含税口径备注">
          <Input
            v-model:value="form.taxNote"
            placeholder="如：含税价，税率按合同约定留档"
          />
        </FormItem>
      </div>
      <FormItem label="商业备注">
        <Input.TextArea
          v-model:value="form.businessNote"
          :maxlength="500"
          :rows="2"
        />
      </FormItem>
    </Form>

    <div class="mb-2 flex items-center justify-between">
      <p class="text-sm font-medium">合同条目</p>
      <Button size="small" type="dashed" @click="addRow">新增条目</Button>
    </div>

    <Alert
      v-if="headerError"
      class="mb-2"
      type="error"
      show-icon
      :message="headerError"
      data-testid="contract-form-error"
    />

    <div
      v-if="rows.length === 0"
      class="rounded border border-dashed p-6 text-center text-sm text-muted-foreground"
    >
      还没有条目。合同至少需要一条产品条目才能提交审核。
    </div>

    <div v-for="row in rows" :key="row.key" class="mb-3 rounded border p-3">
      <div class="grid grid-cols-1 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <div>
          <p class="mb-1 text-xs text-muted-foreground">产品</p>
          <Select
            :value="row.productId"
            class="w-full"
            placeholder="选择产品"
            :options="productOptions"
            @change="(value) => handleProductChange(row, String(value ?? ''))"
          />
        </div>
        <div>
          <p class="mb-1 text-xs text-muted-foreground">套餐</p>
          <Select
            :value="row.packageId"
            class="w-full"
            placeholder="选择套餐"
            :disabled="!row.productId"
            :options="packagesOf(row.productId)"
            @change="(value) => handlePackageChange(row, String(value ?? ''))"
          />
        </div>
        <div>
          <p class="mb-1 text-xs text-muted-foreground">价格版本</p>
          <Select
            :value="row.priceVersionKey"
            class="w-full"
            placeholder="选择版本"
            :disabled="!row.packageId"
            :loading="row.versionsLoading"
            :options="versionOptions(row)"
            @change="(value) => handleVersionChange(row, String(value ?? ''))"
          />
        </div>
        <div>
          <p class="mb-1 text-xs text-muted-foreground">数量</p>
          <InputNumber
            :value="row.quantity"
            class="w-full"
            :min="1"
            :precision="0"
            @change="
              (value) => patchRow(row.key, { quantity: Number(value ?? 0) })
            "
          />
        </div>
        <div>
          <p class="mb-1 text-xs text-muted-foreground">单价</p>
          <InputNumber
            :value="row.unitPrice"
            class="w-full"
            :min="0"
            :precision="2"
            @change="
              (value) => patchRow(row.key, { unitPrice: Number(value ?? 0) })
            "
          />
        </div>
        <div>
          <p class="mb-1 text-xs text-muted-foreground">期限（月）</p>
          <InputNumber
            :value="row.termMonths"
            class="w-full"
            :min="1"
            :precision="0"
            placeholder="可空"
            @change="
              (value) =>
                patchRow(row.key, {
                  termMonths: value === null ? undefined : Number(value),
                })
            "
          />
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">
          小计（展示）：{{
            formatMoney(
              (row.quantity || 0) * (row.unitPrice || 0),
              form.currency || 'CNY',
            )
          }}
        </span>
        <Button type="link" size="small" danger @click="removeRow(row.key)">
          移除该条目
        </Button>
      </div>
      <p v-if="row.error" class="mt-1 text-xs text-red-500">{{ row.error }}</p>
    </div>

    <p class="my-2 text-xs text-muted-foreground">
      条目小计仅用于展示；合同合计由服务端按条目复算（契约
      §3.3），前端不提交合计字段。
    </p>
    <p class="mb-3 text-sm">
      展示合计：
      <span class="font-medium">{{
        formatMoney(displayTotal, form.currency || 'CNY')
      }}</span>
    </p>

    <p v-if="firstRowError" class="mb-2 text-xs text-red-500">
      {{ firstRowError }}
    </p>

    <Space>
      <Button :disabled="props.submitting" @click="emit('cancel')">取消</Button>
      <Button type="primary" :loading="props.submitting" @click="handleSubmit">
        保存草稿
      </Button>
    </Space>
  </div>
</template>
