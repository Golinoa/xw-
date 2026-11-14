<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
/**
 * 合同列表（contract 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / conflict。
 * 列表金额与应收摘要均来自服务端（契约 §5.4），前端不做汇总计算。
 */
import type { ContractListItem, ContractListQuery } from '#/api/ops/contract';
import type { CustomerListItem } from '#/api/ops/customer';

import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  Button,
  Card,
  Input,
  message,
  Select,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import { fetchContracts } from '#/api/ops/contract';
import { fetchCustomers } from '#/api/ops/customer';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import {
  CONTRACT_STATUS_COLOR,
  CONTRACT_STATUS_LABEL,
  enumLabel,
  formatDate,
  formatMoney,
  SALES_MODE_LABEL,
} from './format';

defineOptions({ name: 'ContractList' });

const router = useRouter();
const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_WRITE));

const query = reactive<ContractListQuery>({
  keyword: '',
  order: 'desc',
  page: 1,
  pageSize: 15,
  status: [],
});

const items = ref<ContractListItem[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);
const customers = ref<CustomerListItem[]>([]);

const columns = [
  { dataIndex: 'contractNo', key: 'contractNo', title: '合同号', width: 170 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 200 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 110 },
  { dataIndex: 'salesMode', key: 'salesMode', title: '销售方式', width: 110 },
  {
    dataIndex: 'totalAmount',
    key: 'totalAmount',
    title: '合同金额',
    width: 160,
  },
  { dataIndex: 'expiresOn', key: 'expiresOn', title: '有效期', width: 210 },
  {
    dataIndex: 'receivableSummary',
    key: 'receivableSummary',
    title: '应收摘要',
    width: 200,
  },
  { key: 'actions', title: '操作', width: 110 },
];

const statusOptions = Object.entries(CONTRACT_STATUS_LABEL).map(
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

const customerOptions = computed(() =>
  customers.value.map((item) => ({
    label: `${item.name}（${item.customerNo}）`,
    value: item.id,
  })),
);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchContracts(query);
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

async function loadCustomers() {
  if (!canRead.value) {
    return;
  }
  try {
    const result = await fetchCustomers({ page: 1, pageSize: 100 });
    customers.value = result.items;
  } catch (error_) {
    message.warning(
      `客户列表加载失败：${toOpsApiError(error_).displayMessage}`,
    );
  }
}

function reloadFirstPage() {
  query.page = 1;
  void load();
}

function asContract(record: Record<string, unknown>): ContractListItem {
  return record as unknown as ContractListItem;
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? 15,
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 份合同（服务端分页）`,
  total: total.value,
}));

onMounted(() => {
  void load();
  void loadCustomers();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CONTRACT_READ]"
      title="合同与订单"
    />

    <Card v-else title="合同与订单">
      <template #extra>
        <Button
          v-if="canWrite"
          type="primary"
          @click="router.push({ name: 'ContractCreate' })"
        >
          草拟合同
        </Button>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input.Search
          v-model:value="query.keyword"
          allow-clear
          class="w-64"
          placeholder="按合同号 / 客户名称搜索"
          @search="reloadFirstPage"
        />
        <Select
          v-model:value="query.customerId"
          allow-clear
          class="w-64"
          option-filter-prop="label"
          placeholder="客户"
          show-search
          :options="customerOptions"
          @change="reloadFirstPage"
        />
        <Select
          v-model:value="query.status"
          class="min-w-44"
          mode="multiple"
          option-filter-prop="label"
          placeholder="合同状态"
          :options="statusOptions"
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
        :scroll="{ x: 1300 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'contractNo'">
            <span class="font-mono text-xs">{{ record.contractNo }}</span>
          </template>
          <template v-else-if="column.key === 'customer'">
            {{ record.customer?.name ?? '—' }}
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag
              :color="
                CONTRACT_STATUS_COLOR[
                  record.status as keyof typeof CONTRACT_STATUS_COLOR
                ]
              "
            >
              {{ enumLabel(CONTRACT_STATUS_LABEL, record.status) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'salesMode'">
            {{ enumLabel(SALES_MODE_LABEL, record.salesMode) }}
          </template>
          <template v-else-if="column.key === 'totalAmount'">
            <span class="font-medium">
              {{ formatMoney(record.totalAmount, record.currency) }}
            </span>
          </template>
          <template v-else-if="column.key === 'expiresOn'">
            {{ formatDate(record.effectiveOn) }} ~
            {{ formatDate(record.expiresOn) }}
          </template>
          <template v-else-if="column.key === 'receivableSummary'">
            <div v-if="record.receivableSummary" class="text-xs leading-5">
              <div>
                应收
                {{
                  formatMoney(record.receivableSummary.total, record.currency)
                }}
              </div>
              <div class="text-muted-foreground">
                未收
                {{
                  formatMoney(
                    record.receivableSummary.outstanding,
                    record.currency,
                  )
                }}
              </div>
            </div>
            <span v-else class="text-xs text-muted-foreground">未生成计划</span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              type="link"
              size="small"
              @click="
                router.push({
                  name: 'ContractDetail',
                  params: { contractId: asContract(record).id },
                })
              "
            >
              详情
            </Button>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center text-sm text-muted-foreground">
            没有符合条件的合同。合同只能从已存在客户创建，不承接线索与商机（PRD
            §6.4）。
          </div>
        </template>
      </Table>
    </Card>
  </div>
</template>
