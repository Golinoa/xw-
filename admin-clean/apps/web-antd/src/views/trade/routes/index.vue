<script lang="ts" setup>
import type { Permission, TourRoute } from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';

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
  Checkbox,
  InputSearch,
  message,
  Pagination,
  Popconfirm,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { displayText } from '../display';
import RouteFormModal from './route-form-modal.vue';

defineOptions({ name: 'TradeRoutes' });

const authStore = useAuthStore();

const keywordInput = ref('');
const items = ref<TourRoute[]>([]);
const total = ref(0);
const loading = ref(true);
const loadFailed = ref('');
const formOpen = ref(false);
const editing = ref<null | TourRoute>(null);
const busyId = ref<null | string>(null);

const filters = reactive({
  activeOnly: false,
  keyword: '',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE as number,
});

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ROUTE_READ));
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.ROUTE_WRITE));

const columns = [
  { dataIndex: 'name', key: 'name', title: $t('shell.tourRoutes.colName') },
  { dataIndex: 'routeType', key: 'routeType', title: $t('shell.tourRoutes.colType'), width: 130 },
  { dataIndex: 'region', key: 'region', title: $t('shell.tourRoutes.colRegion'), width: 110 },
  {
    dataIndex: 'departureCity',
    key: 'departureCity',
    title: $t('shell.tourRoutes.colDepartureCity'),
    width: 100,
  },
  { align: 'right' as const, dataIndex: 'days', key: 'days', title: $t('shell.tourRoutes.colDays'), width: 70 },
  { dataIndex: 'isActive', key: 'isActive', title: $t('shell.tourRoutes.colStatus'), width: 90 },
  { key: 'action', title: $t('shell.tourRoutes.colAction'), width: 210 },
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
    const result = await authStore.api.call('listRoutes', {
      body: {
        page: filters.page,
        pageSize: filters.pageSize,
        ...(filters.keyword ? { keyword: filters.keyword } : {}),
        ...(filters.activeOnly ? { activeOnly: 'true' } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error) {
    items.value = [];
    total.value = 0;
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.tourRoutes.loadFailed');
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.keyword = keywordInput.value.trim();
  filters.page = 1;
  void load();
}

function resetKeyword() {
  keywordInput.value = '';
  filters.keyword = '';
  filters.page = 1;
  void load();
}

function changePage(nextPage: number, nextPageSize: number) {
  filters.page = nextPageSize === filters.pageSize ? nextPage : 1;
  filters.pageSize = nextPageSize;
  void load();
}

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(route: TourRoute) {
  editing.value = route;
  formOpen.value = true;
}

async function onSaved(route: TourRoute) {
  message.success(
    editing.value
      ? $t('shell.tourRoutes.updated', { name: route.name })
      : $t('shell.tourRoutes.created', { name: route.name }),
  );
  editing.value = null;
  await load();
}

async function toggleActive(route: TourRoute) {
  if (busyId.value) return;
  busyId.value = route.id;
  try {
    await authStore.api.call('updateRoute', {
      body: { isActive: !route.isActive },
      params: { routeId: route.id },
    });
    message.success(
      route.isActive ? $t('shell.tourRoutes.disabled') : $t('shell.tourRoutes.enabled'),
    );
    await load();
  } catch (error) {
    message.error(
      error instanceof ApiClientError ? error.message : $t('shell.tourRoutes.actionFailed'),
    );
  } finally {
    busyId.value = null;
  }
}

/** 删除不做引用阻断：订单存的是线路名称快照，删掉主数据不影响历史订单。 */
async function remove(route: TourRoute) {
  if (busyId.value) return;
  busyId.value = route.id;
  try {
    await authStore.api.call('deleteRoute', { params: { routeId: route.id } });
    message.success($t('shell.tourRoutes.deleted'));
    await load();
  } catch (error) {
    message.error(
      error instanceof ApiClientError ? error.message : $t('shell.tourRoutes.deleteFailed'),
    );
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <Page :description="$t('shell.tourRoutes.description')" :title="$t('shell.menu.tourRoutes')">
    <Alert v-if="!canRead" :message="$t('shell.tourRoutes.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.tourRoutes.note') }}</p>
      <p v-if="loadFailed" class="mb-4 text-sm text-red-600" role="alert">{{ loadFailed }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <InputSearch
          v-model:value="keywordInput"
          allow-clear
          class="w-60"
          :placeholder="$t('shell.tourRoutes.keywordPlaceholder')"
          @search="search"
        />
        <Checkbox v-model:checked="filters.activeOnly" @change="search">
          {{ $t('shell.tourRoutes.activeOnly') }}
        </Checkbox>
        <Button @click="resetKeyword">{{ $t('shell.tourRoutes.reset') }}</Button>
        <span class="mr-auto text-sm text-muted-foreground">
          {{ $t('shell.tourRoutes.total', { total }) }}
        </span>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          {{ $t('shell.tourRoutes.create') }}
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
          <template v-if="column.key === 'routeType'">
            {{ displayText((record as TourRoute).routeType) }}
            <Tag v-if="(record as TourRoute).isSelfGroup" color="blue">
              {{ $t('shell.tourRoutes.selfGroupTag') }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'region'">
            {{ displayText((record as TourRoute).region) }}
          </template>
          <template v-else-if="column.key === 'departureCity'">
            {{ displayText((record as TourRoute).departureCity) }}
          </template>
          <template v-else-if="column.key === 'days'">
            {{ (record as TourRoute).days ?? '—' }}
          </template>
          <template v-else-if="column.key === 'isActive'">
            <Tag :color="(record as TourRoute).isActive ? 'green' : 'default'">
              {{
                (record as TourRoute).isActive
                  ? $t('shell.tourRoutes.statusActive')
                  : $t('shell.tourRoutes.statusDisabled')
              }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'action'">
            <div v-if="canWrite" class="flex gap-2">
              <Button size="small" @click="openEdit(record as TourRoute)">
                {{ $t('shell.tourRoutes.edit') }}
              </Button>
              <Button
                :loading="busyId === (record as TourRoute).id"
                size="small"
                @click="toggleActive(record as TourRoute)"
              >
                {{
                  (record as TourRoute).isActive
                    ? $t('shell.tourRoutes.disable')
                    : $t('shell.tourRoutes.enable')
                }}
              </Button>
              <Popconfirm
                :ok-text="$t('shell.tourRoutes.delete')"
                :title="$t('shell.tourRoutes.deleteConfirm')"
                @confirm="remove(record as TourRoute)"
              >
                <Button danger size="small">{{ $t('shell.tourRoutes.delete') }}</Button>
              </Popconfirm>
            </div>
            <span v-else class="text-muted-foreground">{{ $t('shell.tourRoutes.readOnly') }}</span>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">
            {{ canWrite ? $t('shell.tourRoutes.emptyWritable') : $t('shell.tourRoutes.empty') }}
          </div>
        </template>
      </Table>

      <div v-if="total > 0" class="mt-4 flex justify-end">
        <Pagination
          :current="filters.page"
          :page-size="filters.pageSize"
          :page-size-options="pageSizeOptions"
          show-quick-jumper
          show-size-changer
          :show-total="(count: number) => $t('shell.tourRoutes.total', { total: count })"
          :total="total"
          @change="changePage"
        />
      </div>
    </Card>

    <RouteFormModal v-model:open="formOpen" :route="editing" @saved="onSaved" />
  </Page>
</template>
