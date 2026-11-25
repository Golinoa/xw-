<script lang="ts" setup>
import type { Permission } from '@erp/contracts';

import { computed, onMounted, ref } from 'vue';

import { Page } from '@vben/common-ui';

import { authorizationForRole, DEFAULT_PAGE_SIZE, PERMISSIONS } from '@erp/contracts';
import { Alert, Card, Empty, Select } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import TouristRosterSection from '../order/tourist-roster-section.vue';

defineOptions({ name: 'TradeTourists' });

const authStore = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.ORDER_READ));
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.ORDER_WRITE));

const orderOptions = ref<{ label: string; value: string }[]>([]);
const selectedOrderId = ref<string | undefined>(undefined);
const selectedLabel = ref('');
const loading = ref(true);
const loadFailed = ref('');
const refreshing = ref(false);

async function loadOrders() {
  loading.value = true;
  loadFailed.value = '';
  try {
    const result = await authStore.api.call('listOrders', {
      body: { order: 'desc', page: 1, pageSize: DEFAULT_PAGE_SIZE, sort: 'createdAt' },
    });
    orderOptions.value = result.items.map((item) => ({
      label: `${item.orderNumber} · ${item.customerName}`,
      value: item.id,
    }));
    // 默认选中第一单：独立页一进来就能看到名单，不用先点一次。
    if (!selectedOrderId.value && orderOptions.value.length > 0) {
      selectedOrderId.value = orderOptions.value[0]!.value;
      selectedLabel.value = orderOptions.value[0]!.label;
    }
  } catch {
    orderOptions.value = [];
    loadFailed.value = $t('shell.tourists.orderListFailed');
  } finally {
    loading.value = false;
  }
}

async function searchOrders(keyword: string) {
  refreshing.value = true;
  try {
    const result = await authStore.api.call('listOrders', {
      body: {
        order: 'desc',
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        sort: 'createdAt',
        ...(keyword ? { keyword } : {}),
      },
    });
    orderOptions.value = result.items.map((item) => ({
      label: `${item.orderNumber} · ${item.customerName}`,
      value: item.id,
    }));
  } catch {
    orderOptions.value = [];
  } finally {
    refreshing.value = false;
  }
}

function onChange(value: unknown) {
  selectedOrderId.value = typeof value === 'string' && value ? value : undefined;
  selectedLabel.value =
    orderOptions.value.find((item) => item.value === selectedOrderId.value)?.label ?? '';
}

onMounted(() => {
  if (canRead.value) void loadOrders();
});
</script>

<template>
  <Page :description="$t('shell.tourists.description')" :title="$t('shell.menu.tourists')">
    <Alert v-if="!canRead" :message="$t('shell.tourists.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p v-if="loadFailed" class="mb-4 text-sm text-red-600" role="alert">{{ loadFailed }}</p>

      <div class="mb-5 flex flex-wrap items-center gap-3">
        <span class="text-sm">{{ $t('shell.tourists.selectOrder') }}</span>
        <Select
          :filter-option="false"
          :loading="loading || refreshing"
          :options="orderOptions"
          :placeholder="$t('shell.tourists.selectOrderPlaceholder')"
          :value="selectedOrderId"
          class="w-96"
          show-search
          @change="onChange"
          @search="searchOrders"
        />
        <span v-if="selectedLabel" class="text-sm text-muted-foreground">{{ selectedLabel }}</span>
      </div>

      <Empty
        v-if="!selectedOrderId"
        :description="$t('shell.tourists.noOrderSelected')"
        class="py-12"
      />
      <TouristRosterSection
        v-else
        :can-write="canWrite"
        :order-id="selectedOrderId"
        :show-title="false"
      />
    </Card>
  </Page>
</template>
