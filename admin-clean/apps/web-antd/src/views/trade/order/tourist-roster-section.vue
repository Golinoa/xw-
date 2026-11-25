<script lang="ts" setup>
import type { Tourist, TouristRoster } from '@erp/contracts';

import { computed, ref, watch } from 'vue';

import { Alert, Button, Popconfirm, Space, Table } from 'ant-design-vue';

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
} from '../tourists/tourist-display';
import TouristFormModal from '../tourists/tourist-form-modal.vue';
import TouristImportModal from '../tourists/tourist-import-modal.vue';

/**
 * 游客名单区块。订单详情与独立游客页共用同一份实现：表单/导入组件也复用 tourists 下的，
 * 这里只负责按 orderId 拉取、删除、导出与差额提示。
 */
const props = defineProps<{
  canWrite: boolean;
  orderId: string;
  /** 独立页可隐藏「导出」以外的重复标题；订单详情里显示。 */
  showTitle?: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const authStore = useAuthStore();
const roster = ref<null | TouristRoster>(null);
const loading = ref(false);
const error = ref('');
const formOpen = ref(false);
const editing = ref<null | Tourist>(null);
const importOpen = ref(false);
const deletingId = ref<null | string>(null);

let requestSeq = 0;

const columns = [
  { dataIndex: 'name', key: 'name', title: $t('shell.tourists.formName') },
  { key: 'document', title: $t('shell.tourists.importColDocument'), width: 190 },
  { key: 'personType', title: $t('shell.tourists.importColPersonType'), width: 70 },
  { key: 'age', title: $t('shell.tourists.formAge'), width: 64 },
  { key: 'gender', title: $t('shell.tourists.formGender'), width: 64 },
  { key: 'phone', title: $t('shell.tourists.formPhone'), width: 130 },
  { dataIndex: 'remark', key: 'remark', title: $t('shell.tourists.formRemark') },
  { key: 'actions', title: $t('shell.tourists.colActions'), width: 110 },
];

async function load() {
  const seq = ++requestSeq;
  loading.value = roster.value === null;
  error.value = '';
  try {
    const result = await authStore.api.call('listTourists', { params: { orderId: props.orderId } });
    if (seq !== requestSeq) return;
    roster.value = result.roster;
  } catch (error_) {
    if (seq !== requestSeq) return;
    error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.tourists.loadFailed');
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => props.orderId,
  () => {
    roster.value = null;
    void load();
  },
  { immediate: true },
);

const delta = computed(() => (roster.value ? rosterDelta(roster.value) : null));
const mismatch = computed(() => delta.value !== null && hasDelta(delta.value));

function formatDelta(d: { adult: number; child: number }): string {
  const parts = deltaParts(d);
  const pieces: string[] = [];
  if (parts.adultCount) {
    pieces.push(
      $t('shell.tourists.deltaAdult', {
        count: parts.adultCount,
        direction: parts.adultMore ? $t('shell.tourists.deltaMore') : $t('shell.tourists.deltaLess'),
      }),
    );
  }
  if (parts.childCount) {
    pieces.push(
      $t('shell.tourists.deltaChild', {
        count: parts.childCount,
        direction: parts.childMore ? $t('shell.tourists.deltaMore') : $t('shell.tourists.deltaLess'),
      }),
    );
  }
  return pieces.join($t('shell.tourists.deltaJoin'));
}

/** 导出用页面已有数据，不额外请求「导出专用」名单——两份数据迟早不一致。 */
function csvCell(value: number | string): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function label(value: unknown, keys: Record<string, string>): string {
  const key = labelKeyOf(keys, value);
  return key.startsWith('shell.') ? $t(key) : key;
}

function exportRoster() {
  const items = roster.value?.items ?? [];
  if (items.length === 0) {
    error.value = $t('shell.tourists.exportEmpty');
    return;
  }
  const header = [
    $t('shell.tourists.formName'),
    $t('shell.tourists.importColPersonType'),
    $t('shell.tourists.formAge'),
    $t('shell.tourists.formGender'),
    $t('shell.tourists.formDocType'),
    $t('shell.tourists.formDocNumber'),
    $t('shell.tourists.formPhone'),
    $t('shell.tourists.formRemark'),
  ];
  const rows = items.map((tourist) => [
    tourist.name,
    label(tourist.personType, TOURIST_PERSON_TYPE_LABEL_KEYS),
    tourist.age ?? '',
    label(tourist.gender, TOURIST_GENDER_LABEL_KEYS),
    tourist.documentType ? label(tourist.documentType, TOURIST_DOCUMENT_TYPE_LABEL_KEYS) : '',
    tourist.documentNumber ?? tourist.documentNumberMasked ?? '',
    tourist.phone ?? tourist.phoneMasked ?? '',
    tourist.remark ?? '',
  ]);
  const lines = [header, ...rows].map((row) => row.map((cell) => csvCell(cell)).join(','));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tourists-${props.orderId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}

function openEdit(tourist: Tourist) {
  editing.value = tourist;
  formOpen.value = true;
}

async function remove(tourist: Tourist) {
  if (deletingId.value) return;
  deletingId.value = tourist.id;
  try {
    await authStore.api.call('deleteTourist', {
      params: { orderId: props.orderId, touristId: tourist.id },
    });
    await load();
    emit('changed');
  } catch (error_) {
    error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.tourists.deleteFailed');
  } finally {
    deletingId.value = null;
  }
}

async function onSaved() {
  await load();
  emit('changed');
}

async function onImported() {
  await load();
  emit('changed');
}
</script>

<template>
  <div>
    <div class="mb-3 flex items-center justify-between gap-3">
      <h4 v-if="showTitle !== false" class="m-0 text-base font-semibold">
        {{ $t('shell.tourists.rosterTitle') }}
        <span class="text-sm font-normal text-muted-foreground">({{ roster?.total ?? 0 }})</span>
      </h4>
      <Space :size="8" wrap>
        <Button size="small" @click="exportRoster">{{ $t('shell.tourists.export') }}</Button>
        <template v-if="canWrite">
          <Button size="small" @click="importOpen = true">{{ $t('shell.tourists.importCsv') }}</Button>
          <Button size="small" type="primary" @click="openCreate">{{ $t('shell.tourists.add') }}</Button>
        </template>
      </Space>
    </div>

    <Alert v-if="error" class="mb-3" show-icon type="error" :message="error">
      <template #action>
        <Button size="small" @click="load">{{ $t('shell.common.retry') }}</Button>
      </template>
    </Alert>

    <!-- 人数不一致只警告：需求明确不阻止保存，所以这里不给任何「修复」按钮。 -->
    <Alert
      v-else-if="mismatch && delta"
      class="mb-3"
      show-icon
      type="warning"
      :message="$t('shell.tourists.deltaPrefix', { detail: formatDelta(delta) })"
      :description="$t('shell.tourists.deltaHint')"
    />
    <p v-else-if="roster" class="mb-3 text-xs text-muted-foreground">
      {{ $t('shell.tourists.declaredSummary', {
        declaredAdults: roster.declaredAdultCount,
        declaredChildren: roster.declaredChildCount,
        actualAdults: roster.adultCount,
        actualChildren: roster.childCount,
      }) }}
    </p>

    <Table
      :columns="columns"
      :data-source="roster?.items ?? []"
      :loading="loading"
      :locale="{
        emptyText: canWrite ? $t('shell.tourists.emptyWritable') : $t('shell.tourists.empty'),
      }"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'document'">
          <span v-if="record.documentType">
            {{ label(record.documentType, TOURIST_DOCUMENT_TYPE_LABEL_KEYS) }}
            {{ record.documentNumber ?? record.documentNumberMasked ?? '' }}
          </span>
          <span v-else class="text-muted-foreground">{{ $t('shell.tourists.noDocument') }}</span>
        </template>
        <template v-else-if="column.key === 'personType'">
          {{ label(record.personType, TOURIST_PERSON_TYPE_LABEL_KEYS) }}
        </template>
        <template v-else-if="column.key === 'age'">{{ record.age ?? '—' }}</template>
        <template v-else-if="column.key === 'gender'">
          {{ label(record.gender, TOURIST_GENDER_LABEL_KEYS) }}
        </template>
        <template v-else-if="column.key === 'phone'">
          {{ record.phone ?? record.phoneMasked ?? '—' }}
        </template>
        <template v-else-if="column.key === 'remark'">{{ record.remark ?? '—' }}</template>
        <template v-else-if="column.key === 'actions'">
          <Space v-if="canWrite" :size="4">
            <Button size="small" type="link" @click="openEdit(record as Tourist)">
              {{ $t('shell.tourists.edit') }}
            </Button>
            <Popconfirm
              :cancel-text="$t('shell.common.cancel')"
              :ok-text="$t('shell.tourists.remove')"
              :title="$t('shell.tourists.removeConfirm')"
              @confirm="remove(record as Tourist)"
            >
              <Button danger :loading="deletingId === record.id" size="small" type="link">
                {{ $t('shell.tourists.delete') }}
              </Button>
            </Popconfirm>
          </Space>
          <span v-else class="text-muted-foreground">—</span>
        </template>
      </template>
    </Table>

    <TouristFormModal
      v-model:open="formOpen"
      :order-id="orderId"
      :tourist="editing"
      @saved="onSaved"
    />
    <TouristImportModal v-model:open="importOpen" :order-id="orderId" @imported="onImported" />
  </div>
</template>
