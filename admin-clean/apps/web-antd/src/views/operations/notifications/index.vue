<script lang="ts" setup>
import type { Notification, NotificationType } from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Page } from '@vben/common-ui';

import { DEFAULT_PAGE_SIZE } from '@erp/contracts';
import { Button, Card, Checkbox, message, Table } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'OpsNotifications' });

const authStore = useAuthStore();
const router = useRouter();

const loading = ref(true);
const errorText = ref('');
const items = ref<Notification[]>([]);
const total = ref(0);
const selected = ref<string[]>([]);

const filters = reactive({ page: 1, pageSize: DEFAULT_PAGE_SIZE, unreadOnly: false });

const TYPE_LABEL_KEYS: Record<NotificationType, string> = {
  application_approved: 'shell.notifications.typeApproved',
  application_rejected: 'shell.notifications.typeRejected',
  approval_pending: 'shell.notifications.typePending',
  settlement_confirmed: 'shell.notifications.typeSettlement',
};

const columns = [
  { dataIndex: 'read', key: 'read', title: $t('shell.notifications.colStatus'), width: 72 },
  { dataIndex: 'type', key: 'type', title: $t('shell.notifications.colType'), width: 130 },
  { dataIndex: 'body', key: 'body', title: $t('shell.notifications.colBody') },
  { dataIndex: 'createdAt', key: 'createdAt', title: $t('shell.notifications.colTime'), width: 170 },
  { key: 'action', title: $t('shell.notifications.colAction'), width: 110 },
];

const rowSelection = computed(() => ({
  onChange: (keys: (number | string)[]) => {
    selected.value = keys.map(String);
  },
  selectedRowKeys: selected.value,
}));

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));

function typeLabel(type: NotificationType) {
  const key = TYPE_LABEL_KEYS[type];
  return key ? $t(key) : type;
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await authStore.api.call('listNotifications', {
      body: {
        order: 'desc',
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        unreadOnly: filters.unreadOnly,
      },
    });
    items.value = result.items;
    total.value = result.total;
    selected.value = [];
  } catch (error) {
    items.value = [];
    total.value = 0;
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.notifications.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function markRead(ids: string[]) {
  if (ids.length === 0) return;
  try {
    await authStore.api.call('markNotificationsRead', { body: { ids } });
    message.success($t('shell.notifications.markedRead'));
    await load();
  } catch (error) {
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.notifications.actionFailed');
  }
}

function openTarget(record: Notification) {
  if (record.entityType === 'finance_application') {
    void router.push({ name: 'FinanceApplications' });
  } else if (record.entityType === 'settlement_batch') {
    void router.push({ name: 'FinanceSettlements' });
  }
  if (!record.read) void markRead([record.id]);
}

function changePage(page: number) {
  filters.page = page;
  void load();
}

function toggleUnreadOnly() {
  filters.page = 1;
  void load();
}

onMounted(load);
</script>

<template>
  <Page :description="$t('shell.notifications.description')" :title="$t('shell.menu.notifications')">
    <Card>
      <p v-if="errorText" class="mb-4 text-sm text-red-600" role="alert">{{ errorText }}</p>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <Checkbox v-model:checked="filters.unreadOnly" @change="toggleUnreadOnly">
          {{ $t('shell.notifications.unreadOnly') }}
        </Checkbox>
        <span class="text-sm text-muted-foreground">
          {{ $t('shell.notifications.total', { total }) }}
        </span>
        <Button v-if="selected.length > 0" aria-label="mark-selected-read" @click="markRead(selected)">
          {{ $t('shell.notifications.markSelected') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="false"
        :row-selection="rowSelection"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'read'">
            <span
              :class="(record as Notification).read ? 'bg-muted-foreground' : 'bg-primary'"
              class="inline-block h-2 w-2 rounded-full"
              :title="(record as Notification).read ? $t('shell.notifications.read') : $t('shell.notifications.unread')"
            ></span>
          </template>
          <template v-else-if="column.key === 'type'">
            {{ typeLabel((record as Notification).type) }}
          </template>
          <template v-else-if="column.key === 'body'">
            <button
              class="block text-left whitespace-normal"
              type="button"
              @click="openTarget(record as Notification)"
            >
              <span class="block font-semibold">{{ (record as Notification).title }}</span>
              <span class="block text-sm text-muted-foreground">{{ (record as Notification).body }}</span>
            </button>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime((record as Notification).createdAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <Button
              v-if="!(record as Notification).read"
              aria-label="mark-read"
              type="link"
              @click="markRead([(record as Notification).id])"
            >
              {{ $t('shell.notifications.markRead') }}
            </Button>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">
            {{ $t('shell.notifications.empty') }}
          </div>
        </template>
      </Table>

      <div v-if="total > filters.pageSize" class="mt-4 flex items-center justify-end gap-3">
        <Button :disabled="filters.page <= 1" @click="changePage(filters.page - 1)">
          {{ $t('shell.notifications.prev') }}
        </Button>
        <span class="text-sm text-muted-foreground">{{ filters.page }} / {{ totalPages }}</span>
        <Button
          :disabled="filters.page * filters.pageSize >= total"
          @click="changePage(filters.page + 1)"
        >
          {{ $t('shell.notifications.next') }}
        </Button>
      </div>
    </Card>
  </Page>
</template>
