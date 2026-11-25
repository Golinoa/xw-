<script lang="ts" setup>
import type { Permission, Supplier } from '@erp/contracts';

import { computed, onMounted, ref } from 'vue';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  InputSearch,
  message,
  Pagination,
  Popconfirm,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  displayText,
  SUPPLIER_SETTLEMENT_LABEL_KEYS,
  SUPPLIER_TYPE_LABEL_KEYS,
} from '../display';
import SupplierFormModal from './supplier-form-modal.vue';

defineOptions({ name: 'TradeSuppliers' });

const authStore = useAuthStore();

const keywordInput = ref('');
const keyword = ref('');
const page = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);

const items = ref<Supplier[]>([]);
const total = ref(0);
const loading = ref(true);
const loadFailed = ref('');
const formOpen = ref(false);
const editing = ref<null | Supplier>(null);
const busyId = ref<null | string>(null);

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.SUPPLIER_READ));
/** 隐藏入口只影响体验：服务端仍按 supplier.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.SUPPLIER_WRITE));

const columns = [
  { dataIndex: 'name', key: 'name', title: $t('shell.suppliers.colName') },
  { dataIndex: 'type', key: 'type', title: $t('shell.suppliers.colType'), width: 100 },
  { dataIndex: 'contactName', key: 'contactName', title: $t('shell.suppliers.colContact'), width: 120 },
  { dataIndex: 'phone', key: 'phone', title: $t('shell.suppliers.colPhone'), width: 150 },
  {
    dataIndex: 'settlement',
    key: 'settlement',
    title: $t('shell.suppliers.colSettlement'),
    width: 110,
  },
  { dataIndex: 'isActive', key: 'isActive', title: $t('shell.suppliers.colStatus'), width: 90 },
  { dataIndex: 'createdAt', key: 'createdAt', title: $t('shell.suppliers.colCreatedAt'), width: 170 },
  { key: 'action', title: $t('shell.suppliers.colAction'), width: 210 },
];

const pageSizeOptions = PAGE_SIZE_OPTIONS.map(String);

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    loading.value = false;
    return;
  }
  loading.value = true;
  loadFailed.value = '';
  try {
    const result = await authStore.api.call('listSuppliers', {
      body: {
        order: 'desc',
        page: page.value,
        pageSize: pageSize.value,
        sort: 'createdAt',
        ...(keyword.value ? { keyword: keyword.value } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    items.value = [];
    total.value = 0;
    // 失败不等于空列表：必须让用户看到「没加载成功」而不是「没有供应商」。
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.suppliers.loadFailed');
  } finally {
    loading.value = false;
  }
}

function submitKeyword() {
  keyword.value = keywordInput.value.trim();
  page.value = 1;
  void load();
}

function resetKeyword() {
  keywordInput.value = '';
  keyword.value = '';
  page.value = 1;
  void load();
}

function changePage(nextPage: number, nextPageSize: number) {
  // 改每页条数后原页码会失效，统一回到第一页。
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void load();
}

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(supplier: Supplier) {
  editing.value = supplier;
  formOpen.value = true;
}

async function onSaved(supplier: Supplier) {
  message.success(
    editing.value
      ? $t('shell.suppliers.updated', { name: supplier.name })
      : $t('shell.suppliers.created', { name: supplier.name }),
  );
  // 新建的排在最前面（按 createdAt 倒序），回到第一页才看得见。
  if (!editing.value) page.value = 1;
  editing.value = null;
  await load();
}

/** 停用不删数据：历史应付行还要靠它出对账单。 */
async function toggleActive(supplier: Supplier) {
  if (busyId.value) return;
  busyId.value = supplier.id;
  try {
    await authStore.api.call('updateSupplier', {
      body: { isActive: !supplier.isActive },
      params: { supplierId: supplier.id },
    });
    message.success(
      supplier.isActive ? $t('shell.suppliers.disabled') : $t('shell.suppliers.enabled'),
    );
    await load();
  } catch (error) {
    message.error(
      error instanceof ApiClientError ? error.message : $t('shell.suppliers.actionFailed'),
    );
  } finally {
    busyId.value = null;
  }
}

/**
 * 删除只对「没被应付行引用」的供应商可行。
 *
 * 被引用时服务端回 409 OBJECT_REFERENCED，必须把「不能删」与「删失败」分开说：
 * 前者要用户去停用，后者只需重试。
 */
async function remove(supplier: Supplier) {
  if (busyId.value) return;
  busyId.value = supplier.id;
  try {
    await authStore.api.call('deleteSupplier', { params: { supplierId: supplier.id } });
    message.success($t('shell.suppliers.deleted', { name: supplier.name }));
    await load();
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'OBJECT_REFERENCED') {
      message.warning($t('shell.suppliers.referenced'));
    } else {
      message.error(
        error instanceof ApiClientError ? error.message : $t('shell.suppliers.deleteFailed'),
      );
    }
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <Page :description="$t('shell.suppliers.description')" :title="$t('shell.menu.suppliers')">
    <Alert v-if="!canRead" :message="$t('shell.suppliers.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p v-if="loadFailed" class="mb-4 text-sm text-red-600" role="alert">{{ loadFailed }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <InputSearch
          v-model:value="keywordInput"
          allow-clear
          class="w-70"
          :placeholder="$t('shell.suppliers.keywordPlaceholder')"
          @search="submitKeyword"
        />
        <Button @click="resetKeyword">{{ $t('shell.suppliers.reset') }}</Button>
        <span class="mr-auto text-sm text-muted-foreground">
          {{ $t('shell.suppliers.total', { total }) }}
        </span>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          {{ $t('shell.suppliers.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'type'">
            {{ $t(SUPPLIER_TYPE_LABEL_KEYS[(record as Supplier).type]) }}
          </template>
          <template v-else-if="column.key === 'contactName'">
            {{ displayText((record as Supplier).contactName) }}
          </template>
          <template v-else-if="column.key === 'phone'">
            {{ displayText((record as Supplier).phone) }}
          </template>
          <template v-else-if="column.key === 'settlement'">
            {{ $t(SUPPLIER_SETTLEMENT_LABEL_KEYS[(record as Supplier).settlement]) }}
          </template>
          <template v-else-if="column.key === 'isActive'">
            <Tag :color="(record as Supplier).isActive ? 'green' : 'default'">
              {{
                (record as Supplier).isActive
                  ? $t('shell.suppliers.statusActive')
                  : $t('shell.suppliers.statusDisabled')
              }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime((record as Supplier).createdAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <div v-if="canWrite" class="flex gap-2">
              <Button size="small" @click="openEdit(record as Supplier)">
                {{ $t('shell.suppliers.edit') }}
              </Button>
              <Button
                :loading="busyId === (record as Supplier).id"
                size="small"
                @click="toggleActive(record as Supplier)"
              >
                {{
                  (record as Supplier).isActive
                    ? $t('shell.suppliers.disable')
                    : $t('shell.suppliers.enable')
                }}
              </Button>
              <Popconfirm
                :ok-text="$t('shell.suppliers.delete')"
                :title="$t('shell.suppliers.deleteConfirm')"
                @confirm="remove(record as Supplier)"
              >
                <Button danger size="small">{{ $t('shell.suppliers.delete') }}</Button>
              </Popconfirm>
            </div>
            <span v-else class="text-muted-foreground">{{ $t('shell.suppliers.readOnly') }}</span>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">
            {{ canWrite ? $t('shell.suppliers.emptyWritable') : $t('shell.suppliers.empty') }}
          </div>
        </template>
      </Table>

      <div v-if="total > 0" class="mt-4 flex justify-end">
        <Pagination
          :current="page"
          :page-size="pageSize"
          :page-size-options="pageSizeOptions"
          show-quick-jumper
          show-size-changer
          :show-total="(count: number) => $t('shell.suppliers.total', { total: count })"
          :total="total"
          @change="changePage"
        />
      </div>
    </Card>

    <SupplierFormModal v-model:open="formOpen" :supplier="editing" @saved="onSaved" />
  </Page>
</template>
