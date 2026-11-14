<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
import type {
  FeatureDefinition,
  FeatureListQuery,
  FeatureValueType,
} from '#/api/ops/catalog';

/**
 * 功能键目录（catalog 域）。
 *
 * `featureKey` 是稳定标识，创建后不可修改；产品显示名变化不影响已发出的功能键
 * （PRD §6.3）。`valueType` 被合同快照引用后不可改（契约 §5.3）。
 */
import { computed, onMounted, reactive, ref } from 'vue';

import {
  Button,
  Card,
  Form,
  FormItem,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createFeature,
  fetchFeatures,
  OPS_DEFAULT_PAGE_SIZE,
  OPS_PAGE_SIZE_OPTIONS,
  updateFeature,
} from '#/api/ops/catalog';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import { enumLabel, FEATURE_VALUE_TYPE_LABEL } from './format';

defineOptions({ name: 'CatalogFeatures' });

const { hasPermission } = useOpsPermission();
const canRead = computed(() => hasPermission(OPS_PERMISSION.CATALOG_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CATALOG_WRITE));

const query = reactive<FeatureListQuery>({
  keyword: '',
  page: 1,
  pageSize: OPS_DEFAULT_PAGE_SIZE,
});

const items = ref<FeatureDefinition[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);

const columns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 220 },
  {
    dataIndex: 'displayName',
    key: 'displayName',
    title: '显示名称',
    width: 180,
  },
  { dataIndex: 'valueType', key: 'valueType', title: '值类型', width: 110 },
  { dataIndex: 'unit', key: 'unit', title: '单位', width: 100 },
  { dataIndex: 'isActive', key: 'isActive', title: '状态', width: 100 },
  { dataIndex: 'usageCount', key: 'usageCount', title: '被引用', width: 100 },
  { key: 'actions', title: '操作', width: 160 },
];

const valueTypeOptions = Object.entries(FEATURE_VALUE_TYPE_LABEL).map(
  ([value, label]) => ({ label, value }),
);

/**
 * 启用/停用筛选。
 *
 * Select 只接受 string/number 值，而契约参数是 `isActive: boolean`，
 * 因此用字符串中转，再映射回布尔值（不把 `'false'` 当真值）。
 */
const activeFilter = ref<'' | 'active' | 'inactive'>('');
const activeFilterOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'inactive' },
];

function handleActiveFilterChange() {
  if (activeFilter.value === 'active') {
    query.isActive = true;
  } else if (activeFilter.value === 'inactive') {
    query.isActive = false;
  } else {
    query.isActive = undefined;
  }
  reloadFirstPage();
}

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchFeatures(query);
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    error.value = toOpsApiError(error_);
    items.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function reloadFirstPage() {
  query.page = 1;
  void load();
}

function asFeature(record: Record<string, unknown>): FeatureDefinition {
  return record as unknown as FeatureDefinition;
}

const pagination = computed(() => ({
  current: query.page ?? 1,
  pageSize: query.pageSize ?? OPS_DEFAULT_PAGE_SIZE,
  pageSizeOptions: OPS_PAGE_SIZE_OPTIONS.map(String),
  showSizeChanger: true,
  showTotal: (value: number) => `共 ${value} 个功能键（服务端分页）`,
  total: total.value,
}));

/* ---------------- 新建 / 编辑 ---------------- */

const formModal = reactive<{
  mode: 'create' | 'edit';
  open: boolean;
  record: FeatureDefinition | null;
  serverMessage: null | string;
  submitting: boolean;
}>({
  mode: 'create',
  open: false,
  record: null,
  serverMessage: null,
  submitting: false,
});

const form = reactive<{
  description: string;
  displayName: string;
  featureKey: string;
  unit: string;
  valueType: FeatureValueType;
}>({
  description: '',
  displayName: '',
  featureKey: '',
  unit: '',
  valueType: 'boolean',
});

const formError = reactive<{ displayName: string; featureKey: string }>({
  displayName: '',
  featureKey: '',
});

function openCreate() {
  formModal.mode = 'create';
  formModal.record = null;
  formModal.serverMessage = null;
  Object.assign(form, {
    description: '',
    displayName: '',
    featureKey: '',
    unit: '',
    valueType: 'boolean',
  });
  formError.displayName = '';
  formError.featureKey = '';
  formModal.open = true;
}

function openEdit(record: FeatureDefinition) {
  formModal.mode = 'edit';
  formModal.record = record;
  formModal.serverMessage = null;
  Object.assign(form, {
    description: record.description ?? '',
    displayName: record.displayName,
    featureKey: record.featureKey,
    unit: record.unit ?? '',
    valueType: record.valueType,
  });
  formError.displayName = '';
  formError.featureKey = '';
  formModal.open = true;
}

/** 功能键命名：小写字母、数字、下划线与点，3–64 位。 */
const FEATURE_KEY_PATTERN = /^[a-z0-9_.]{3,64}$/;

async function submitForm() {
  formError.displayName = '';
  formError.featureKey = '';
  if (form.displayName.trim() === '') {
    formError.displayName = '请输入显示名称';
    return;
  }
  if (
    formModal.mode === 'create' &&
    !FEATURE_KEY_PATTERN.test(form.featureKey.trim())
  ) {
    formError.featureKey =
      '功能键只能包含小写字母、数字、下划线或点（3–64 位）';
    return;
  }
  formModal.submitting = true;
  formModal.serverMessage = null;
  try {
    if (formModal.mode === 'create') {
      await createFeature({
        description: form.description || undefined,
        displayName: form.displayName.trim(),
        featureKey: form.featureKey.trim(),
        unit: form.unit || undefined,
        valueType: form.valueType,
      });
      message.success('功能键已创建');
    } else if (formModal.record) {
      await updateFeature(formModal.record.featureKey, {
        description: form.description,
        displayName: form.displayName.trim(),
        unit: form.unit,
      });
      message.success('功能键已更新');
    }
    formModal.open = false;
    void load();
  } catch (error_) {
    // 409（功能键重复）保留输入
    formModal.serverMessage = toOpsApiError(error_).displayMessage;
  } finally {
    formModal.submitting = false;
  }
}

async function toggleActive(record: FeatureDefinition, isActive: boolean) {
  try {
    await updateFeature(record.featureKey, { isActive });
    message.success(isActive ? '功能键已启用' : '功能键已停用');
    await load();
  } catch (error_) {
    // 409 STATE_CONFLICT：已被合同快照引用且尝试改 valueType 等
    message.error(toOpsApiError(error_).displayMessage);
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CATALOG_READ]"
      title="功能键目录"
    />

    <Card v-else title="功能键目录">
      <template #extra>
        <Button v-if="canWrite" type="primary" @click="openCreate">
          新建功能键
        </Button>
      </template>

      <div class="mb-4 flex flex-wrap items-end gap-3">
        <Input.Search
          v-model:value="query.keyword"
          allow-clear
          class="w-64"
          placeholder="按功能键 / 显示名称搜索"
          @search="reloadFirstPage"
        />
        <Select
          v-model:value="activeFilter"
          allow-clear
          class="w-36"
          placeholder="状态"
          :options="activeFilterOptions"
          @change="handleActiveFilterChange"
        />
        <Button @click="reloadFirstPage">查询</Button>
      </div>

      <OpsErrorAlert
        v-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Table
        row-key="featureKey"
        size="middle"
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="pagination"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'featureKey'">
            <span class="font-mono text-xs">{{ record.featureKey }}</span>
          </template>
          <template v-else-if="column.key === 'valueType'">
            {{ enumLabel(FEATURE_VALUE_TYPE_LABEL, record.valueType) }}
          </template>
          <template v-else-if="column.key === 'unit'">
            {{ record.unit ?? '—' }}
          </template>
          <template v-else-if="column.key === 'isActive'">
            <Tag :color="record.isActive ? 'green' : 'default'">
              {{ record.isActive ? '启用' : '停用' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'usageCount'">
            {{ record.usageCount }} 个套餐
          </template>
          <template v-else-if="column.key === 'actions'">
            <Space v-if="canWrite">
              <Button
                type="link"
                size="small"
                @click="openEdit(asFeature(record))"
              >
                编辑
              </Button>
              <Button
                type="link"
                size="small"
                @click="toggleActive(asFeature(record), !record.isActive)"
              >
                {{ record.isActive ? '停用' : '启用' }}
              </Button>
            </Space>
            <span v-else class="text-xs text-muted-foreground">只读</span>
          </template>
        </template>

        <template #emptyText>
          <div class="py-10 text-center text-sm text-muted-foreground">
            暂无功能键。功能键是权益的稳定标识，创建后不可改名。
          </div>
        </template>
      </Table>
    </Card>

    <Modal
      v-model:open="formModal.open"
      :title="formModal.mode === 'create' ? '新建功能键' : '编辑功能键'"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="formModal.submitting"
      @ok="submitForm"
    >
      <OpsErrorAlert
        v-if="formModal.serverMessage"
        :message="formModal.serverMessage"
        :retryable="false"
      />

      <Form layout="vertical">
        <FormItem
          label="功能键"
          required
          :validate-status="formError.featureKey ? 'error' : undefined"
          :help="formError.featureKey || undefined"
        >
          <Input
            v-model:value="form.featureKey"
            :disabled="formModal.mode === 'edit'"
            :maxlength="64"
            placeholder="例如 core.order_quota（创建后不可修改）"
          />
        </FormItem>
        <FormItem
          label="显示名称"
          required
          :validate-status="formError.displayName ? 'error' : undefined"
          :help="formError.displayName || undefined"
        >
          <Input v-model:value="form.displayName" :maxlength="60" />
        </FormItem>
        <FormItem label="值类型" required>
          <Select
            v-model:value="form.valueType"
            :disabled="formModal.mode === 'edit'"
            :options="valueTypeOptions"
          />
        </FormItem>
        <FormItem label="单位">
          <Input
            v-model:value="form.unit"
            :maxlength="20"
            placeholder="如：单/月、个、月"
          />
        </FormItem>
        <FormItem label="说明">
          <Input.TextArea
            v-model:value="form.description"
            :maxlength="200"
            :rows="2"
          />
        </FormItem>
      </Form>
      <p class="text-xs text-muted-foreground">
        功能键与值类型在创建后不可修改；已被合同快照引用时修改会返回 409
        STATE_CONFLICT。
      </p>
    </Modal>

    <div v-if="canWrite" class="mt-3 text-xs text-muted-foreground">
      提示：停用功能键不影响历史快照中已发放的权益，只影响新合同可选项。
    </div>
  </div>
</template>
