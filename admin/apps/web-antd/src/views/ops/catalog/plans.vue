<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
import type {
  FeatureDefinition,
  PackageCreateInput,
  PackageListItem,
  PackageListQuery,
  ProductListItem,
} from '#/api/ops/catalog';

/**
 * 套餐与价格（catalog 域）。
 *
 * 列表展示「当前价格版本」的挂牌价；点进详情可看价格版本历史与权益。
 * 套餐编辑不回写已生效合同/订阅/授权快照（PRD §6.3）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

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
  createPackage,
  fetchFeatures,
  fetchPackages,
  fetchProducts,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
} from '#/api/ops/catalog';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import PackageForm from './components/package-form.vue';
import {
  BILLING_TYPE_LABEL,
  enumLabel,
  formatDate,
  formatMoney,
  PACKAGE_STATUS_COLOR,
  PACKAGE_STATUS_LABEL,
  SALES_MODE_LABEL,
} from './format';

defineOptions({ name: 'CatalogPlans' });

const router = useRouter();
const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.CATALOG_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CATALOG_WRITE));

const query = reactive<PackageListQuery>({
  keyword: '',
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
});

const items = ref<PackageListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

const products = ref<ProductListItem[]>([]);
const features = ref<FeatureDefinition[]>([]);

const columns = [
  {
    dataIndex: 'internalName',
    key: 'internalName',
    title: '内部名称',
    width: 220,
  },
  {
    dataIndex: 'customerName',
    key: 'customerName',
    title: '客户可见名称',
    width: 180,
  },
  { dataIndex: 'salesMode', key: 'salesMode', title: '销售方式', width: 110 },
  {
    dataIndex: 'billingType',
    key: 'billingType',
    title: '计费类型',
    width: 140,
  },
  { dataIndex: 'price', key: 'price', title: '当前价格', width: 150 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 100 },
  {
    dataIndex: 'effectiveFrom',
    key: 'effectiveFrom',
    title: '生效日',
    width: 120,
  },
  { key: 'actions', title: '操作', width: 120 },
];

const productOptions = computed(() =>
  products.value.map((item) => ({
    label: `${item.name}（${item.code}）`,
    value: item.id,
  })),
);

const statusOptions = Object.entries(PACKAGE_STATUS_LABEL).map(
  ([value, label]) => ({
    label,
    value,
  }),
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
    const result = await fetchPackages(query);
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

/** 下拉/表单所需的产品与功能键：失败不影响列表主流程，但要给出可读提示。 */
async function loadReferences() {
  if (!canRead.value) {
    return;
  }
  try {
    const [productPage, featurePage] = await Promise.all([
      fetchProducts({ page: 1, pageSize: 100 }),
      fetchFeatures({ page: 1, pageSize: 100 }),
    ]);
    products.value = productPage.items;
    features.value = featurePage.items;
  } catch (error_) {
    message.warning(
      `产品/功能键目录加载失败：${toOpsApiError(error_).displayMessage}`,
    );
  }
}

function reloadFirstPage() {
  query.page = 1;
  void load();
}

function asPackage(record: Record<string, unknown>): PackageListItem {
  return record as unknown as PackageListItem;
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? OPS_DEFAULT_PAGE_SIZE,
  pageSizeOptions: OPS_PAGE_SIZE_OPTIONS.map(String),
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 个套餐（服务端分页）`,
  total: total.value,
}));

/* ---------------- 新建套餐 ---------------- */

const createModal = reactive<{
  open: boolean;
  serverMessage: null | string;
  submitting: boolean;
}>({ open: false, serverMessage: null, submitting: false });

function openCreate() {
  createModal.serverMessage = null;
  createModal.open = true;
}

async function handleCreate(values: PackageCreateInput) {
  createModal.submitting = true;
  createModal.serverMessage = null;
  try {
    const result = await createPackage(values);
    createModal.open = false;
    message.success(
      `套餐已创建：${result.package.internalName}（${result.priceVersion.versionNo === 1 ? '第 1 个价格版本' : '新价格版本'}）`,
    );
    void load();
  } catch (error_) {
    createModal.serverMessage = toOpsApiError(error_).displayMessage;
  } finally {
    createModal.submitting = false;
  }
}

onMounted(() => {
  void load();
  void loadReferences();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CATALOG_READ]"
      title="套餐与价格"
    />

    <Card v-else title="套餐与价格">
      <template #extra>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          新建套餐
        </Button>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input.Search
          v-model:value="query.keyword"
          allow-clear
          class="w-64"
          placeholder="按套餐名称搜索"
          @search="reloadFirstPage"
        />
        <Select
          v-model:value="query.productId"
          allow-clear
          class="w-64"
          option-filter-prop="label"
          placeholder="所属产品"
          show-search
          :options="productOptions"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="query.salesMode"
          allow-clear
          class="w-36"
          placeholder="销售方式"
          :options="salesModeOptions"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="query.status"
          allow-clear
          class="w-36"
          placeholder="状态"
          :options="statusOptions"
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
        :scroll="{ x: 1200 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'salesMode'">
            {{ enumLabel(SALES_MODE_LABEL, record.salesMode) }}
          </template>
          <template v-else-if="column.key === 'billingType'">
            {{ enumLabel(BILLING_TYPE_LABEL, record.billingType) }}
          </template>
          <template v-else-if="column.key === 'price'">
            <span class="font-medium">
              {{ formatMoney(record.price, record.currency) }}
            </span>
            <span class="ml-1 text-xs text-muted-foreground">当前版本</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag
              :color="
                PACKAGE_STATUS_COLOR[
                  record.status as keyof typeof PACKAGE_STATUS_COLOR
                ]
              "
            >
              {{ enumLabel(PACKAGE_STATUS_LABEL, record.status) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'effectiveFrom'">
            {{ formatDate(record.effectiveFrom) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              type="link"
              size="small"
              @click="
                router.push({
                  name: 'CatalogPlanDetail',
                  params: { packageId: asPackage(record).id },
                })
              "
            >
              详情 / 价格版本
            </Button>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center text-sm text-muted-foreground">
            暂无套餐。套餐需要先有产品，并至少开放一种销售方式后创建。
          </div>
        </template>
      </Table>
    </Card>

    <Modal
      v-model:open="createModal.open"
      title="新建套餐"
      :footer="null"
      :width="640"
      destroy-on-close
    >
      <Space v-if="products.length === 0" class="mb-3" direction="vertical">
        <span class="text-xs text-muted-foreground">
          还没有可用产品，请先在「产品目录」创建产品。
        </span>
      </Space>
      <PackageForm
        :features="features"
        :products="products"
        :server-message="createModal.serverMessage"
        :submitting="createModal.submitting"
        @cancel="createModal.open = false"
        @submit="handleCreate"
      />
    </Modal>
  </div>
</template>
