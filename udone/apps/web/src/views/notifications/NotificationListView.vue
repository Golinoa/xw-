<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { message } from 'ant-design-vue';
import { DEFAULT_PAGE_SIZE, type Notification, type NotificationType } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const loading = ref(true);
const errorText = ref('');
const items = ref<Notification[]>([]);
const total = ref(0);
const selected = ref<string[]>([]);

const filters = reactive({ unreadOnly: false, page: 1, pageSize: DEFAULT_PAGE_SIZE });

const TYPE_LABELS: Record<NotificationType, string> = {
  approval_pending: '待审批',
  application_approved: '申请已通过',
  application_rejected: '申请被驳回',
  settlement_confirmed: '结算已确认',
};

const columns = [
  { title: '状态', key: 'read', dataIndex: 'read', width: 70 },
  { title: '类型', key: 'type', dataIndex: 'type', width: 120 },
  { title: '内容', key: 'body', dataIndex: 'body' },
  { title: '时间', key: 'createdAt', dataIndex: 'createdAt', width: 160 },
  { title: '操作', key: 'action', width: 120 },
];

const hasSelection = computed(() => selected.value.length > 0);

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await auth.api.call('listNotifications', {
      body: {
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        order: 'desc',
        unreadOnly: filters.unreadOnly,
      },
    });
    items.value = result.items;
    total.value = result.total;
    selected.value = [];
  } catch (cause) {
    items.value = [];
    total.value = 0;
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

async function markRead(ids: string[]) {
  try {
    await auth.api.call('markNotificationsRead', { body: { ids } });
    message.success('已标记为已读');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '操作失败，请重试';
  }
}

function openTarget(record: Notification) {
  if (record.entityType === 'finance_application') {
    void router.push({ name: 'finance-applications' });
  } else if (record.entityType === 'settlement_batch') {
    void router.push({ name: 'settlements' });
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
  <a-card title="通知" class="notification-card">
    <p class="note">审批结果、结算确认等提醒会集中在这里。点条目可跳到对应单据并自动标为已读。</p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>

    <div class="toolbar">
      <a-checkbox v-model:checked="filters.unreadOnly" @change="toggleUnreadOnly">
        只看未读
      </a-checkbox>
      <span class="result-count">共 {{ total }} 条</span>
      <a-button v-if="hasSelection" @click="markRead(selected)">标记所选为已读</a-button>
    </div>

    <a-table
      :data-source="items"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      :row-selection="{
        selectedRowKeys: selected,
        onChange: (keys: string[]) => (selected = keys),
      }"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'read'">
          <span
            :class="record.read ? 'dot-read' : 'dot-unread'"
            :title="record.read ? '已读' : '未读'"
          />
        </template>
        <template v-else-if="column.key === 'type'">
          {{ TYPE_LABELS[record.type as NotificationType] ?? record.type }}
        </template>
        <template v-else-if="column.key === 'body'">
          <a-button type="link" class="link-button" @click="openTarget(record)">
            <span class="title">{{ record.title }}</span>
            <span class="body">{{ record.body }}</span>
          </a-button>
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ formatDateTime(record.createdAt) }}
        </template>
        <template v-else-if="column.key === 'action'">
          <a-button v-if="!record.read" type="link" @click="markRead([record.id])"
            >标为已读</a-button
          >
        </template>
      </template>
      <template #emptyText>
        <div class="empty">暂无通知</div>
      </template>
    </a-table>

    <div v-if="total > filters.pageSize" class="pagination">
      <a-button :disabled="filters.page <= 1" @click="changePage(filters.page - 1)"
        >上一页</a-button
      >
      <span class="page-label">{{ filters.page }} / {{ Math.ceil(total / filters.pageSize) }}</span>
      <a-button
        :disabled="filters.page * filters.pageSize >= total"
        @click="changePage(filters.page + 1)"
      >
        下一页
      </a-button>
    </div>
  </a-card>
</template>

<style scoped>
.notification-card {
  max-width: 1000px;
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
  gap: var(--space-12);
  align-items: center;
  margin-bottom: var(--space-16);
}
.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.dot-read,
.dot-unread {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot-read {
  background: var(--color-secondary-text);
}
.dot-unread {
  background: var(--color-primary);
}
.link-button {
  height: auto;
  padding: 0;
  text-align: left;
  white-space: normal;
}
.title {
  display: block;
  font-weight: 600;
}
.body {
  display: block;
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
