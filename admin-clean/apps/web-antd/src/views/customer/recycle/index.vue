<script lang="ts" setup>
import type { CustomerRecycleBinItem, Permission } from '@erp/contracts';

import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

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
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'CustomerRecycleBin' });

/**
 * 客户回收站。
 *
 * 权限绑定 `customer.restore`（不是 `customer.read`）：能读已删除数据与能恢复
 * 是同一种能力，服务端也只认这个权限，所以整页都用它做门禁。
 */
const authStore = useAuthStore();
const router = useRouter();

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRestore = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_RESTORE));

const items = ref<CustomerRecycleBinItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
const keyword = ref('');
const keywordInput = ref('');
const loading = ref(true);
const loadFailed = ref('');
const restoringId = ref<null | string>(null);
let requestSeq = 0;

async function load() {
  if (!canRestore.value) {
    items.value = [];
    total.value = 0;
    loading.value = false;
    return;
  }
  const seq = ++requestSeq;
  loading.value = true;
  loadFailed.value = '';
  try {
    const result = await authStore.api.call('listDeletedCustomers', {
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
  } catch (error) {
    if (seq !== requestSeq) return;
    items.value = [];
    total.value = 0;
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.customerRecycle.loadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => authStore.currentOrganization?.organizationId,
  () => {
    // 换公司后回到第一页：旧的筛选与页码属于上一个租户。
    keyword.value = '';
    keywordInput.value = '';
    page.value = 1;
    void load();
  },
);

onMounted(load);

function submitKeyword() {
  keyword.value = keywordInput.value.trim().slice(0, 100);
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
  // 改每页条数后原页码可能越界，统一回到第一页。
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void load();
}

async function restore(record: CustomerRecycleBinItem) {
  if (restoringId.value) return;
  restoringId.value = record.id;
  try {
    await authStore.api.call('restoreCustomer', { params: { customerId: record.id } });
    message.success($t('shell.customerRecycle.restored', { name: record.name }));
    // 删掉当前页最后一条时退回上一页，避免停在空页上。
    if (items.value.length === 1 && page.value > 1) page.value -= 1;
  } catch (error) {
    // 404 = 这条已经不在回收站里（别人刚恢复或彻底删掉），刷新让他看到真实状态。
    message.error(
      error instanceof ApiClientError ? error.message : $t('shell.customerRecycle.restoreFailed'),
    );
  } finally {
    restoringId.value = null;
    await load();
  }
}

const columns = computed(() => [
  { dataIndex: 'name', key: 'name', title: $t('shell.customerRecycle.colName'), width: 160 },
  { dataIndex: 'phoneMasked', key: 'phone', title: $t('shell.customerRecycle.colPhone'), width: 150 },
  { dataIndex: 'emailMasked', key: 'email', title: $t('shell.customerRecycle.colEmail') },
  {
    dataIndex: 'sourceName',
    key: 'source',
    title: $t('shell.customerRecycle.colSource'),
    width: 120,
  },
  { dataIndex: 'tags', key: 'tags', title: $t('shell.customerRecycle.colTags') },
  {
    dataIndex: 'deletedAt',
    key: 'deletedAt',
    title: $t('shell.customerRecycle.colDeletedAt'),
    width: 170,
  },
  { key: 'action', title: $t('shell.customerRecycle.colAction'), width: 100 },
]);

const pageSizeOptions = PAGE_SIZE_OPTIONS.map(String);
</script>

<template>
  <Page
    :description="$t('shell.customerRecycle.description')"
    :title="$t('shell.menu.customerRecycle')"
  >
    <Alert v-if="!canRestore" :message="$t('shell.customerRecycle.forbidden')" show-icon type="warning" />

    <template v-else>
      <Card>
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <InputSearch
            v-model:value="keywordInput"
            allow-clear
            class="w-80"
            :maxlength="100"
            :placeholder="$t('shell.customerRecycle.keywordPlaceholder')"
            @search="submitKeyword"
          />
          <Button @click="resetKeyword">{{ $t('shell.customerRecycle.reset') }}</Button>
          <span class="text-sm text-muted-foreground">
            {{ $t('shell.customerRecycle.total', { total }) }}
          </span>
          <div class="ml-auto flex items-center gap-2">
            <Button :loading="loading" @click="load">{{ $t('shell.customerRecycle.refresh') }}</Button>
            <Button @click="router.push('/customer/list')">
              {{ $t('shell.customerRecycle.backToList') }}
            </Button>
          </div>
        </div>

        <Alert
          v-if="loadFailed"
          class="mb-3"
          show-icon
          type="error"
          :message="loadFailed"
          :description="$t('shell.customerRecycle.errorHint')"
        >
          <template #action>
            <Button size="small" @click="load">{{ $t('shell.customerRecycle.retry') }}</Button>
          </template>
        </Alert>

        <Table
          :columns="columns"
          :data-source="items"
          :loading="loading"
          :pagination="false"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'phone'">
              {{ (record as CustomerRecycleBinItem).phoneMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'email'">
              {{ (record as CustomerRecycleBinItem).emailMasked ?? '—' }}
            </template>
            <template v-else-if="column.key === 'source'">
              {{ (record as CustomerRecycleBinItem).sourceName ?? '—' }}
            </template>
            <template v-else-if="column.key === 'tags'">
              <Space v-if="(record as CustomerRecycleBinItem).tags.length > 0" :size="4" wrap>
                <Tag
                  v-for="tag in (record as CustomerRecycleBinItem).tags"
                  :key="tag.id"
                  :bordered="false"
                  :style="tag.color ? { color: tag.color, borderColor: tag.color } : undefined"
                >
                  {{ tag.name }}
                </Tag>
              </Space>
              <span v-else>—</span>
            </template>
            <template v-else-if="column.key === 'deletedAt'">
              {{ formatDateTime((record as CustomerRecycleBinItem).deletedAt) }}
            </template>
            <template v-else-if="column.key === 'action'">
              <Popconfirm
                :cancel-text="$t('shell.customerRecycle.cancel')"
                :ok-text="$t('shell.customerRecycle.restore')"
                :title="$t('shell.customerRecycle.restoreConfirm')"
                @confirm="restore(record as CustomerRecycleBinItem)"
              >
                <Button
                  :loading="restoringId === (record as CustomerRecycleBinItem).id"
                  size="small"
                  type="link"
                >
                  {{ $t('shell.customerRecycle.restore') }}
                </Button>
              </Popconfirm>
            </template>
          </template>
          <template #emptyText>
            <div class="py-8 text-center text-muted-foreground">
              {{
                keyword
                  ? $t('shell.customerRecycle.emptyNoMatch')
                  : $t('shell.customerRecycle.empty')
              }}
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
            :show-total="(count: number) => $t('shell.customerRecycle.total', { total: count })"
            :total="total"
            @change="changePage"
          />
        </div>
      </Card>
    </template>
  </Page>
</template>
