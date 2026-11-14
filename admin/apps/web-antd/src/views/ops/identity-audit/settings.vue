<script lang="ts" setup>
/**
 * 系统设置与字典（identity-audit 域）。
 *
 * 覆盖状态：loading / error / permission-denied / validation / conflict / empty。
 *
 * 三条硬约束：
 * 1. **只提交改动项**：`PATCH` 不发未改字段。全量提交会让「两个人各改一项」时
 *    后提交的人悄悄回滚前一项（`buildSettingsPatch` 负责逐项比对）。
 * 2. **范围由契约给**：窗口 1–365 天、工时 1–720 小时。`retention.exportDays`
 *    契约没给上限，前端只校验正整数，越界由服务端 400 拒绝——不编一个上限出来。
 * 3. **幂等键随草稿轮换**：草稿一变就换新键，所以「双击提交」复用同一个键（去重生效），
 *    而「改完再来一次」是新意图（不会被误判成重放）。
 */
import type {
  IdentityErrorView,
  OpsActorLike,
  OpsDictionary,
  OpsDictionaryItem,
  OpsSettings,
} from '#/api/ops/identity';

import { computed, onMounted, reactive, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  message,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  actorLabel,
  buildSettingsPatch,
  createDictionaryItem,
  createIdempotencyKey,
  describeIdentityError,
  fetchDictionaries,
  fetchSettings,
  formatDateTime,
  SETTINGS_FIELD_ORDER,
  SETTINGS_LIMITS,
  SETTINGS_RANGE_NOTE,
  updateDictionaryItem,
  updateSettings,
} from '#/api/ops/identity';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import DictionaryItemModal from './components/dictionary-item-modal.vue';

defineOptions({ name: 'GovernanceSettings' });

const { hasPermission } = useOpsPermission();
const canManage = computed(() => hasPermission(OPS_PERMISSION.SETTINGS_MANAGE));

/* ---------------------------- 系统设置 ---------------------------- */

const original = ref<null | OpsSettings>(null);
const draft = reactive<OpsSettings>({
  exportRetentionDays: 1,
  overviewExpiryWindowDays: 30,
  ticketDueHours: 48,
});
const settingsMeta = ref<{
  updatedAt: null | string;
  updatedBy: null | OpsActorLike;
}>({ updatedAt: null, updatedBy: null });
const reason = ref('');
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsError = ref<IdentityErrorView | null>(null);
const fieldIssues = reactive<Partial<Record<keyof OpsSettings, string>>>({});

/** 幂等键：草稿或原因变化即轮换，保证「同一次提交」复用同一键。 */
let settingsKey = createIdempotencyKey();
watch(
  () => ({ ...draft, reason: reason.value }),
  () => {
    settingsKey = createIdempotencyKey();
  },
);

const fields = computed(() =>
  SETTINGS_FIELD_ORDER.map((key) => ({
    key,
    limit: SETTINGS_LIMITS[key],
  })),
);

const hasDraftChange = computed(() => {
  if (!original.value) {
    return false;
  }
  return SETTINGS_FIELD_ORDER.some(
    (key) => original.value?.[key] !== draft[key],
  );
});

async function loadSettings() {
  if (!canManage.value) {
    return;
  }
  settingsLoading.value = true;
  settingsError.value = null;
  for (const key of SETTINGS_FIELD_ORDER) {
    delete fieldIssues[key];
  }
  try {
    const result = await fetchSettings();
    original.value = { ...result.settings };
    Object.assign(draft, result.settings);
    reason.value = '';
    settingsMeta.value = {
      updatedAt: result.updatedAt,
      updatedBy: result.updatedBy,
    };
  } catch (error_) {
    settingsError.value = describeIdentityError(error_);
  } finally {
    settingsLoading.value = false;
  }
}

async function saveSettings() {
  if (!original.value || settingsSaving.value) {
    return;
  }
  for (const key of SETTINGS_FIELD_ORDER) {
    delete fieldIssues[key];
  }
  const patch = buildSettingsPatch(original.value, { ...draft }, reason.value);
  if (!patch.ok) {
    Object.assign(fieldIssues, patch.issues);
    message.warning('请先修正标红的设置项');
    return;
  }
  if (patch.changed.length === 0) {
    message.info('没有改动，无需提交');
    return;
  }
  if (patch.payload.reason === '') {
    message.warning('请填写变更原因（会写入审计）');
    return;
  }
  settingsSaving.value = true;
  settingsError.value = null;
  try {
    const result = await updateSettings(patch.payload, settingsKey);
    original.value = { ...result.settings };
    Object.assign(draft, result.settings);
    reason.value = '';
    message.success(`已保存 ${patch.changed.length} 项设置`);
    await loadSettings();
  } catch (error_) {
    const view = describeIdentityError(error_);
    settingsError.value = view;
    // 版本/幂等冲突：重新拉取，避免界面继续拿着旧值。
    if (view.shouldRefresh) {
      await loadSettings();
    }
  } finally {
    settingsSaving.value = false;
  }
}

function resetDraft() {
  if (original.value) {
    Object.assign(draft, original.value);
    reason.value = '';
    for (const key of SETTINGS_FIELD_ORDER) {
      delete fieldIssues[key];
    }
  }
}

/* ---------------------------- 字典 ---------------------------- */

const dictionaries = ref<OpsDictionary[]>([]);
const dictionariesLoading = ref(false);
const dictionariesError = ref<IdentityErrorView | null>(null);

const dictionaryColumns = [
  { dataIndex: 'label', key: 'label', title: '展示文案' },
  { dataIndex: 'value', key: 'value', title: '取值', width: 180 },
  { dataIndex: 'sortOrder', key: 'sortOrder', title: '排序', width: 80 },
  { dataIndex: 'isActive', key: 'isActive', title: '状态', width: 100 },
  { key: 'actions', title: '操作', width: 100 },
];

async function loadDictionaries() {
  if (!canManage.value) {
    return;
  }
  dictionariesLoading.value = true;
  dictionariesError.value = null;
  try {
    const result = await fetchDictionaries();
    dictionaries.value = result.items;
  } catch (error_) {
    dictionariesError.value = describeIdentityError(error_);
    dictionaries.value = [];
  } finally {
    dictionariesLoading.value = false;
  }
}

function asItem(record: Record<string, unknown>): OpsDictionaryItem {
  return record as unknown as OpsDictionaryItem;
}

const dictState = reactive<{
  dictionary: null | OpsDictionary;
  error: IdentityErrorView | null;
  item: null | OpsDictionaryItem;
  mode: 'create' | 'edit';
  open: boolean;
  submitting: boolean;
}>({
  dictionary: null,
  error: null,
  item: null,
  mode: 'create',
  open: false,
  submitting: false,
});

let dictKey = createIdempotencyKey();

function openCreateItem(dictionary: OpsDictionary) {
  dictKey = createIdempotencyKey();
  dictState.dictionary = dictionary;
  dictState.item = null;
  dictState.mode = 'create';
  dictState.error = null;
  dictState.open = true;
}

function openEditItem(dictionary: OpsDictionary, item: OpsDictionaryItem) {
  dictKey = createIdempotencyKey();
  dictState.dictionary = dictionary;
  dictState.item = item;
  dictState.mode = 'edit';
  dictState.error = null;
  dictState.open = true;
}

/** 条目没返回 id 时无法按 id 寻址 PATCH，只能禁用编辑（契约 U-19 已定稿补 id，等后端实现）。 */
function editBlocked(item: OpsDictionaryItem): boolean {
  return typeof item.id !== 'string' || item.id === '';
}

async function submitDictionaryItem(payload: {
  isActive?: boolean;
  label: string;
  sortOrder?: number;
  value?: string;
}) {
  const dictionary = dictState.dictionary;
  if (!dictionary) {
    return;
  }
  dictState.submitting = true;
  dictState.error = null;
  try {
    if (dictState.mode === 'create') {
      await createDictionaryItem(
        dictionary.code,
        {
          label: payload.label,
          sortOrder: payload.sortOrder,
          value: payload.value ?? '',
        },
        dictKey,
      );
      message.success('字典项已新增');
    } else if (dictState.item?.id) {
      await updateDictionaryItem(
        dictState.item.id,
        {
          isActive: payload.isActive,
          label: payload.label,
          sortOrder: payload.sortOrder,
        },
        dictKey,
      );
      message.success('字典项已保存');
    }
    dictState.open = false;
    await loadDictionaries();
  } catch (error_) {
    dictState.error = describeIdentityError(error_);
  } finally {
    dictState.submitting = false;
  }
}

/** 快速停用/启用：复用与编辑相同的 PATCH 端点，只是只改一个字段。 */
async function toggleItemActive(item: OpsDictionaryItem) {
  if (editBlocked(item) || !item.id) {
    message.warning(
      '该字典项未返回 id，无法修改（契约 U-19 已定稿给 id，等后端实现）',
    );
    return;
  }
  const key = createIdempotencyKey();
  try {
    await updateDictionaryItem(item.id, { isActive: !item.isActive }, key);
    message.success(item.isActive ? '已停用' : '已启用');
    await loadDictionaries();
  } catch (error_) {
    dictionariesError.value = describeIdentityError(error_);
  }
}

onMounted(() => {
  void loadSettings();
  void loadDictionaries();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canManage"
      :permissions="[OPS_PERMISSION.SETTINGS_MANAGE]"
      title="系统设置"
    />

    <template v-else>
      <Card title="系统设置" :loading="settingsLoading">
        <template #extra>
          <span class="text-xs text-muted-foreground">
            最近修改：{{ formatDateTime(settingsMeta.updatedAt) }} ·
            {{ actorLabel(settingsMeta.updatedBy) }}
          </span>
        </template>

        <OpsErrorAlert
          v-if="settingsError"
          :message="settingsError.description"
          :request-id="settingsError.requestId"
          @retry="loadSettings"
        />

        <div class="max-w-2xl space-y-5">
          <div v-for="field in fields" :key="field.key">
            <div class="mb-1 flex items-center gap-2">
              <span class="text-sm text-foreground">{{
                field.limit.label
              }}</span>
              <Tag>
                {{ field.limit.min }}–{{ field.limit.max ?? '不限' }}
                {{ field.limit.unit }}
              </Tag>
            </div>
            <div class="flex items-center gap-2">
              <InputNumber
                v-model:value="draft[field.key]"
                :min="field.limit.min"
                :precision="0"
                :step="1"
                class="w-40"
              />
              <span class="text-sm text-muted-foreground">
                {{ field.limit.unit }}
              </span>
            </div>
            <p v-if="fieldIssues[field.key]" class="mt-1 text-xs text-red-600">
              {{ fieldIssues[field.key] }}
            </p>
          </div>

          <div>
            <div class="mb-1 text-sm text-foreground">变更原因</div>
            <Input.TextArea
              v-model:value="reason"
              :maxlength="200"
              :rows="2"
              placeholder="例如：临期窗口调整为 30 天，与客户续约提醒节奏一致"
            />
            <p class="mt-1 text-xs text-muted-foreground">
              原因会写入审计日志；设置变更不可撤销，只能再次修改。
            </p>
          </div>

          <Alert
            v-if="!hasDraftChange"
            message="当前没有改动，保存按钮不会提交空请求"
            show-icon
            type="info"
          />

          <div class="flex items-center gap-2">
            <Button
              :disabled="!hasDraftChange"
              :loading="settingsSaving"
              type="primary"
              @click="saveSettings"
            >
              保存设置
            </Button>
            <Button :disabled="!hasDraftChange" @click="resetDraft">
              放弃改动
            </Button>
          </div>

          <p class="text-xs text-muted-foreground">{{ SETTINGS_RANGE_NOTE }}</p>
        </div>
      </Card>

      <Card class="mt-4" title="字典配置" :loading="dictionariesLoading">
        <template #extra>
          <span class="text-xs text-muted-foreground">
            字典项只能停用，不提供删除——历史单据要能回显
          </span>
        </template>

        <OpsErrorAlert
          v-if="dictionariesError"
          :message="dictionariesError.description"
          :request-id="dictionariesError.requestId"
          @retry="loadDictionaries"
        />

        <div
          v-if="!dictionariesLoading && dictionaries.length === 0"
          class="py-8 text-center text-sm text-muted-foreground"
        >
          服务端未返回任何字典。
        </div>

        <div class="space-y-6">
          <div v-for="dictionary in dictionaries" :key="dictionary.code">
            <div class="mb-2 flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-foreground">
                  {{ dictionary.name }}
                </span>
                <span class="font-mono text-xs text-muted-foreground">
                  {{ dictionary.code }}
                </span>
              </div>
              <Button size="small" @click="openCreateItem(dictionary)">
                新增字典项
              </Button>
            </div>

            <Table
              row-key="value"
              size="small"
              :columns="dictionaryColumns"
              :data-source="dictionary.items"
              :pagination="false"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'label'">
                  {{ record.label }}
                </template>
                <template v-else-if="column.key === 'value'">
                  <span class="font-mono text-xs">{{ record.value }}</span>
                </template>
                <template v-else-if="column.key === 'isActive'">
                  <Tag :color="record.isActive ? 'green' : 'default'">
                    {{ record.isActive ? '启用' : '已停用' }}
                  </Tag>
                </template>
                <template v-else-if="column.key === 'actions'">
                  <Button
                    :disabled="editBlocked(asItem(record))"
                    :title="
                      editBlocked(asItem(record))
                        ? '服务端未返回条目 id，无法按 id 更新（契约 U-19 已定稿给 id，等后端实现）'
                        : ''
                    "
                    size="small"
                    type="link"
                    @click="openEditItem(dictionary, asItem(record))"
                  >
                    编辑
                  </Button>
                  <Button
                    :disabled="editBlocked(asItem(record))"
                    size="small"
                    type="link"
                    @click="toggleItemActive(asItem(record))"
                  >
                    {{ record.isActive ? '停用' : '启用' }}
                  </Button>
                </template>
              </template>
            </Table>
          </div>
        </div>
      </Card>

      <DictionaryItemModal
        :dictionary-name="dictState.dictionary?.name ?? ''"
        :error="dictState.error"
        :item="dictState.item"
        :mode="dictState.mode"
        :open="dictState.open"
        :submitting="dictState.submitting"
        @cancel="dictState.open = false"
        @submit="submitDictionaryItem"
      />
    </template>
  </div>
</template>
