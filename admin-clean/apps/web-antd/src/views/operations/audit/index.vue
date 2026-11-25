<script lang="ts" setup>
import type { AuditEvent, Permission } from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import { authorizationForRole, DEFAULT_PAGE_SIZE, PERMISSIONS } from '@erp/contracts';
import { Button, Card, Select, SelectOption, Table } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'OpsAudit' });

const authStore = useAuthStore();

const loading = ref(true);
const errorText = ref('');
const items = ref<AuditEvent[]>([]);
const total = ref(0);
const actions = ref<string[]>([]);
const entityTypes = ref<string[]>([]);

const filters = reactive({
  action: undefined as string | undefined,
  entityType: undefined as string | undefined,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
});

const columns = [
  { dataIndex: 'createdAt', key: 'createdAt', title: $t('shell.audit.colTime'), width: 170 },
  { dataIndex: 'actorName', key: 'actorName', title: $t('shell.audit.colActor'), width: 140 },
  { dataIndex: 'action', key: 'action', title: $t('shell.audit.colAction'), width: 180 },
  { dataIndex: 'summary', key: 'summary', title: $t('shell.audit.colSummary') },
  { key: 'source', title: $t('shell.audit.colSource'), width: 150 },
];

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.AUDIT_READ));
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));

async function load() {
  if (!canRead.value) {
    errorText.value = $t('shell.audit.noPermission');
    loading.value = false;
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    const result = await authStore.api.call('listAuditEvents', {
      body: {
        order: 'desc',
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.entityType ? { entityType: filters.entityType } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    items.value = [];
    total.value = 0;
    errorText.value = error instanceof ApiClientError ? error.message : $t('shell.audit.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function loadFacets() {
  // 没有 audit.read 就不该向审计端点发任何请求：服务端会拒，客户端不该先问。
  if (!canRead.value) return;
  try {
    const result = await authStore.api.call('listAuditFacets');
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
  <Page :description="$t('shell.audit.description')" :title="$t('shell.menu.audit')">
    <Card>
      <p v-if="errorText" class="mb-4 text-sm text-red-600" role="alert">{{ errorText }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <Select
          v-model:value="filters.action"
          allow-clear
          class="w-[220px]"
          :placeholder="$t('shell.audit.actionPlaceholder')"
          @change="applyFilters"
        >
          <SelectOption v-for="action in actions" :key="action" :value="action">
            {{ action }}
          </SelectOption>
        </Select>
        <Select
          v-model:value="filters.entityType"
          allow-clear
          class="w-[180px]"
          :placeholder="$t('shell.audit.entityPlaceholder')"
          @change="applyFilters"
        >
          <SelectOption v-for="type in entityTypes" :key="type" :value="type">
            {{ type }}
          </SelectOption>
        </Select>
        <span class="ml-auto text-sm text-muted-foreground">
          {{ $t('shell.audit.total', { total }) }}
        </span>
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
          <template v-if="column.key === 'createdAt'">
            {{ formatDateTime((record as AuditEvent).createdAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <code class="text-sm">{{ (record as AuditEvent).action }}</code>
          </template>
          <template v-else-if="column.key === 'source'">
            <span
              class="text-sm text-muted-foreground"
              :title="(record as AuditEvent).deviceSummary ?? ''"
            >
              {{ (record as AuditEvent).ipSummary ?? '—' }}
            </span>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">{{ $t('shell.audit.empty') }}</div>
        </template>
      </Table>

      <div v-if="total > filters.pageSize" class="mt-4 flex items-center justify-end gap-3">
        <Button :disabled="filters.page <= 1" @click="changePage(filters.page - 1)">
          {{ $t('shell.audit.prev') }}
        </Button>
        <span class="text-sm text-muted-foreground">{{ filters.page }} / {{ totalPages }}</span>
        <Button
          :disabled="filters.page * filters.pageSize >= total"
          @click="changePage(filters.page + 1)"
        >
          {{ $t('shell.audit.next') }}
        </Button>
      </div>
    </Card>
  </Page>
</template>
