<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { DEFAULT_PAGE_SIZE, LEAD_STAGES, type Lead, type LeadStage } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const items = ref<Lead[]>([]);
const total = ref(0);
const createOpen = ref(false);
const followUpOpen = ref(false);
const current = ref<Lead | null>(null);
const saving = ref(false);

const STAGE_LABELS: Record<LeadStage, string> = {
  new: '新线索',
  contacting: '需求沟通',
  quoting: '报价中',
  proposal: '方案确认',
  won: '已成单',
  lost: '已放弃',
};

const filters = reactive({
  inPool: false,
  stage: '' as LeadStage | '',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
});

const createForm = reactive({
  name: '',
  phone: '',
  source: '',
  destination: '',
  departureCity: '',
  tripType: '跟团游',
  intentLevel: '中',
  expectedDate: '',
  budgetMin: 0,
  budgetMax: 0,
  adultCount: 2,
  childCount: 0,
  remark: '',
});
const followUpForm = reactive({ stage: 'contacting' as LeadStage, detail: '', nextFollowUpAt: '' });

const columns = [
  { title: '线索', key: 'name', dataIndex: 'name' },
  { title: '来源/目的地', key: 'source', dataIndex: 'source' },
  { title: '预算', key: 'budget', dataIndex: 'budgetMax' },
  { title: '阶段', key: 'stage', dataIndex: 'stage' },
  { title: '负责人', key: 'ownerName', dataIndex: 'ownerName' },
  { title: '创建时间', key: 'createdAt', dataIndex: 'createdAt' },
  { title: '操作', key: 'action', width: 200 },
];

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await auth.api.call('listLeads', {
      body: {
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        order: 'desc',
        inPool: filters.inPool,
        ...(filters.stage ? { stage: filters.stage } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (cause) {
    items.value = [];
    total.value = 0;
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

async function createLead() {
  saving.value = true;
  try {
    await auth.api.call('createLead', { body: createForm });
    message.success('线索已创建');
    createOpen.value = false;
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '创建失败，请重试';
  } finally {
    saving.value = false;
  }
}

async function action(endpoint: 'claimLead' | 'convertLead', lead: Lead) {
  try {
    await auth.api.call(endpoint, {
      body:
        endpoint === 'claimLead' ? { leadId: lead.id, version: lead.version } : { leadId: lead.id },
    });
    message.success(endpoint === 'claimLead' ? '已认领' : '已转换为客户');
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '操作失败，请重试';
  }
}

function openFollowUp(lead: Lead) {
  current.value = lead;
  followUpForm.stage = lead.stage;
  followUpForm.detail = '';
  followUpForm.nextFollowUpAt = '';
  followUpOpen.value = true;
}

async function submitFollowUp() {
  if (!current.value) return;
  saving.value = true;
  try {
    await auth.api.call('followUpLead', {
      body: {
        leadId: current.value.id,
        stage: followUpForm.stage,
        detail: followUpForm.detail,
        ...(followUpForm.nextFollowUpAt ? { nextFollowUpAt: followUpForm.nextFollowUpAt } : {}),
      },
    });
    message.success('跟进已记录');
    followUpOpen.value = false;
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '记录失败，请重试';
  } finally {
    saving.value = false;
  }
}

function changePage(page: number) {
  filters.page = page;
  void load();
}

onMounted(load);
</script>

<template>
  <a-card title="CRM 线索与公海" class="lead-card">
    <p class="note">
      跟进与阶段变更会追加到时间线；无跟进满 7
      天自动回公海。转客户是幂等的，重复操作不会建第二个客户。
    </p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>

    <div class="toolbar">
      <a-radio-group
        v-model:value="filters.inPool"
        @change="
          filters.page = 1;
          load();
        "
      >
        <a-radio-button :value="false">我的线索</a-radio-button>
        <a-radio-button :value="true">公海</a-radio-button>
      </a-radio-group>
      <a-select
        v-model:value="filters.stage"
        placeholder="阶段（全部）"
        allow-clear
        class="stage-select"
        @change="
          filters.page = 1;
          load();
        "
      >
        <a-select-option v-for="stage in LEAD_STAGES" :key="stage" :value="stage">
          {{ STAGE_LABELS[stage] }}
        </a-select-option>
      </a-select>
      <span class="result-count">共 {{ total }} 条</span>
      <a-button type="primary" @click="createOpen = true">新建线索</a-button>
    </div>

    <a-table
      :data-source="items"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <div class="lead-name">{{ record.name }}</div>
          <div class="sub">{{ record.phone }}</div>
        </template>
        <template v-else-if="column.key === 'source'">
          {{ record.source }} → {{ record.destination }}
        </template>
        <template v-else-if="column.key === 'budget'">
          {{ formatMoney(record.budgetMin) }} ~ {{ formatMoney(record.budgetMax) }}
        </template>
        <template v-else-if="column.key === 'stage'">
          <a-tag>{{ STAGE_LABELS[record.stage as LeadStage] ?? record.stage }}</a-tag>
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ formatDateTime(record.createdAt) }}
        </template>
        <template v-else-if="column.key === 'action'">
          <a-space>
            <a-button v-if="!record.ownerId" type="link" @click="action('claimLead', record)">
              认领
            </a-button>
            <a-button v-else type="link" @click="openFollowUp(record)">跟进</a-button>
            <a-button
              v-if="record.stage === 'won' && !record.convertedCustomerId"
              type="link"
              @click="action('convertLead', record)"
            >
              转客户
            </a-button>
          </a-space>
        </template>
      </template>
      <template #emptyText><div class="empty">暂无线索</div></template>
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

    <a-modal
      v-model:open="createOpen"
      title="新建线索"
      ok-text="创建"
      :confirm-loading="saving"
      width="640px"
      @ok="createLead"
    >
      <a-form layout="vertical">
        <a-form-item label="姓名"><a-input v-model:value="createForm.name" /></a-form-item>
        <a-form-item label="手机"><a-input v-model:value="createForm.phone" /></a-form-item>
        <div class="form-row">
          <a-form-item label="来源"><a-input v-model:value="createForm.source" /></a-form-item>
          <a-form-item label="目的地"
            ><a-input v-model:value="createForm.destination"
          /></a-form-item>
        </div>
        <div class="form-row">
          <a-form-item label="出发城市"
            ><a-input v-model:value="createForm.departureCity"
          /></a-form-item>
          <a-form-item label="出游类型"
            ><a-input v-model:value="createForm.tripType"
          /></a-form-item>
        </div>
        <div class="form-row">
          <a-form-item label="意向程度"
            ><a-input v-model:value="createForm.intentLevel"
          /></a-form-item>
          <a-form-item label="期望日期"
            ><a-input v-model:value="createForm.expectedDate" type="date"
          /></a-form-item>
        </div>
        <div class="form-row">
          <a-form-item label="预算下限"
            ><a-input-number v-model:value="createForm.budgetMin" :min="0" class="full"
          /></a-form-item>
          <a-form-item label="预算上限"
            ><a-input-number v-model:value="createForm.budgetMax" :min="0" class="full"
          /></a-form-item>
        </div>
        <a-form-item label="备注"><a-input v-model:value="createForm.remark" /></a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="followUpOpen"
      title="记录跟进"
      ok-text="保存"
      :confirm-loading="saving"
      @ok="submitFollowUp"
    >
      <a-form layout="vertical">
        <a-form-item label="阶段">
          <a-select v-model:value="followUpForm.stage">
            <a-select-option v-for="stage in LEAD_STAGES" :key="stage" :value="stage">
              {{ STAGE_LABELS[stage] }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="跟进内容"><a-input v-model:value="followUpForm.detail" /></a-form-item>
        <a-form-item label="下次跟进时间（可选）">
          <a-input v-model:value="followUpForm.nextFollowUpAt" type="datetime-local" />
        </a-form-item>
      </a-form>
    </a-modal>
  </a-card>
</template>

<style scoped>
.lead-card {
  max-width: 1160px;
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
.stage-select {
  width: 160px;
}
.result-count {
  margin-left: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.lead-name {
  font-weight: 600;
}
.sub {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.form-row {
  display: flex;
  gap: var(--space-12);
}
.form-row > * {
  flex: 1;
}
.full {
  width: 100%;
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
