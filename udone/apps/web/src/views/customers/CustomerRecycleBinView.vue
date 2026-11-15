<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  PERMISSIONS,
  authorizationForRole,
  type CustomerRecycleBinItem,
  type Permission,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import { formatDateTime } from './customer-display';

const auth = useAuthStore();
const router = useRouter();

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRestore = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_RESTORE));

const items = ref<CustomerRecycleBinItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
const keyword = ref('');
const keywordInput = ref('');
const status = ref<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
const errorText = ref('');
const restoringId = ref<string | null>(null);
let requestSeq = 0;

async function load() {
  if (!canRestore.value) {
    items.value = [];
    total.value = 0;
    status.value = 'forbidden';
    errorText.value = '当前账号没有客户恢复权限，无法查看回收站。';
    return;
  }
  const seq = ++requestSeq;
  status.value = 'loading';
  errorText.value = '';
  try {
    const result = await auth.api.call('listDeletedCustomers', {
      body: {
        page: page.value,
        pageSize: pageSize.value,
        ...(keyword.value ? { keyword: keyword.value } : {}),
      },
    });
    // 快速翻页时丢弃过期响应，避免旧页数据覆盖新页。
    if (seq !== requestSeq) return;
    items.value = result.items;
    total.value = result.total;
    status.value = 'ready';
  } catch (cause) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    if (
      cause instanceof ApiClientError &&
      (cause.code === 'FORBIDDEN' || cause.code === 'TENANT_SCOPE_DENIED')
    ) {
      status.value = 'forbidden';
      errorText.value = cause.message;
      return;
    }
    status.value = 'error';
    errorText.value =
      cause instanceof ApiClientError ? cause.message : '回收站加载失败，请稍后重试';
  }
}

watch(
  () => auth.currentOrganization.value?.organizationId,
  () => {
    page.value = 1;
    void load();
  },
);

onMounted(() => void load());

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

function onPageChange(next: number, size: number) {
  // 改每页条数后原页码可能越界，统一回到第一页。
  page.value = size === pageSize.value ? next : 1;
  pageSize.value = size;
  void load();
}

async function restore(record: CustomerRecycleBinItem) {
  restoringId.value = record.id;
  try {
    await auth.api.call('restoreCustomer', { params: { customerId: record.id } });
    message.success(`已恢复客户「${record.name}」`);
    // 删掉当前页最后一条时退回上一页，避免停在空页上。
    if (items.value.length === 1 && page.value > 1) page.value -= 1;
    await load();
  } catch (cause) {
    // 404 = 这条已经不在回收站里（别人刚恢复或彻底删掉），刷新让他看到真实状态。
    message.error(
      cause instanceof ApiClientError ? cause.message : '恢复失败，请稍后重试',
    );
    await load();
  } finally {
    restoringId.value = null;
  }
}

const columns = [
  { title: '姓名', dataIndex: 'name', key: 'name', width: 150 },
  { title: '电话', dataIndex: 'phoneMasked', key: 'phone', width: 150 },
  { title: '邮箱', dataIndex: 'emailMasked', key: 'email' },
  { title: '来源', dataIndex: 'sourceName', key: 'source', width: 120 },
  { title: '标签', dataIndex: 'tags', key: 'tags' },
  { title: '删除时间', dataIndex: 'deletedAt', key: 'deletedAt', width: 180 },
  { title: '操作', key: 'actions', width: 100 },
];

const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => String(size));
const showTotal = (count: number) => `共 ${count} 位已删除客户`;
</script>

<template>
  <section class="recycle-page" aria-labelledby="recycle-title">
    <header class="page-header">
      <div>
        <a-typography-title id="recycle-title" :level="3" class="page-title"
          >客户回收站</a-typography-title
        >
        <a-typography-paragraph type="secondary" class="page-subtitle">
          删除客户只是放进回收站，历史订单仍指向它；恢复后客户会重新出现在客户列表里。
        </a-typography-paragraph>
      </div>
      <a-space>
        <a-button :loading="status === 'loading'" @click="load">刷新</a-button>
        <a-button @click="router.push('/customers')">返回客户列表</a-button>
      </a-space>
    </header>

    <a-card v-if="canRestore" :bordered="false" class="filter-card">
      <div class="filter-row">
        <a-input-search
          v-model:value="keywordInput"
          class="keyword-input"
          placeholder="搜索已删除客户的姓名或电话"
          allow-clear
          @search="submitKeyword"
        />
        <a-button @click="resetKeyword">重置筛选</a-button>
        <span v-if="status === 'ready'" class="result-count" role="status">
          共 {{ total }} 位已删除客户
        </span>
      </div>
    </a-card>

    <a-alert
      v-if="status === 'error'"
      type="error"
      show-icon
      :message="errorText"
      description="列表请求没有成功，当前页面没有任何数据；这不代表回收站是空的。"
    >
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <a-result
      v-else-if="status === 'forbidden'"
      status="403"
      title="无权限查看回收站"
      :sub-title="errorText"
    />

    <a-card v-else :bordered="false" class="table-card">
      <div v-if="status === 'loading' && items.length === 0" class="list-status" role="status">
        <a-spin />
        <span>正在加载回收站…</span>
      </div>
      <template v-else>
        <a-table
          row-key="id"
          :columns="columns"
          :data-source="items"
          :loading="status === 'loading' && items.length > 0"
          :pagination="false"
          :locale="{ emptyText: keyword ? '没有匹配的已删除客户' : '回收站是空的' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'phone'">
              {{ record.phoneMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'email'">
              {{ record.emailMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'source'">
              {{ record.sourceName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'tags'">
              <a-space v-if="record.tags.length" :size="4" wrap>
                <a-tag
                  v-for="tag in record.tags"
                  :key="tag.id"
                  :bordered="false"
                  :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
                >
                  {{ tag.name }}
                </a-tag>
              </a-space>
              <span v-else>—</span>
            </template>
            <template v-else-if="column.key === 'deletedAt'">
              {{ formatDateTime(record.deletedAt) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <a-popconfirm
                title="恢复这位客户？"
                ok-text="恢复"
                cancel-text="取消"
                @confirm="restore(record)"
              >
                <a-button
                  type="link"
                  size="small"
                  :loading="restoringId === record.id"
                >
                  恢复
                </a-button>
              </a-popconfirm>
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
  </section>
</template>

<style scoped>
.recycle-page {
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
  width: 320px;
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
