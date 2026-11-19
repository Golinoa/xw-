<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { Tourist, TouristRoster } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import TouristFormModal from './TouristFormModal.vue';
import TouristImportModal from './TouristImportModal.vue';
import {
  describeRosterDelta,
  documentTypeLabel,
  genderLabel,
  personTypeLabel,
  rosterDelta,
} from './tourist-display';

const props = defineProps<{
  orderId: string;
  /** 仅用于控制入口；服务端仍会独立校验 order.write。 */
  canWrite: boolean;
}>();

const auth = useAuthStore();
const roster = ref<TouristRoster | null>(null);
const loading = ref(false);
const error = ref('');
const formOpen = ref(false);
const editing = ref<Tourist | null>(null);
const importOpen = ref(false);
const deletingId = ref<string | null>(null);

let requestSeq = 0;

const columns = [
  { title: '姓名', dataIndex: 'name', key: 'name' },
  { title: '证件', key: 'document', width: 190 },
  { title: '类型', key: 'personType', width: 70 },
  { title: '年龄', key: 'age', width: 64 },
  { title: '性别', key: 'gender', width: 64 },
  { title: '手机', key: 'phone', width: 130 },
  { title: '备注', dataIndex: 'remark', key: 'remark' },
  { title: '操作', key: 'actions', width: 110 },
];

async function load() {
  const seq = ++requestSeq;
  loading.value = roster.value === null;
  error.value = '';
  try {
    const result = await auth.api.call('listTourists', { params: { orderId: props.orderId } });
    if (seq !== requestSeq) return;
    roster.value = result.roster;
  } catch (cause) {
    if (seq !== requestSeq) return;
    error.value = cause instanceof ApiClientError ? cause.message : '游客名单加载失败';
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

const mismatch = computed(
  () => delta.value !== null && (delta.value.adult !== 0 || delta.value.child !== 0),
);

/**
 * 导出当前名单为 CSV。
 *
 * 用的是页面上已经拿到的数据，不额外请求一份「导出专用」的名单——
 * 两份数据迟早会不一致。证件号/手机号拿到的就是接口给的值：
 * 没有敏感字段权限时接口只回掩码，导出也只能导出掩码，不绕过脱敏。
 */
function csvCell(value: string | number): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportRoster() {
  const items = roster.value?.items ?? [];
  if (items.length === 0) {
    message.info('名单为空，没有可导出的内容');
    return;
  }
  const header = ['姓名', '类型', '年龄', '性别', '证件类型', '证件号', '手机', '备注'];
  const rows = items.map((tourist) => [
    tourist.name,
    personTypeLabel(tourist.personType),
    tourist.age ?? '',
    genderLabel(tourist.gender),
    tourist.documentType ? documentTypeLabel(tourist.documentType) : '',
    tourist.documentNumber ?? tourist.documentNumberMasked ?? '',
    tourist.phone ?? tourist.phoneMasked ?? '',
    tourist.remark ?? '',
  ]);
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `游客名单_${props.orderId}.csv`;
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
    await auth.api.call('deleteTourist', {
      params: { orderId: props.orderId, touristId: tourist.id },
    });
    message.success(`已移除游客「${tourist.name}」`);
    await load();
  } catch (cause) {
    message.error(cause instanceof ApiClientError ? cause.message : '删除失败，请稍后重试');
  } finally {
    deletingId.value = null;
  }
}

async function onSaved() {
  await load();
}
</script>

<template>
  <div class="roster">
    <div class="roster-head">
      <h4 class="section-title">
        游客名单<span class="count">（{{ roster?.total ?? 0 }} 人）</span>
      </h4>
      <a-space>
        <a-button size="small" @click="exportRoster">导出名单</a-button>
        <template v-if="canWrite">
          <a-button size="small" @click="importOpen = true">CSV 导入</a-button>
          <a-button size="small" type="primary" @click="openCreate">添加游客</a-button>
        </template>
      </a-space>
    </div>

    <a-alert v-if="error" type="error" show-icon :message="error">
      <template #action>
        <a-button size="small" @click="load">重试</a-button>
      </template>
    </a-alert>

    <!-- 人数不一致只警告：需求明确不阻止保存，所以这里不给任何「修复」按钮。 -->
    <a-alert
      v-else-if="mismatch && delta"
      class="roster-hint"
      type="warning"
      show-icon
      :message="`名单与申报人数不一致：${describeRosterDelta(delta)}`"
      description="按需求这里只提醒，不影响订单保存。"
    />
    <p v-else-if="roster" class="roster-hint muted">
      申报成人 {{ roster.declaredAdultCount }} / 儿童 {{ roster.declaredChildCount }}， 名单成人
      {{ roster.adultCount }} / 儿童 {{ roster.childCount }}。
    </p>

    <a-table
      size="small"
      row-key="id"
      :columns="columns"
      :data-source="roster?.items ?? []"
      :pagination="false"
      :loading="loading"
      :locale="{ emptyText: canWrite ? '还没有游客，点右上角添加或导入' : '还没有游客' }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'document'">
          <span v-if="record.documentType">
            {{ documentTypeLabel(record.documentType) }}
            {{ record.documentNumber ?? record.documentNumberMasked ?? '' }}
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
        <template v-else-if="column.key === 'phone'">
          {{ record.phone ?? record.phoneMasked ?? '—' }}
        </template>
        <template v-else-if="column.key === 'remark'">{{ record.remark ?? '—' }}</template>
        <template v-else-if="column.key === 'actions'">
          <a-space v-if="canWrite" :size="4">
            <a-button type="link" size="small" @click="openEdit(record)">编辑</a-button>
            <a-popconfirm
              title="从名单里移除这个人？"
              ok-text="移除"
              cancel-text="取消"
              @confirm="remove(record)"
            >
              <a-button type="link" size="small" danger :loading="deletingId === record.id">
                删除
              </a-button>
            </a-popconfirm>
          </a-space>
          <span v-else class="muted">—</span>
        </template>
      </template>
    </a-table>

    <TouristFormModal
      v-model:open="formOpen"
      :order-id="orderId"
      :tourist="editing"
      @saved="onSaved"
    />
    <TouristImportModal v-model:open="importOpen" :order-id="orderId" @imported="load" />
  </div>
</template>

<style scoped>
.roster-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-12);
}

.section-title {
  margin: var(--space-24) 0 var(--space-12);
  color: var(--color-heading);
  font-size: var(--font-size-md);
  font-weight: 600;
}

.count {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
  font-weight: 400;
}

.roster-hint {
  margin-bottom: var(--space-12);
}

.muted {
  color: var(--color-secondary-text);
}
</style>
