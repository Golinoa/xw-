<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { PERMISSIONS, authorizationForRole, type Permission, type TourRoute } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import RouteFormModal from './RouteFormModal.vue';

const auth = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const items = ref<TourRoute[]>([]);
const total = ref(0);
const formOpen = ref(false);
const editing = ref<TourRoute | null>(null);

const filters = reactive({ keyword: '', activeOnly: false });

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.ROUTE_WRITE));

const columns = [
  { title: '线路名称', key: 'name', dataIndex: 'name' },
  { title: '类型', key: 'routeType', dataIndex: 'routeType', width: 110 },
  { title: '地区', key: 'region', dataIndex: 'region', width: 110 },
  { title: '出发地', key: 'departureCity', dataIndex: 'departureCity', width: 100 },
  { title: '天数', key: 'days', dataIndex: 'days', width: 70, align: 'right' as const },
  { title: '状态', key: 'isActive', width: 90 },
  { title: '操作', key: 'action', width: 200 },
];

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await auth.api.call('listRoutes', {
      body: {
        page: 1,
        pageSize: 50,
        ...(filters.keyword.trim() ? { keyword: filters.keyword.trim() } : {}),
        ...(filters.activeOnly ? { activeOnly: 'true' } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(route: TourRoute) {
  editing.value = route;
  formOpen.value = true;
}

async function toggleActive(route: TourRoute) {
  errorText.value = '';
  try {
    await auth.api.call('updateRoute', {
      params: { routeId: route.id },
      body: { isActive: !route.isActive },
    });
    message.success(route.isActive ? '线路已停用' : '线路已启用');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '操作失败，请重试';
  }
}

/**
 * 删除不做引用阻断：订单保存的是线路名称快照，删掉主数据不影响历史单。
 * 但仍在界面上问一次——删错了只能重新录。
 */
async function remove(route: TourRoute) {
  errorText.value = '';
  try {
    await auth.api.call('deleteRoute', { params: { routeId: route.id } });
    message.success('线路已删除');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '删除失败，请重试';
  }
}

onMounted(load);
</script>

<template>
  <a-card title="线路主数据" class="route-card">
    <p class="note">
      订单只保存线路名称快照，改名、停用、删除都不影响历史订单。
      停用后不会出现在开单下拉里，但仍可在这里恢复。
    </p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>

    <div class="toolbar">
      <a-input
        v-model:value="filters.keyword"
        class="keyword"
        placeholder="搜索线路名称"
        allow-clear
        @press-enter="load"
      />
      <a-checkbox v-model:checked="filters.activeOnly" @change="load">只看启用</a-checkbox>
      <a-button @click="load">查询</a-button>
      <span class="result-count">共 {{ total }} 条</span>
      <a-button v-if="canWrite" type="primary" @click="openCreate">新建线路</a-button>
    </div>

    <a-table
      :data-source="items"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'days'">{{ record.days ?? '—' }}</template>
        <template v-else-if="column.key === 'routeType'">
          {{ record.routeType ?? '—' }}
          <span v-if="record.isSelfGroup" class="self-group">自组</span>
        </template>
        <template v-else-if="column.key === 'region'">{{ record.region ?? '—' }}</template>
        <template v-else-if="column.key === 'departureCity'">
          {{ record.departureCity ?? '—' }}
        </template>
        <template v-else-if="column.key === 'isActive'">
          <a-tag :color="record.isActive ? 'green' : 'default'">
            {{ record.isActive ? '启用' : '停用' }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-space v-if="canWrite">
            <a-button size="small" @click="openEdit(record)">编辑</a-button>
            <a-button size="small" @click="toggleActive(record)">
              {{ record.isActive ? '停用' : '启用' }}
            </a-button>
            <a-popconfirm
              title="删除后不可恢复，确认删除？"
              ok-text="删除"
              @confirm="remove(record)"
            >
              <a-button size="small" danger>删除</a-button>
            </a-popconfirm>
          </a-space>
          <span v-else class="muted">只读</span>
        </template>
      </template>
      <template #emptyText><div class="empty">暂无线路</div></template>
    </a-table>

    <RouteFormModal v-model:open="formOpen" :route="editing" @saved="load" />
  </a-card>
</template>

<style scoped>
.route-card {
  max-width: 1080px;
}
.note {
  margin-bottom: var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.error-note {
  margin-bottom: var(--space-16);
  color: var(--color-error-text);
  font-size: var(--font-size-sm);
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-12);
  align-items: center;
  margin-bottom: var(--space-16);
}
.keyword {
  width: 220px;
}
.result-count {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.self-group {
  margin-left: var(--space-4);
  color: var(--color-primary);
  font-size: var(--font-size-sm);
}
.empty {
  padding: var(--space-24) 0;
  color: var(--color-secondary-text);
  text-align: center;
}
.muted {
  color: var(--color-secondary-text);
}
</style>
