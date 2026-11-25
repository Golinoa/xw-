<script lang="ts" setup>
import type { CustomerSource, Permission } from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import { authorizationForRole, PERMISSIONS } from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  Form,
  FormItem,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  SelectOption,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'CustomerSources' });

const authStore = useAuthStore();

const sources = ref<CustomerSource[]>([]);
const loading = ref(true);
const loadFailed = ref('');
const modalOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const editing = ref<CustomerSource | null>(null);

// `Select` 的 modelValue 不接受 null：未选中统一用 undefined，
// 提交时再分别映射成「不传」（新建）与契约里的 `null`（本页不允许改上级）。
const form = reactive({ name: '', parentId: undefined as string | undefined, sortOrder: 0 });

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canRead = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_READ));
const canWrite = computed(() => permissions.value.includes(PERMISSIONS.CUSTOMER_WRITE));

const columns = [
  { dataIndex: 'name', key: 'name', title: $t('shell.customerSources.colName') },
  { key: 'parent', title: $t('shell.customerSources.colParent'), width: 160 },
  {
    align: 'right' as const,
    dataIndex: 'sortOrder',
    key: 'sortOrder',
    title: $t('shell.customerSources.colSort'),
    width: 80,
  },
  { dataIndex: 'isActive', key: 'isActive', title: $t('shell.customerSources.colStatus'), width: 90 },
  { key: 'action', title: $t('shell.customerSources.colAction'), width: 210 },
];

function parentName(id: null | string): string {
  if (!id) return '—';
  return sources.value.find((item) => item.id === id)?.name ?? '—';
}

async function load() {
  if (!canRead.value) {
    sources.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  loadFailed.value = '';
  try {
    // 必须显式要停用项：服务端默认只回启用的，缺了这个参数「停用」就等于删除。
    const result = await authStore.api.call('listCustomerSources', {
      body: { includeInactive: '1' },
    });
    sources.value = result.sources;
  } catch (error) {
    sources.value = [];
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.customerSources.loadFailed');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.name = '';
  form.parentId = undefined;
  form.sortOrder = 0;
  formError.value = '';
  modalOpen.value = true;
}

function openEdit(source: CustomerSource) {
  editing.value = source;
  form.name = source.name;
  form.parentId = source.parentId ?? undefined;
  form.sortOrder = source.sortOrder;
  formError.value = '';
  modalOpen.value = true;
}

async function submit() {
  if (saving.value) return;
  const name = form.name.trim();
  if (!name) {
    formError.value = $t('shell.customerSources.nameRequired');
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    if (editing.value) {
      // 契约刻意不许改上级：改层级要防环，删除重建更安全。
      await authStore.api.call('updateCustomerSource', {
        body: { name, sortOrder: form.sortOrder },
        params: { sourceId: editing.value.id },
      });
      message.success($t('shell.customerSources.updated'));
    } else {
      await authStore.api.call('createCustomerSource', {
        body: {
          name,
          sortOrder: form.sortOrder,
          ...(form.parentId ? { parentId: form.parentId } : {}),
        },
      });
      message.success($t('shell.customerSources.created'));
    }
    modalOpen.value = false;
    await load();
  } catch (error) {
    if (error instanceof ApiClientError) {
      formError.value =
        error.code === 'CONFLICT' ? $t('shell.customerSources.nameConflict') : error.message;
    } else {
      formError.value = $t('shell.customerSources.saveFailed');
    }
  } finally {
    saving.value = false;
  }
}

async function toggleActive(source: CustomerSource) {
  loadFailed.value = '';
  try {
    await authStore.api.call('updateCustomerSource', {
      body: { isActive: !source.isActive },
      params: { sourceId: source.id },
    });
    message.success(
      source.isActive
        ? $t('shell.customerSources.disabled')
        : $t('shell.customerSources.enabled'),
    );
    await load();
  } catch (error) {
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.customerSources.actionFailed');
  }
}

async function remove(source: CustomerSource) {
  loadFailed.value = '';
  try {
    await authStore.api.call('deleteCustomerSource', { params: { sourceId: source.id } });
    message.success($t('shell.customerSources.deleted'));
    await load();
  } catch (error) {
    loadFailed.value =
      error instanceof ApiClientError ? error.message : $t('shell.customerSources.deleteFailed');
  }
}

onMounted(load);
</script>

<template>
  <Page
    :description="$t('shell.customerSources.description')"
    :title="$t('shell.menu.customerSources')"
  >
    <Alert v-if="!canRead" :message="$t('shell.customerSources.forbidden')" show-icon type="warning" />

    <Card v-else>
      <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.customerSources.note') }}</p>
      <p v-if="loadFailed" class="mb-4 text-sm text-red-600" role="alert">{{ loadFailed }}</p>

      <div class="mb-4 flex items-center gap-3">
        <span class="mr-auto text-sm text-muted-foreground">
          {{ $t('shell.customerSources.total', { total: sources.length }) }}
        </span>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          {{ $t('shell.customerSources.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="sources"
        :loading="loading"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'parent'">
            {{ parentName((record as CustomerSource).parentId) }}
          </template>
          <template v-else-if="column.key === 'isActive'">
            <Tag :color="(record as CustomerSource).isActive ? 'green' : 'default'">
              {{
                (record as CustomerSource).isActive
                  ? $t('shell.customerSources.statusActive')
                  : $t('shell.customerSources.statusDisabled')
              }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'action'">
            <div v-if="canWrite" class="flex gap-2">
              <Button size="small" @click="openEdit(record as CustomerSource)">
                {{ $t('shell.customerSources.edit') }}
              </Button>
              <Button size="small" @click="toggleActive(record as CustomerSource)">
                {{
                  (record as CustomerSource).isActive
                    ? $t('shell.customerSources.disable')
                    : $t('shell.customerSources.enable')
                }}
              </Button>
              <Popconfirm
                :ok-text="$t('shell.customerSources.delete')"
                :title="$t('shell.customerSources.deleteConfirm')"
                @confirm="remove(record as CustomerSource)"
              >
                <Button danger size="small">{{ $t('shell.customerSources.delete') }}</Button>
              </Popconfirm>
            </div>
            <span v-else class="text-muted-foreground">
              {{ $t('shell.customerSources.readOnly') }}
            </span>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">
            {{ canWrite ? $t('shell.customerSources.emptyWritable') : $t('shell.customerSources.empty') }}
          </div>
        </template>
      </Table>
    </Card>

    <Modal
      v-model:open="modalOpen"
      :cancel-text="$t('shell.customerSources.cancel')"
      :closable="!saving"
      :confirm-loading="saving"
      :mask-closable="!saving"
      :ok-text="$t('shell.customerSources.save')"
      :title="
        editing ? $t('shell.customerSources.editTitle') : $t('shell.customerSources.createTitle')
      "
      @ok="submit"
    >
      <Alert v-if="formError" class="mb-4" :message="formError" role="alert" show-icon type="error" />
      <Form layout="vertical" :model="form">
        <FormItem html-for="source-name" :label="$t('shell.customerSources.formName')" required>
          <Input id="source-name" v-model:value="form.name" :maxlength="30" />
        </FormItem>
        <FormItem html-for="source-parent" :label="$t('shell.customerSources.formParent')">
          <Select
            id="source-parent"
            v-model:value="form.parentId"
            allow-clear
            :disabled="Boolean(editing)"
            :placeholder="$t('shell.customerSources.formParentPlaceholder')"
          >
            <SelectOption v-for="item in sources" :key="item.id" :value="item.id">
              {{ item.name }}
            </SelectOption>
          </Select>
          <span v-if="editing" class="text-xs text-muted-foreground">
            {{ $t('shell.customerSources.parentLockedHint') }}
          </span>
        </FormItem>
        <FormItem html-for="source-sort" :label="$t('shell.customerSources.formSort')">
          <InputNumber id="source-sort" v-model:value="form.sortOrder" :max="9999" :min="0" />
        </FormItem>
      </Form>
    </Modal>
  </Page>
</template>
