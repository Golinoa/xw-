<script lang="ts" setup>
import type { ProductFormValues } from './components/product-form.vue';

import type { OpsApiError } from '#/api/adapter/errors';
/**
 * 产品目录（catalog 域）。
 *
 * 覆盖状态：loading / empty / error / validation / permission-denied / conflict。
 * 生命周期停用走 `PATCH /products/{id}`；被草拟合同引用时后端返回 409
 * `OBJECT_REFERENCED`，页面原样呈现可读文案（不自行猜测原因）。
 */
import type { ProductListItem, ProductListQuery } from '#/api/ops/catalog';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  Button,
  Card,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createProduct,
  fetchProducts,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
  updateProduct,
} from '#/api/ops/catalog';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import ProductForm from './components/product-form.vue';
import {
  enumLabel,
  PRODUCT_LIFECYCLE_COLOR,
  PRODUCT_LIFECYCLE_LABEL,
  SALES_MODE_LABEL,
} from './format';

defineOptions({ name: 'CatalogProducts' });

const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.CATALOG_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CATALOG_WRITE));

const query = reactive<ProductListQuery>({
  keyword: '',
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
});

const items = ref<ProductListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

const columns = [
  { dataIndex: 'code', key: 'code', title: '产品编码', width: 180 },
  { dataIndex: 'name', key: 'name', title: '产品名称', width: 220 },
  {
    dataIndex: 'lifecycleStatus',
    key: 'lifecycleStatus',
    title: '生命周期',
    width: 120,
  },
  {
    dataIndex: 'salesModes',
    key: 'salesModes',
    title: '可销售方式',
    width: 200,
  },
  {
    dataIndex: 'packageCount',
    key: 'packageCount',
    title: '套餐数',
    width: 90,
  },
  { key: 'actions', title: '操作', width: 200 },
];

const lifecycleOptions = Object.entries(PRODUCT_LIFECYCLE_LABEL).map(
  ([value, label]) => ({ label, value }),
);

const salesModeOptions = Object.entries(SALES_MODE_LABEL).map(
  ([value, label]) => ({
    label,
    value,
  }),
);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchProducts(query);
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    error.value = toOpsApiError(error_);
    items.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function reloadFirstPage() {
  query.page = 1;
  void load();
}

function asProduct(record: Record<string, unknown>): ProductListItem {
  return record as unknown as ProductListItem;
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? OPS_DEFAULT_PAGE_SIZE,
  pageSizeOptions: OPS_PAGE_SIZE_OPTIONS.map(String),
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 个产品（服务端分页）`,
  total: total.value,
}));

/* ---------------- 新建 / 编辑 ---------------- */

const formModal = reactive<{
  mode: 'create' | 'edit';
  open: boolean;
  record: null | ProductListItem;
}>({ mode: 'create', open: false, record: null });
const submitting = ref(false);
const serverMessage = ref<null | string>(null);

function openCreate() {
  formModal.mode = 'create';
  formModal.record = null;
  serverMessage.value = null;
  formModal.open = true;
}

function openEdit(record: ProductListItem) {
  formModal.mode = 'edit';
  formModal.record = record;
  serverMessage.value = null;
  formModal.open = true;
}

async function handleSubmit(values: ProductFormValues) {
  submitting.value = true;
  serverMessage.value = null;
  const salesModes = [
    { isEnabled: values.saasEnabled, mode: 'saas' as const },
    { isEnabled: values.privateEnabled, mode: 'private' as const },
  ];
  try {
    if (formModal.mode === 'create') {
      await createProduct({
        code: values.code,
        description: values.description || undefined,
        name: values.name,
        salesModes,
      });
      message.success('产品已创建（初始为草稿状态）');
    } else if (formModal.record) {
      await updateProduct(formModal.record.id, {
        description: values.description,
        name: values.name,
        salesModes,
        version: formModal.record.version,
      });
      message.success('产品已更新');
    }
    formModal.open = false;
    void load();
  } catch (error_) {
    // 409（编码重复/版本冲突）保留输入，供用户修改后重试
    serverMessage.value = toOpsApiError(error_).displayMessage;
  } finally {
    submitting.value = false;
  }
}

/* ---------------- 生命周期启停 ---------------- */

async function changeLifecycle(
  record: ProductListItem,
  next: 'active' | 'retired',
) {
  const isRetire = next === 'retired';
  Modal.confirm({
    content: isRetire
      ? '停用后不能用于新合同；若仍被草拟/审核中的合同或套餐引用，服务端会拒绝（409 OBJECT_REFERENCED）。'
      : '启用后该产品可用于新建套餐与签约。',
    okButtonProps: isRetire ? { danger: true } : {},
    okText: isRetire ? '确认停用' : '确认启用',
    onOk: async () => {
      try {
        await updateProduct(record.id, {
          lifecycleStatus: next,
          version: record.version,
        });
        message.success(isRetire ? '产品已停用' : '产品已启用');
        await load();
      } catch (error_) {
        // 失败原因必须留在弹窗内：抛出让 Modal 不关闭
        message.error(toOpsApiError(error_).displayMessage);
        throw error_;
      }
    },
    title: isRetire
      ? `停用产品「${record.name}」？`
      : `启用产品「${record.name}」？`,
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
      :permissions="[OPS_PERMISSION.CATALOG_READ]"
      title="产品目录"
    />

    <Card v-else title="产品目录">
      <template #extra>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          新建产品
        </Button>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input.Search
          v-model:value="query.keyword"
          allow-clear
          class="w-64"
          placeholder="按产品名称 / 编码搜索"
          @search="reloadFirstPage"
        />
        <Select
          v-model:value="query.lifecycleStatus"
          allow-clear
          class="w-40"
          placeholder="生命周期"
          :options="lifecycleOptions"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="query.salesMode"
          allow-clear
          class="w-40"
          placeholder="销售方式"
          :options="salesModeOptions"
          @change="reloadFirstPage"
        />
        <Button @click="reloadFirstPage">查询</Button>
      </div>

      <OpsErrorAlert
        v-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Table
        row-key="id"
        size="middle"
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="pagination"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'code'">
            <span class="font-mono text-xs">{{ record.code }}</span>
          </template>
          <template v-else-if="column.key === 'lifecycleStatus'">
            <Tag
              :color="
                PRODUCT_LIFECYCLE_COLOR[
                  record.lifecycleStatus as keyof typeof PRODUCT_LIFECYCLE_COLOR
                ]
              "
            >
              {{ enumLabel(PRODUCT_LIFECYCLE_LABEL, record.lifecycleStatus) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'salesModes'">
            <Space wrap>
              <Tag
                v-for="mode in record.salesModes"
                :key="mode.mode"
                :color="mode.isEnabled ? 'blue' : 'default'"
              >
                {{ enumLabel(SALES_MODE_LABEL, mode.mode)
                }}{{ mode.isEnabled ? '' : '（未开放）' }}
              </Tag>
            </Space>
          </template>
          <template v-else-if="column.key === 'actions'">
            <Space v-if="canWrite">
              <Button
                type="link"
                size="small"
                @click="openEdit(asProduct(record))"
              >
                编辑
              </Button>
              <Button
                v-if="record.lifecycleStatus !== 'retired'"
                type="link"
                size="small"
                danger
                @click="changeLifecycle(asProduct(record), 'retired')"
              >
                停用
              </Button>
              <Button
                v-else
                type="link"
                size="small"
                @click="changeLifecycle(asProduct(record), 'active')"
              >
                启用
              </Button>
            </Space>
            <span v-else class="text-xs text-muted-foreground">只读</span>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center text-sm text-muted-foreground">
            暂无产品。产品目录维护产品编码、名称、描述、生命周期状态与可销售版本线（PRD
            §6.3）。
          </div>
        </template>
      </Table>
    </Card>

    <Modal
      v-model:open="formModal.open"
      :title="formModal.mode === 'create' ? '新建产品' : '编辑产品'"
      :footer="null"
      :width="560"
      destroy-on-close
    >
      <ProductForm
        :initial="formModal.record"
        :code-readonly="formModal.mode === 'edit'"
        :server-message="serverMessage"
        :submitting="submitting"
        :submit-text="formModal.mode === 'create' ? '创建产品' : '保存修改'"
        @cancel="formModal.open = false"
        @submit="handleSubmit"
      />
    </Modal>
  </div>
</template>
