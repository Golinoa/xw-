<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  DEFAULT_PAGE_SIZE,
  PERMISSIONS,
  authorizationForRole,
  type AuditEvent,
  type Permission,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const columns = [
  { title: '时间', key: 'createdAt', dataIndex: 'createdAt' },
  { title: '操作人', key: 'actorName', dataIndex: 'actorName' },
  { title: '操作', key: 'action', dataIndex: 'action' },
  { title: '详情', key: 'summary', dataIndex: 'summary' },
  { title: '来源', key: 'source' },
];
const loading = ref(true);
const errorText = ref('');
const items = ref<AuditEvent[]>([]);
const total = ref(0);
const actions = ref<string[]>([]);
const entityTypes = ref<string[]>([]);

const filters = reactive({
  action: '' as string,
  entityType: '' as string,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
});

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.AUDIT_READ));

async function load() {
  if (!canRead.value) {
    errorText.value = '当前账号没有查看审计日志的权限。';
    loading.value = false;
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    const result = await auth.api.call('listAuditEvents', {
      body: {
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        order: 'desc',
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (cause) {
    items.value = [];
    total.value = 0;
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

async function loadFacets() {
  try {
    const result = await auth.api.call('listAuditFacets');
    actions.value = result.actions;
    entityTypes.value = result.entityTypes;
  } catch {
    // 筛选项加载失败不影响主列表，用户仍可直接看全部审计。
  }
}

function applyFilters() {
  filters.page = 1;
  void load();
}

function changePage(page: number) {
  filters.page = page;
  void load();
}

onMounted(() => {
  void loadFacets();
  void load();
});
</script>

<template>
  <div class="audit-page">
    <a-card title="操作日志" class="audit-card">
      <p class="audit-note">记录谁在什么时候对什么做了什么。日志只读，任何人都不能修改或删除。</p>
      <div v-if="errorText" class="audit-error">{{ errorText }}</div>

      <div class="filters">
        <a-select
          v-model:value="filters.action"
          placeholder="操作类型（全部）"
          allow-clear
          class="filter-action"
          @change="applyFilters"
        >
          <a-select-option v-for="action in actions" :key="action" :value="action">
            {{ action }}
          </a-select-option>
        </a-select>
        <a-select
          v-model:value="filters.entityType"
          placeholder="对象类型（全部）"
          allow-clear
          class="filter-entity"
          @change="applyFilters"
        >
          <a-select-option v-for="type in entityTypes" :key="type" :value="type">
            {{ type }}
          </a-select-option>
        </a-select>
        <span class="result-count">共 {{ total }} 条</span>
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
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'summary'">
            <span class="summary">{{ record.summary }}</span>
          </template>
          <template v-else-if="column.key === 'actorName'">
            {{ record.actorName }}
          </template>
          <template v-else-if="column.key === 'action'">
            <code class="action-code">{{ record.action }}</code>
          </template>
          <template v-else-if="column.key === 'source'">
            <span class="source" :title="record.deviceSummary ?? ''">
              {{ record.ipSummary ?? '—' }}
            </span>
          </template>
        </template>
        <template #emptyText>
          <div class="empty">暂无审计记录</div>
        </template>
      </a-table>

      <div v-if="total > filters.pageSize" class="pagination">
        <a-button :disabled="filters.page <= 1" @click="changePage(filters.page - 1)"
          >上一页</a-button
        >
        <span class="page-label"
          >{{ filters.page }} / {{ Math.ceil(total / filters.pageSize) }}</span
        >
        <a-button
          :disabled="filters.page * filters.pageSize >= total"
          @click="changePage(filters.page + 1)"
        >
          下一页
        </a-button>
      </div>
    </a-card>
  </div>
</template>

<style scoped>
.audit-card {
  max-width: 1080px;
}
.audit-note {
  margin-bottom: var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.audit-error {
  margin-bottom: var(--space-16);
  color: var(--color-error-text);
  font-size: var(--font-size-sm);
}
.filters {
  display: flex;
  gap: var(--space-12);
  align-items: center;
  margin-bottom: var(--space-16);
}
.filter-action {
  width: 220px;
}
.filter-entity {
  width: 180px;
}
.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.summary {
  color: var(--color-text);
}
.action-code {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-sm);
  color: var(--color-accent, var(--color-primary));
}
.source {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.empty {
  padding: var(--space-32) 0;
  color: var(--color-secondary-text);
  text-align: center;
}
.pagination {
  display: flex;
  gap: var(--space-12);
  align-items: center;
  justify-content: flex-end;
  margin-top: var(--space-16);
}
.page-label {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
</style>
