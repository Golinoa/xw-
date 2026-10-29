<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
import type { PackageListItem, ProductListItem } from '#/api/ops/catalog';
/**
 * 合同草拟页。
 *
 * 合同只能从已存在客户创建（PRD §6.4）；提交后状态为 `draft`，
 * 需另行「提交审核 → 签署确认 → 确认生效」，每一步都受动作码与状态机约束。
 * 409（编号冲突等）时保留用户输入并展示可读文案。
 */
import type { ContractCreateInput } from '#/api/ops/contract';
import type { CustomerListItem } from '#/api/ops/customer';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, Card, message, Result, Space, Spin } from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import { fetchPackages, fetchProducts } from '#/api/ops/catalog';
import { createContract } from '#/api/ops/contract';
import { fetchCustomers } from '#/api/ops/customer';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import ContractForm from './components/contract-form.vue';

defineOptions({ name: 'ContractCreate' });

const router = useRouter();
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_WRITE));

const customers = ref<CustomerListItem[]>([]);
const products = ref<ProductListItem[]>([]);
const packages = ref<PackageListItem[]>([]);
const loading = ref(false);
const submitting = ref(false);
const error = ref<null | OpsApiError>(null);
const serverMessage = ref<null | string>(null);

async function loadReferences() {
  loading.value = true;
  error.value = null;
  try {
    const [customerPage, productPage, packagePage] = await Promise.all([
      fetchCustomers({ page: 1, pageSize: 100 }),
      fetchProducts({ page: 1, pageSize: 100 }),
      fetchPackages({ page: 1, pageSize: 100 }),
    ]);
    customers.value = customerPage.items;
    products.value = productPage.items;
    packages.value = packagePage.items;
  } catch (error_) {
    error.value = toOpsApiError(error_);
  } finally {
    loading.value = false;
  }
}

async function handleSubmit(values: ContractCreateInput) {
  submitting.value = true;
  serverMessage.value = null;
  try {
    const result = await createContract(values);
    message.success(`合同草稿已创建：${result.contract.contractNo}`);
    void router.push({
      name: 'ContractDetail',
      params: { contractId: result.contract.id },
    });
  } catch (error_) {
    // 409 冲突（编号/版本）与 400 校验：保留已填条目，便于修改后重试
    serverMessage.value = toOpsApiError(error_).displayMessage;
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  if (!canRead.value) {
    return;
  }
  void loadReferences();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CONTRACT_READ]"
      title="合同草拟"
    />

    <template v-else>
      <div class="mb-3 flex items-center justify-between">
        <Space>
          <Button @click="router.push({ name: 'ContractList' })">
            返回合同列表
          </Button>
          <span class="text-lg font-medium">草拟合同</span>
        </Space>
      </div>

      <Result
        v-if="!canWrite"
        status="403"
        title="无草拟权限"
        sub-title="草拟合同需要 contract.write。如需开通请联系运营管理员。"
      />

      <template v-else>
        <Card v-if="loading">
          <div class="flex justify-center py-10"><Spin /></div>
        </Card>

        <OpsErrorAlert
          v-else-if="error"
          :message="error.displayMessage"
          :request-id="error.requestId"
          @retry="loadReferences"
        />

        <Card v-else title="合同信息与条目">
          <p v-if="customers.length === 0" class="mb-3 text-xs text-amber-600">
            当前没有可选客户。合同只能从已存在客户创建，请先在「软件客户」建档。
          </p>
          <ContractForm
            :customers="customers"
            :packages="packages"
            :products="products"
            :server-message="serverMessage"
            :submitting="submitting"
            @cancel="router.push({ name: 'ContractList' })"
            @submit="handleSubmit"
          />
        </Card>
      </template>
    </template>
  </div>
</template>
