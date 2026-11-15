<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { TouristImportMode, TouristImportPreview } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import {
  describeRosterDelta,
  documentTypeLabel,
  genderLabel,
  personTypeLabel,
  rosterDelta,
} from './tourist-display';

const props = defineProps<{
  open: boolean;
  orderId: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  imported: [];
}>();

const auth = useAuthStore();
const csv = ref('');
const filename = ref('');
const mode = ref<TouristImportMode>('append');
const preview = ref<TouristImportPreview | null>(null);
const reading = ref(false);
const importing = ref(false);
const error = ref('');

const columns = [
  { title: '行', dataIndex: 'line', key: 'line', width: 56 },
  { title: '姓名', dataIndex: 'name', key: 'name' },
  { title: '证件', key: 'document', width: 170 },
  { title: '类型', key: 'personType', width: 72 },
  { title: '年龄', dataIndex: 'age', key: 'age', width: 64 },
  { title: '性别', key: 'gender', width: 64 },
];

const errorColumns = [
  { title: '行', dataIndex: 'line', key: 'line', width: 56 },
  { title: '问题', dataIndex: 'message', key: 'message' },
];

const blocked = computed(
  () => !preview.value || preview.value.errors.length > 0 || preview.value.validRows === 0,
);

const delta = computed(() => (preview.value ? rosterDelta(preview.value.summary) : null));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    csv.value = '';
    filename.value = '';
    mode.value = 'append';
    preview.value = null;
    error.value = '';
    reading.value = false;
    importing.value = false;
  },
  { immediate: true },
);

/** 文件只在浏览器里读成文本，不上传：服务端需要的是能重新解析的原文。 */
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  error.value = '';
  reading.value = true;
  try {
    csv.value = await file.text();
    filename.value = file.name;
    preview.value = null;
    input.value = '';
    await runPreview();
  } catch {
    error.value = '文件读取失败，请确认它是 CSV 文本文件';
  } finally {
    reading.value = false;
  }
}

async function runPreview() {
  if (!csv.value) return;
  error.value = '';
  reading.value = true;
  try {
    preview.value = await auth.api.call('previewTouristImport', {
      params: { orderId: props.orderId },
      body: { csv: csv.value, mode: mode.value },
    });
  } catch (cause) {
    preview.value = null;
    error.value = cause instanceof ApiClientError ? cause.message : '解析失败，请稍后重试';
  } finally {
    reading.value = false;
  }
}

watch(mode, () => {
  // 换模式会改变「哪些行算重复」，旧预览必须作废，否则显示的是一份不再成立的结果。
  if (csv.value) void runPreview();
});

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'TOURIST_DOCUMENT_CONFLICT') return '有证件号已经在名单里，请先处理后重试';
    if (cause.code === 'VALIDATION_ERROR') return '文件里有不合法的行，请修正后重新选择文件';
    return cause.message;
  }
  return '导入失败，请稍后重试';
}

async function submit() {
  if (!preview.value || blocked.value || importing.value) return;
  importing.value = true;
  error.value = '';
  try {
    const result = await auth.api.call('importTourists', {
      params: { orderId: props.orderId },
      body: { csv: csv.value, mode: mode.value },
    });
    message.success(
      mode.value === 'replace'
        ? `已覆盖名单：删除 ${result.deleted} 人，写入 ${result.inserted} 人`
        : `已导入 ${result.inserted} 人`,
    );
    emit('imported');
    emit('update:open', false);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    importing.value = false;
  }
}

function close() {
  if (importing.value) return;
  emit('update:open', false);
}

/** 模板带 UTF-8 BOM，前端只负责把它落成文件。 */
async function downloadTemplate() {
  try {
    const template = await auth.api.call('getTouristImportTemplate');
    const blob = new Blob([template.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = template.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    message.error('模板下载失败，请稍后重试');
  }
}
</script>

<template>
  <a-modal
    :open="open"
    title="导入游客名单"
    :width="860"
    :ok-text="mode === 'replace' ? '覆盖导入' : '追加导入'"
    cancel-text="取消"
    :ok-button-props="{ disabled: blocked }"
    :confirm-loading="importing"
    :mask-closable="!importing"
    @ok="submit"
    @cancel="close"
  >
    <a-alert v-if="error" class="import-error" type="error" show-icon :message="error" />

    <div class="toolbar">
      <label class="file-picker">
        <input
          type="file"
          accept=".csv,text/csv"
          :disabled="reading || importing"
          @change="onFile"
        />
        <a-button :loading="reading">选择 CSV 文件</a-button>
      </label>
      <span class="file-name">{{ filename || '尚未选择文件' }}</span>
      <a-button type="link" @click="downloadTemplate">下载模板</a-button>
    </div>

    <a-radio-group v-model:value="mode" :disabled="importing" class="mode-row">
      <a-radio value="append">追加到现有名单</a-radio>
      <a-radio value="replace">覆盖现有名单</a-radio>
    </a-radio-group>
    <p class="hint">
      覆盖会先清空这份名单再写入，无法撤销。导入是整批的：只要有一行出错，整份文件都不会写入。
      证件类型填 身份证/护照/港澳通行证/台胞证；成人/儿童 必填；性别填 男/女，留空为未知。
    </p>

    <template v-if="preview">
      <a-alert
        v-if="preview.errors.length > 0"
        class="import-error"
        type="error"
        show-icon
        :message="`${preview.errors.length} 行有问题，整批不会导入`"
        description="按行号修改文件后重新选择即可。"
      />
      <a-descriptions :column="3" size="small" bordered class="summary">
        <a-descriptions-item label="数据行">{{ preview.totalRows }}</a-descriptions-item>
        <a-descriptions-item label="有效">{{ preview.validRows }}</a-descriptions-item>
        <a-descriptions-item label="错误">{{ preview.errors.length }}</a-descriptions-item>
        <a-descriptions-item label="导入后名单">
          {{ preview.summary.personCount }} 人（成人 {{ preview.summary.adultCount }} / 儿童
          {{ preview.summary.childCount }}）
        </a-descriptions-item>
        <a-descriptions-item label="订单申报">
          {{ preview.summary.declaredAdultCount + preview.summary.declaredChildCount }} 人（成人
          {{ preview.summary.declaredAdultCount }} / 儿童 {{ preview.summary.declaredChildCount }}）
        </a-descriptions-item>
        <a-descriptions-item label="人数差额">
          <span v-if="delta && (delta.adult !== 0 || delta.child !== 0)"
            >{{ describeRosterDelta(delta) }}（只提醒，不影响导入）</span
          >
          <span v-else>一致</span>
        </a-descriptions-item>
      </a-descriptions>

      <a-table
        v-if="preview.errors.length > 0"
        class="error-table"
        size="small"
        row-key="line"
        :columns="errorColumns"
        :data-source="preview.errors"
        :pagination="false"
      />

      <a-table
        size="small"
        row-key="line"
        :columns="columns"
        :data-source="preview.rows"
        :pagination="false"
        :scroll="{ y: 260 }"
        :locale="{ emptyText: '没有解析出有效行' }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'document'">
            <span v-if="record.documentType">
              {{ documentTypeLabel(record.documentType) }}
              {{ record.documentNumberMasked ?? '' }}
            </span>
            <span v-else class="muted">无证件</span>
          </template>
          <template v-else-if="column.key === 'personType'">
            {{ personTypeLabel(record.personType) }}
          </template>
          <template v-else-if="column.key === 'age'">{{ record.age ?? '—' }}</template>
          <template v-else-if="column.key === 'gender'">
            {{ genderLabel(record.gender) }}
          </template>
        </template>
      </a-table>
    </template>
  </a-modal>
</template>

<style scoped>
.import-error {
  margin-bottom: var(--space-12);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  margin-bottom: var(--space-12);
}

.file-picker input {
  display: none;
}

.file-name {
  flex: 1;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.mode-row {
  display: flex;
  gap: var(--space-16);
}

.hint {
  margin: var(--space-8) 0 var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
  line-height: 1.7;
}

.summary {
  margin-bottom: var(--space-12);
}

.error-table {
  margin-bottom: var(--space-12);
}

.muted {
  color: var(--color-secondary-text);
}
</style>
