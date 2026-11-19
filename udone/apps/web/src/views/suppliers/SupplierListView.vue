<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type Permission,
  type Supplier,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { lookup } from '../../lib/display';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import SupplierFormModal from './SupplierFormModal.vue';
import { SUPPLIER_SETTLEMENT_LABELS, SUPPLIER_TYPE_LABELS } from './supplier-display';

const auth = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.SUPPLIER_READ));
/** 隐藏入口只影响体验：服务端仍按 supplier.write 独立校验。 */
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.SUPPLIER_WRITE));

const keywordInput = ref('');
const keyword = ref('');
const page = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);

const items = ref<Supplier[]>([]);
const total = ref(0);
const listStatus = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const listError = ref('');
const formOpen = ref(false);
const editing = ref<Supplier | null>(null);
const busyId = ref<string | null>(null);
let requestSeq = 0;

async function load() {
  if (!canRead.value) {
    items.value = [];
    total.value = 0;
    listStatus.value = 'forbidden';
    listError.value = '当前账号没有供应商查看权限，请联系管理员开通。';
    return;
  }
  const seq = ++requestSeq;
  listStatus.value = 'loading';
  listError.value = '';
  try {
    const result = await auth.api.call('listSuppliers', {
      body: {
        page: page.value,
        pageSize: pageSize.value,
        sort: 'createdAt',
        order: 'desc',
        ...(keyword.value ? { keyword: keyword.value } : {}),
      },
    });
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
    listStatus.value = 'ready';
  } catch (cause) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    if (
      cause instanceof ApiClientError &&
      (cause.code === 'FORBIDDEN' || cause.code === 'TENANT_SCOPE_DENIED')
    ) {
      listStatus.value = 'forbidden';
      listError.value = cause.message;
      return;
    }
    // 失败不等于空列表：必须让用户看到「没加载成功」而不是「没有供应商」。
    listStatus.value = 'error';
    listError.value =
      cause instanceof ApiClientError ? cause.message : '供应商列表加载失败，请稍后重试';
  }
}

watch(
  () => auth.currentOrganization.value?.organizationId,
  () => {
    page.value = 1;
    void load();
  },
);

onMounted(() => {
  void load();
});

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

function onPageChange(nextPage: number, nextPageSize: number) {
  // 改每页条数后页码会失效，统一回到第一页。
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void load();
}

async function onSaved(supplier: Supplier) {
  message.success(
    editing.value ? `已保存供应商「${supplier.name}」` : `已新建供应商「${supplier.name}」`,
  );
  if (!editing.value) page.value = 1;
  editing.value = null;
  await load();
}

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(supplier: Supplier) {
  editing.value = supplier;
  formOpen.value = true;
}

/** 停用不删数据：历史应付行还要靠它出对账单。 */
async function toggleActive(supplier: Supplier) {
  if (busyId.value) return;
  busyId.value = supplier.id;
  try {
    await auth.api.call('updateSupplier', {
      params: { supplierId: supplier.id },
      body: { isActive: !supplier.isActive },
    });
    message.success(supplier.isActive ? '供应商已停用' : '供应商已启用');
    await load();
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '操作失败，请重试');
  } finally {
    busyId.value = null;
  }
}

/**
 * 删除只对「没被应付行引用」的供应商可行。
 *
 * 被引用时服务端回 409 OBJECT_REFERENCED，这里必须把「不能删」与「删失败」
 * 分开说——前者要用户去停用，后者只需重试。
 */
async function remove(supplier: Supplier) {
  if (busyId.value) return;
  busyId.value = supplier.id;
  try {
    await auth.api.call('deleteSupplier', { params: { supplierId: supplier.id } });
    message.success(`已删除供应商「${supplier.name}」`);
    await load();
  } catch (cause) {
    if (cause instanceof ApiClientError && cause.code === 'OBJECT_REFERENCED') {
      message.warning('该供应商已被应付单据引用，不能删除；可以改为停用');
    } else {
      message.error(cause instanceof ApiClientError ? cause.message : '删除失败，请重试');
    }
  } finally {
    busyId.value = null;
  }
}

const columns = [
  { title: '名称', dataIndex: 'name', key: 'name' },
  { title: '类型', dataIndex: 'type', key: 'type', width: 100 },
  { title: '联系人', dataIndex: 'contactName', key: 'contactName', width: 120 },
  { title: '电话', dataIndex: 'phone', key: 'phone', width: 150 },
  { title: '结算方式', dataIndex: 'settlement', key: 'settlement', width: 120 },
  { title: '状态', dataIndex: 'isActive', key: 'isActive', width: 90 },
  { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: '操作', key: 'action', width: 200 },
];

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 个供应商`;
</script>

<template>
  <section class="suppliers-page" aria-labelledby="suppliers-title">
    <header class="page-header">
      <div>
        <a-typography-title id="suppliers-title" :level="3" class="page-title"
          >供应商</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          订单应付行必须引用这里维护的供应商；停用不删数据，被应付单据引用的供应商只能停用、不能删除。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="listStatus === 'loading'" @click="load">刷新</a-button>
        <a-button v-if="canWrite" type="primary" @click="openCreate">新建供应商</a-button>
      </a-space>
    </header>

    <a-card :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索供应商名称"
          allow-clear
          @search="submitKeyword"
        />
        <a-button @click="resetKeyword">重置</a-button>
        <span v-if="listStatus === 'ready'" class="result-count" role="status"
          >共 {{ total }} 个供应商</span
        >
      </div>
    </a-card>

    <a-alert
      v-if="listStatus === 'error'"
      type="error"
      show-icon
      :message="listError"
      description="列表请求没有成功，当前页面没有任何供应商数据；这不代表系统中没有供应商。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="listStatus === 'forbidden'"
      status="403"
      title="无权限查看供应商"
      :sub-title="listError"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="listStatus === 'loading' && items.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载供应商…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="items"
          :loading="listStatus === 'loading' && items.length > 0"
          :pagination="false"
          :locale="{
            emptyText: canWrite ? '暂无供应商，点击右上角「新建供应商」开始录入' : '暂无供应商',
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'type'">
              {{ lookup(SUPPLIER_TYPE_LABELS, record.type) }}
            </template>
            <template v-else-if="column.key === 'contactName'">
              {{ record.contactName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'phone'">
              {{ record.phone ?? '—' }}
            </template>
            <template v-else-if="column.key === 'settlement'">
              {{ lookup(SUPPLIER_SETTLEMENT_LABELS, record.settlement) }}
            </template>
            <template v-else-if="column.key === 'isActive'">
              <a-tag :bordered="false" :color="record.isActive ? 'green' : 'default'">
                {{ record.isActive ? '启用' : '停用' }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              {{ formatDateTime(record.createdAt) }}
            </template>
            <template v-else-if="column.key === 'action'">
              <a-space v-if="canWrite">
                <a-button size="small" @click="openEdit(record)">编辑</a-button>
                <a-button
                  size="small"
                  :loading="busyId === record.id"
                  @click="toggleActive(record)"
                >
                  {{ record.isActive ? '停用' : '启用' }}
                </a-button>
                <a-popconfirm
                  title="删除后不可恢复；被引用的供应商删不掉，只能停用。"
                  ok-text="删除"
                  @confirm="remove(record)"
                >
                  <a-button size="small" danger>删除</a-button>
                </a-popconfirm>
              </a-space>
              <span v-else class="muted">只读</span>
            </template>
          </template>
        </a-table>
        <a-pagination
          v-if="total > 0"
          class="pagination"
          :current="page"
          :page-size="pageSize"
          :total="total"
          :page-size-options="pageSizeOptions"
          :show-total="showTotal"
          show-size-changer
          show-quick-jumper
          @change="onPageChange"
        />
      </template>
    </a-card>

    <SupplierFormModal v-model:open="formOpen" :supplier="editing" @saved="onSaved" />
  </section>
</template>

<style scoped>
.suppliers-page {
  display: grid;
  gap: var(--space-16);
  margin: var(--space-32);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-16);
}

.page-title {
  margin-bottom: var(--space-4);
}

.page-subtitle {
  margin-bottom: 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.filter-card :deep(.ant-card-body) {
  padding: var(--space-16);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-12);
}

.keyword-input {
  width: 280px;
}

.muted {
  color: var(--color-secondary-text);
}

.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.table-card :deep(.ant-card-body) {
  padding: var(--space-8) var(--space-16) var(--space-16);
}

.list-status {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-12);
  padding: var(--space-48) 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.pagination {
  margin-top: var(--space-16);
  text-align: right;
}
</style>
