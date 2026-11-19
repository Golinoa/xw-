<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  PERMISSIONS,
  authorizationForRole,
  type CustomerSource,
  type Permission,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const sources = ref<CustomerSource[]>([]);
const modalOpen = ref(false);
const saving = ref(false);
const editing = ref<CustomerSource | null>(null);

const form = reactive({ name: '', parentId: null as string | null, sortOrder: 0 });

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_WRITE));

const columns = [
  { title: '来源名称', key: 'name', dataIndex: 'name' },
  { title: '上级', key: 'parent', width: 160 },
  { title: '排序', key: 'sortOrder', dataIndex: 'sortOrder', width: 80, align: 'right' as const },
  { title: '状态', key: 'isActive', width: 90 },
  { title: '操作', key: 'action', width: 210 },
];

function nameOf(id: string | null): string {
  if (!id) return '—';
  return sources.value.find((item) => item.id === id)?.name ?? '—';
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    sources.value = (await auth.api.call('listCustomerSources')).sources;
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.name = '';
  form.parentId = null;
  form.sortOrder = 0;
  modalOpen.value = true;
}

function openEdit(source: CustomerSource) {
  editing.value = source;
  form.name = source.name;
  form.parentId = source.parentId;
  form.sortOrder = source.sortOrder;
  modalOpen.value = true;
}

async function submit() {
  const name = form.name.trim();
  if (!name) {
    errorText.value = '请填写来源名称';
    return;
  }
  saving.value = true;
  errorText.value = '';
  try {
    if (editing.value) {
      // 契约刻意不许改上级：改层级要防环，删除重建更安全。
      await auth.api.call('updateCustomerSource', {
        params: { sourceId: editing.value.id },
        body: { name, sortOrder: form.sortOrder },
      });
      message.success('来源已更新');
    } else {
      await auth.api.call('createCustomerSource', {
        body: {
          name,
          sortOrder: form.sortOrder,
          ...(form.parentId ? { parentId: form.parentId } : {}),
        },
      });
      message.success('来源已创建');
    }
    modalOpen.value = false;
    await load();
  } catch (cause) {
    errorText.value =
      cause instanceof ApiClientError
        ? cause.code === 'CONFLICT'
          ? '同名来源已存在，请换一个名称'
          : cause.message
        : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}

async function toggleActive(source: CustomerSource) {
  errorText.value = '';
  try {
    await auth.api.call('updateCustomerSource', {
      params: { sourceId: source.id },
      body: { isActive: !source.isActive },
    });
    message.success(source.isActive ? '来源已停用' : '来源已启用');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '操作失败，请重试';
  }
}

async function remove(source: CustomerSource) {
  errorText.value = '';
  try {
    await auth.api.call('deleteCustomerSource', { params: { sourceId: source.id } });
    message.success('来源已删除');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '删除失败，请重试';
  }
}

onMounted(load);
</script>

<template>
  <a-card title="客户来源" class="source-card">
    <p class="note">
      停用的来源不会出现在客户表单的下拉里，已有客户仍保留原名。
      排序值越小越靠前；上级改不了——要调层级请删掉重建，避免造出环。
    </p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>

    <div class="toolbar">
      <span class="result-count">共 {{ sources.length }} 条</span>
      <a-button v-if="canWrite" type="primary" @click="openCreate">新建来源</a-button>
    </div>

    <a-table
      :data-source="sources"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'parent'">{{ nameOf(record.parentId) }}</template>
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
      <template #emptyText><div class="empty">暂无来源</div></template>
    </a-table>

    <a-modal
      v-model:open="modalOpen"
      :title="editing ? '编辑来源' : '新建来源'"
      :confirm-loading="saving"
      ok-text="保存"
      cancel-text="取消"
      @ok="submit"
    >
      <a-form layout="vertical">
        <a-form-item label="来源名称" required>
          <a-input v-model:value="form.name" :maxlength="30" placeholder="如：门店到访" />
        </a-form-item>
        <a-form-item label="上级来源">
          <a-select
            v-model:value="form.parentId"
            allow-clear
            placeholder="不选则为顶级来源"
            :disabled="Boolean(editing)"
          >
            <a-select-option v-for="item in sources" :key="item.id" :value="item.id">
              {{ item.name }}
            </a-select-option>
          </a-select>
          <span v-if="editing" class="field-hint">上级来源不支持修改</span>
        </a-form-item>
        <a-form-item label="排序">
          <a-input-number v-model:value="form.sortOrder" :min="0" :max="9999" />
        </a-form-item>
      </a-form>
    </a-modal>
  </a-card>
</template>

<style scoped>
.source-card {
  max-width: 900px;
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
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.field-hint {
  margin-top: var(--space-4);
  color: var(--color-secondary-text);
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
