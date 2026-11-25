<script lang="ts" setup>
import type { TouristImportMode, TouristImportPreview } from '@erp/contracts';

import { computed, ref, watch } from 'vue';

import { Alert, Button, Descriptions, DescriptionsItem, Modal, Radio, RadioGroup, Table } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  deltaParts,
  hasDelta,
  labelKeyOf,
  rosterDelta,
  TOURIST_DOCUMENT_TYPE_LABEL_KEYS,
  TOURIST_GENDER_LABEL_KEYS,
  TOURIST_PERSON_TYPE_LABEL_KEYS,
} from './tourist-display';

const props = defineProps<{ open: boolean; orderId: string }>();

const emit = defineEmits<{
  imported: [];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const csv = ref('');
const filename = ref('');
const mode = ref<TouristImportMode>('append');
const preview = ref<null | TouristImportPreview>(null);
const reading = ref(false);
const importing = ref(false);
const error = ref('');

const columns = [
  { dataIndex: 'line', key: 'line', title: $t('shell.tourists.importColLine'), width: 56 },
  { dataIndex: 'name', key: 'name', title: $t('shell.tourists.formName') },
  { key: 'document', title: $t('shell.tourists.importColDocument'), width: 170 },
  { key: 'personType', title: $t('shell.tourists.importColPersonType'), width: 72 },
  { dataIndex: 'age', key: 'age', title: $t('shell.tourists.formAge'), width: 64 },
  { key: 'gender', title: $t('shell.tourists.formGender'), width: 64 },
];
const errorColumns = [
  { dataIndex: 'line', key: 'line', title: $t('shell.tourists.importColLine'), width: 56 },
  { dataIndex: 'message', key: 'message', title: $t('shell.tourists.importColProblem') },
];

const blocked = computed(
  () => !preview.value || preview.value.errors.length > 0 || preview.value.validRows === 0,
);
const delta = computed(() => (preview.value ? rosterDelta(preview.value.summary) : null));

function formatDelta(d: { adult: number; child: number }): string {
  const parts = deltaParts(d);
  const pieces: string[] = [];
  if (parts.adultCount) {
    pieces.push($t('shell.tourists.deltaAdult', {
      count: parts.adultCount,
      direction: parts.adultMore ? $t('shell.tourists.deltaMore') : $t('shell.tourists.deltaLess'),
    }));
  }
  if (parts.childCount) {
    pieces.push($t('shell.tourists.deltaChild', {
      count: parts.childCount,
      direction: parts.childMore ? $t('shell.tourists.deltaMore') : $t('shell.tourists.deltaLess'),
    }));
  }
  return pieces.join($t('shell.tourists.deltaJoin'));
}

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

/** 文件只在浏览器读成文本，不上传：服务端需要能重新解析的原文。 */
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
    error.value = $t('shell.tourists.fileReadFailed');
  } finally {
    reading.value = false;
  }
}

async function runPreview() {
  if (!csv.value) return;
  error.value = '';
  reading.value = true;
  try {
    preview.value = await authStore.api.call('previewTouristImport', {
      body: { csv: csv.value, mode: mode.value },
      params: { orderId: props.orderId },
    });
  } catch (error_) {
    preview.value = null;
    error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.tourists.previewFailed');
  } finally {
    reading.value = false;
  }
}

/** 换模式会改变「哪些行算重复」，旧预览必须作废。 */
watch(mode, () => {
  if (csv.value) void runPreview();
});

async function submit() {
  if (!preview.value || blocked.value || importing.value) return;
  importing.value = true;
  error.value = '';
  try {
    await authStore.api.call('importTourists', {
      body: { csv: csv.value, mode: mode.value },
      params: { orderId: props.orderId },
    });
    emit('imported');
    emit('update:open', false);
  } catch (error_) {
    if (error_ instanceof ApiClientError && error_.code === 'TOURIST_DOCUMENT_CONFLICT') {
      error.value = $t('shell.tourists.docConflictImport');
    } else if (error_ instanceof ApiClientError && error_.code === 'VALIDATION_ERROR') {
      error.value = $t('shell.tourists.importInvalid');
    } else {
      error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.tourists.importFailed');
    }
  } finally {
    importing.value = false;
  }
}

/** 模板带 UTF-8 BOM，前端只负责落成文件。 */
async function downloadTemplate() {
  try {
    const template = await authStore.api.call('getTouristImportTemplate');
    const blob = new Blob([template.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = template.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    error.value = $t('shell.tourists.templateFailed');
  }
}

function close() {
  if (importing.value) return;
  emit('update:open', false);
}

function label(value: unknown, keys: Record<string, string>): string {
  const key = labelKeyOf(keys, value);
  return key.startsWith('shell.') ? $t(key) : key;
}
</script>

<template>
  <Modal
    :confirm-loading="importing"
    :mask-closable="!importing"
    :ok-button-props="{ disabled: blocked }"
    :ok-text="mode === 'replace' ? $t('shell.tourists.replaceImport') : $t('shell.tourists.appendImport')"
    :cancel-text="$t('shell.tourists.cancel')"
    :open="open"
    :title="$t('shell.tourists.importTitle')"
    :width="860"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="error" class="mb-3" show-icon type="error" :message="error" role="alert" />

    <div class="mb-3 flex items-center gap-3">
      <label class="file-picker">
        <input accept=".csv,text/csv" type="file" :disabled="reading || importing" @change="onFile" />
        <Button :loading="reading">{{ $t('shell.tourists.chooseFile') }}</Button>
      </label>
      <span class="flex-1 text-sm text-muted-foreground">
        {{ filename || $t('shell.tourists.noFile') }}
      </span>
      <button class="text-sm text-primary" type="button" @click="downloadTemplate">
        {{ $t('shell.tourists.downloadTemplate') }}
      </button>
    </div>

    <RadioGroup v-model:value="mode" :disabled="importing" class="mb-2 flex gap-4">
      <Radio value="append">{{ $t('shell.tourists.modeAppend') }}</Radio>
      <Radio value="replace">{{ $t('shell.tourists.modeReplace') }}</Radio>
    </RadioGroup>
    <p class="mb-4 text-xs leading-relaxed text-muted-foreground">
      {{ $t('shell.tourists.importHint') }}
    </p>

    <template v-if="preview">
      <Alert
        v-if="preview.errors.length > 0"
        class="mb-3"
        show-icon
        type="error"
        :message="$t('shell.tourists.importErrors', { count: preview.errors.length })"
        :description="$t('shell.tourists.importErrorsHint')"
      />
      <Descriptions class="mb-3" :column="3" size="small" bordered>
        <DescriptionsItem :label="$t('shell.tourists.importTotalRows')">{{ preview.totalRows }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.tourists.importValidRows')">{{ preview.validRows }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.tourists.importErrorRows')">{{ preview.errors.length }}</DescriptionsItem>
        <DescriptionsItem :label="$t('shell.tourists.importAfterRoster')">
          {{ $t('shell.tourists.importRosterCount', { count: preview.summary.personCount }) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.tourists.importDeclared')">
          {{ $t('shell.tourists.importDeclaredCount', { count: preview.summary.declaredAdultCount + preview.summary.declaredChildCount }) }}
        </DescriptionsItem>
        <DescriptionsItem :label="$t('shell.tourists.importDelta')">
          <span v-if="delta && hasDelta(delta)">{{ formatDelta(delta) }}</span>
          <span v-else>{{ $t('shell.tourists.deltaNone') }}</span>
        </DescriptionsItem>
      </Descriptions>

      <Table
        v-if="preview.errors.length > 0"
        class="mb-3"
        :columns="errorColumns"
        :data-source="preview.errors"
        :pagination="false"
        row-key="line"
        size="small"
      />

      <Table
        :columns="columns"
        :data-source="preview.rows"
        :pagination="false"
        :scroll="{ y: 260 }"
        :locale="{ emptyText: $t('shell.tourists.importNoValidRows') }"
        row-key="line"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'document'">
            <span v-if="record.documentType">
              {{ label(record.documentType, TOURIST_DOCUMENT_TYPE_LABEL_KEYS) }}
              {{ record.documentNumberMasked ?? '' }}
            </span>
            <span v-else class="text-muted-foreground">{{ $t('shell.tourists.noDocument') }}</span>
          </template>
          <template v-else-if="column.key === 'personType'">
            {{ label(record.personType, TOURIST_PERSON_TYPE_LABEL_KEYS) }}
          </template>
          <template v-else-if="column.key === 'gender'">
            {{ label(record.gender, TOURIST_GENDER_LABEL_KEYS) }}
          </template>
        </template>
      </Table>
    </template>
  </Modal>
</template>
