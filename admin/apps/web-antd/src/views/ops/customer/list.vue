<script lang="ts" setup>
import type { CustomerFormValues } from './components/customer-form.vue';

import type { OpsApiError } from '#/api/adapter/errors';
import type {
  CustomerCreateInput,
  CustomerListItem,
  CustomerListQuery,
  CustomerOverview,
  CustomerStatus,
} from '#/api/ops/customer';

/**
 * 软件客户列表（customer 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / conflict / destructive-confirm。
 * 列表筛选、排序、分页一律走服务端参数（`admin/.harness/FRONTEND.md` 明文禁止
 * 「下载全部客户后在浏览器过滤」）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  Button,
  Card,
  Drawer,
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
  createCustomer,
  fetchCustomer,
  fetchCustomerOverview,
  fetchCustomers,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
  transitionCustomer,
} from '#/api/ops/customer';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import CustomerForm from './components/customer-form.vue';
import OpsDevDataNotice from './components/ops-dev-data-notice.vue';
import OpsErrorAlert from './components/ops-error-alert.vue';
import OpsPermissionDenied from './components/ops-permission-denied.vue';
import {
  CUSTOMER_STATUS_LABEL,
  customerStatusColor,
  customerStatusLabel,
  formatDateTime,
} from './format';

defineOptions({ name: 'CustomerList' });

const router = useRouter();
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.CUSTOMER_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CUSTOMER_WRITE));

const query = reactive<CustomerListQuery>({
  keyword: '',
  order: 'desc',
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
  sort: 'createdAt',
  status: [],
});

const items = ref<CustomerListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

const columns = [
  {
    dataIndex: 'customerNo',
    key: 'customerNo',
    sorter: true,
    title: '客户编号',
    width: 170,
  },
  {
    dataIndex: 'name',
    key: 'name',
    sorter: true,
    title: '企业名称',
    width: 240,
  },
  { dataIndex: 'status', key: 'status', title: '状态', width: 120 },
  {
    dataIndex: 'primaryContact',
    key: 'primaryContact',
    title: '主要联系人',
    width: 230,
  },
  {
    dataIndex: 'activeContractCount',
    key: 'activeContractCount',
    title: '生效合同',
    width: 100,
  },
  {
    dataIndex: 'createdAt',
    key: 'createdAt',
    sorter: true,
    title: '创建时间',
    width: 170,
  },
  { key: 'actions', title: '操作', width: 190 },
];

const statusOptions = (
  Object.keys(CUSTOMER_STATUS_LABEL) as CustomerStatus[]
).map((value) => ({ label: CUSTOMER_STATUS_LABEL[value], value }));

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchCustomers(query);
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

/** antd `#bodyCell` 的 `record` 是 `Record<string, any>`（第三方边界），此处收敛为行类型。 */
function asCustomer(record: Record<string, unknown>): CustomerListItem {
  return record as unknown as CustomerListItem;
}

/** 表格页码/排序变化 → 转成服务端查询参数。 */
interface TablePagerEvent {
  current?: number;
  pageSize?: number;
}
interface TableSorterEvent {
  field?: string | string[];
  order?: 'ascend' | 'descend' | null;
}

function handleTableChange(...args: unknown[]) {
  const [pager, , sorter] = args as [
    TablePagerEvent | undefined,
    unknown,
    TableSorterEvent | undefined,
  ];
  query.page = pager?.current ?? 1;
  query.pageSize = pager?.pageSize ?? OPS_DEFAULT_PAGE_SIZE;
  const field = Array.isArray(sorter?.field) ? sorter?.field[0] : sorter?.field;
  if (field === 'name' || field === 'createdAt' || field === 'updatedAt') {
    query.sort = field;
    query.order = sorter?.order === 'ascend' ? 'asc' : 'desc';
  }
  void load();
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? OPS_DEFAULT_PAGE_SIZE,
  pageSizeOptions: OPS_PAGE_SIZE_OPTIONS.map(String),
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 条（服务端分页）`,
  total: total.value,
}));

/* ---------------- 新建 ---------------- */

const drawer = reactive<{ open: boolean }>({ open: false });

const formSubmitting = ref(false);
const formServerMessage = ref<null | string>(null);

function openCreate() {
  formServerMessage.value = null;
  drawer.open = true;
}

async function handleFormSubmit(values: CustomerFormValues) {
  formSubmitting.value = true;
  formServerMessage.value = null;
  try {
    const payload: CustomerCreateInput = {
      contacts: [],
      internalNote: values.internalNote || undefined,
      name: values.name,
      regionCode: values.regionCode || undefined,
      sourceNote: values.sourceNote || undefined,
      unifiedSocialCreditCode: values.unifiedSocialCreditCode || undefined,
    };
    const result = await createCustomer(payload);
    drawer.open = false;
    if (result.duplicateHints.length > 0) {
      message.warning(
        `已创建 ${result.customer.customerNo}。检测到可能重复的档案：${result.duplicateHints
          .map((hint) => `${hint.customerNo} ${hint.name}`)
          .join('、')}（仅提示，未自动合并）`,
      );
    } else {
      message.success(`客户已创建：${result.customer.customerNo}`);
    }
    reloadFirstPage();
  } catch (error_) {
    const apiError = toOpsApiError(error_);
    // 409（版本/唯一约束）与 400（校验）都必须保留用户输入
    formServerMessage.value = apiError.displayMessage;
  } finally {
    formSubmitting.value = false;
  }
}

/* ---------------- 停用（destructive-confirm） ---------------- */

const suspend = reactive<{
  errorMessage: null | string;
  impact: CustomerOverview | null;
  open: boolean;
  reason: string;
  record: CustomerListItem | null;
  submitting: boolean;
  version: number;
}>({
  errorMessage: null,
  impact: null,
  open: false,
  reason: '',
  record: null,
  submitting: false,
  version: 0,
});

async function openSuspend(record: CustomerListItem) {
  suspend.open = true;
  suspend.record = record;
  suspend.reason = '';
  suspend.errorMessage = null;
  suspend.impact = null;
  suspend.version = 0;
  try {
    // 停用前展示关联合同、授权、部署和工单（PRD §6.2）；
    // 同时取详情拿到 version，迁移请求必须带乐观锁版本（契约 §3.0）
    const [overview, detail] = await Promise.all([
      fetchCustomerOverview(record.id),
      fetchCustomer(record.id),
    ]);
    suspend.impact = overview;
    suspend.version = detail.customer.version;
  } catch (error_) {
    suspend.errorMessage = toOpsApiError(error_).displayMessage;
  }
}

async function submitSuspend() {
  if (!suspend.record) {
    return;
  }
  if (suspend.reason.trim() === '') {
    suspend.errorMessage = '停用必须填写原因';
    return;
  }
  suspend.submitting = true;
  suspend.errorMessage = null;
  try {
    const result = await transitionCustomer(suspend.record.id, {
      action: 'suspend',
      reason: suspend.reason.trim(),
      version: suspend.version,
    });
    suspend.open = false;
    message.success(`已停用，新版本号 ${result.customer.version}`);
    void load();
  } catch (error_) {
    suspend.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    suspend.submitting = false;
  }
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

    <Card v-else title="软件客户与联系人">
      <template #extra>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          新建客户
        </Button>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input.Search
          v-model:value="query.keyword"
          allow-clear
          class="w-64"
          placeholder="按客户名称 / 编号搜索"
          @search="reloadFirstPage"
        />
        <Select
          v-model:value="query.status"
          class="min-w-48"
          mode="multiple"
          option-filter-prop="label"
          placeholder="客户状态"
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
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <span class="font-medium">{{ record.name }}</span>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="customerStatusColor(record.status)">
              {{ customerStatusLabel(record.status) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'primaryContact'">
            <div v-if="record.primaryContact" class="text-xs leading-5">
              <div>{{ record.primaryContact.maskedPhone ?? '—' }}</div>
              <div class="text-muted-foreground">
                {{ record.primaryContact.maskedEmail ?? '—' }}
              </div>
            </div>
            <span v-else class="text-xs text-muted-foreground">未设置</span>
          </template>
          <template v-else-if="column.key === 'activeContractCount'">
            {{ record.activeContractCount }}
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Space>
              <Button
                type="link"
                size="small"
                @click="
                  router.push({
                    name: 'CustomerDetail',
                    params: { customerId: record.id },
                  })
                "
              >
                详情
              </Button>
              <Button
                v-if="canWrite && record.status === 'active'"
                type="link"
                size="small"
                danger
                @click="openSuspend(asCustomer(record))"
              >
                停用
              </Button>
            </Space>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center">
            <p class="text-sm text-muted-foreground">
              没有符合条件的客户档案。
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              客户档案从「已签约或明确进入交付」开始（PRD
              §2.3），不承接线索与商机。
            </p>
          </div>
        </template>
      </Table>
    </Card>

    <Drawer
      v-model:open="drawer.open"
      title="新建客户"
      width="480"
      destroy-on-close
    >
      <CustomerForm
        :server-message="formServerMessage"
        :submitting="formSubmitting"
        submit-text="创建客户"
        @cancel="drawer.open = false"
        @submit="handleFormSubmit"
      />
      <p class="mt-4 text-xs text-muted-foreground">
        创建后状态为「已签约」。编辑与状态迁移在客户详情页完成（需要携带 version
        乐观锁）。
      </p>
    </Drawer>

    <Modal
      v-model:open="suspend.open"
      title="停用客户（高风险前置确认）"
      ok-text="确认停用"
      cancel-text="取消"
      :confirm-loading="suspend.submitting"
      @ok="submitSuspend"
    >
      <p class="mb-3 text-sm">
        即将停用
        <span class="font-medium">{{ suspend.record?.name }}</span>
        （{{
          suspend.record?.customerNo
        }}）。客户状态与合同、账款、租户状态彼此独立，
        停用不会联动停掉合同或授权（PRD §6.2）。
      </p>

      <div v-if="suspend.impact" class="mb-3 rounded border p-3 text-sm">
        <p class="mb-1 font-medium">影响摘要（只读）</p>
        <ul class="list-inside list-disc text-muted-foreground">
          <li>合同 {{ suspend.impact.contracts.length }} 份</li>
          <li>应收 {{ suspend.impact.receivables.length }} 条</li>
          <li>
            订阅 {{ suspend.impact.subscriptions.length }} 个 / 授权
            {{ suspend.impact.licenses.length }} 个
          </li>
          <li>部署实例 {{ suspend.impact.deployments.length }} 个</li>
          <li>未关闭工单 {{ suspend.impact.tickets.length }} 条</li>
        </ul>
      </div>

      <OpsErrorAlert
        v-if="suspend.errorMessage"
        :message="suspend.errorMessage"
        :retryable="false"
      />

      <label class="mb-1 block text-sm" for="suspend-reason"
        >停用原因（必填）</label
      >
      <Input.TextArea
        id="suspend-reason"
        v-model:value="suspend.reason"
        :maxlength="200"
        :rows="3"
        placeholder="写清业务原因，将写入审计事件"
      />
    </Modal>
  </div>
</template>
