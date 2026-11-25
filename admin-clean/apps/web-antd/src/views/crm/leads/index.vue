<script lang="ts" setup>
import type { Lead, LeadFunnelResponse, LeadStage } from '@erp/contracts';

import { onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import {
  authorizationForRole,
  DEFAULT_PAGE_SIZE,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Alert,
  Button,
  Card,
  Form,
  FormItem,
  Input,
  InputNumber,
  Modal,
  Pagination,
  RadioGroup,
  Select,
  Table,
  Tag,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatDateTime, formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { canConvert, LEAD_STAGE_LABEL_KEYS, LEAD_STAGES_ORDER, stageLabelKey } from './lead-display';

defineOptions({ name: 'CrmLeads' });

const authStore = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const items = ref<Lead[]>([]);
const total = ref(0);
const createOpen = ref(false);
const followUpOpen = ref(false);
const current = ref<Lead | null>(null);
const saving = ref(false);

const canWrite = (() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions.includes(PERMISSIONS.ORDER_WRITE) : false;
})();

const filters = reactive({
  inPool: false,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  stage: '' as '' | LeadStage,
});

const createForm = reactive({
  adultCount: 2,
  budgetMax: 0,
  budgetMin: 0,
  childCount: 0,
  departureCity: '',
  destination: '',
  expectedDate: '',
  intentLevel: '中',
  name: '',
  phone: '',
  remark: '',
  source: '',
  tripType: '跟团游',
});
const followUpForm = reactive({
  detail: '',
  nextFollowUpAt: '',
  stage: 'contacting' as LeadStage,
});

const stageOptions = LEAD_STAGES_ORDER.map((stage) => ({
  label: $t(LEAD_STAGE_LABEL_KEYS[stage]),
  value: stage,
}));

const columns = [
  { dataIndex: 'name', key: 'name', title: $t('shell.leads.colLead') },
  { dataIndex: 'source', key: 'source', title: $t('shell.leads.colSourceDestination') },
  { dataIndex: 'budgetMax', key: 'budget', title: $t('shell.leads.colBudget') },
  { dataIndex: 'stage', key: 'stage', title: $t('shell.leads.colStage'), width: 110 },
  { dataIndex: 'ownerName', key: 'ownerName', title: $t('shell.leads.colOwner'), width: 120 },
  { dataIndex: 'createdAt', key: 'createdAt', title: $t('shell.leads.colCreatedAt'), width: 170 },
  { key: 'action', title: $t('shell.leads.colAction'), width: 200 },
];

/**
 * 阶段统计口径是「区间内新建的线索 + 当前所处阶段」，不是历史到达率——
 * lead_events 只存跟进正文，没有结构化阶段迁移记录，硬解析文本做漏斗就是猜。
 */
const funnel = ref<LeadFunnelResponse | null>(null);

function monthRange() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`,
    to: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}

async function loadFunnel() {
  try {
    funnel.value = await authStore.api.call('getLeadFunnel', { body: monthRange() });
  } catch {
    // 统计失败不该挡住线索列表：卡片留空，列表照常用。
    funnel.value = null;
  }
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await authStore.api.call('listLeads', {
      body: {
        inPool: filters.inPool,
        order: 'desc',
        page: filters.page,
        pageSize: filters.pageSize,
        sort: 'createdAt',
        ...(filters.stage ? { stage: filters.stage } : {}),
      },
    });
    items.value = result.items;
    total.value = result.total;
  } catch (error_) {
    items.value = [];
    total.value = 0;
    errorText.value = error_ instanceof ApiClientError ? error_.message : $t('shell.leads.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function convertToOrder(lead: Lead) {
  try {
    await authStore.api.call('convertLeadToOrder', {
      body: { leadId: lead.id, version: lead.version },
    });
    await Promise.all([load(), loadFunnel()]);
  } catch (error_) {
    errorText.value = error_ instanceof ApiClientError ? error_.message : $t('shell.leads.actionFailed');
  }
}

async function createLead() {
  saving.value = true;
  try {
    await authStore.api.call('createLead', { body: createForm });
    createOpen.value = false;
    await load();
  } catch (error_) {
    errorText.value = error_ instanceof ApiClientError ? error_.message : $t('shell.leads.createFailed');
  } finally {
    saving.value = false;
  }
}

async function action(endpoint: 'claimLead' | 'convertLead', lead: Lead) {
  try {
    await authStore.api.call(endpoint, {
      body:
        endpoint === 'claimLead'
          ? { leadId: lead.id, version: lead.version }
          : { leadId: lead.id },
    });
    await load();
  } catch (error_) {
    errorText.value = error_ instanceof ApiClientError ? error_.message : $t('shell.leads.actionFailed');
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
    await authStore.api.call('followUpLead', {
      body: {
        detail: followUpForm.detail,
        leadId: current.value.id,
        stage: followUpForm.stage,
        ...(followUpForm.nextFollowUpAt ? { nextFollowUpAt: followUpForm.nextFollowUpAt } : {}),
      },
    });
    followUpOpen.value = false;
    await load();
  } catch (error_) {
    errorText.value = error_ instanceof ApiClientError ? error_.message : $t('shell.leads.followUpFailed');
  } finally {
    saving.value = false;
  }
}

function onPoolChange() {
  filters.page = 1;
  void load();
}
function onStageChange() {
  filters.page = 1;
  void load();
}
function onPageChange(page: number, pageSize: number) {
  filters.page = pageSize === filters.pageSize ? page : 1;
  filters.pageSize = pageSize;
  void load();
}

onMounted(() => {
  void load();
  void loadFunnel();
});
</script>

<template>
  <Page :description="$t('shell.leads.description')" :title="$t('shell.menu.crmLeads')">
    <Card>
      <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.leads.note') }}</p>
      <Alert v-if="errorText" class="mb-4" show-icon type="error" :message="errorText" />

      <div v-if="funnel" class="mb-4 flex flex-wrap items-center gap-3 rounded bg-muted p-3 text-sm">
        <span class="text-muted-foreground">{{ $t('shell.leads.funnelTitle') }}</span>
        <span>{{ $t('shell.leads.funnelTotal', { total: funnel.total }) }}</span>
        <span>{{ $t('shell.leads.funnelCustomers', { count: funnel.convertedCustomers }) }}</span>
        <span>{{ $t('shell.leads.funnelOrders', { count: funnel.convertedOrders }) }}</span>
        <Tag v-for="(count, stage) in funnel.stages" :key="stage">
          {{ $t(stageLabelKey(stage)) }} · {{ count }}
        </Tag>
      </div>

      <div class="mb-4 flex flex-wrap items-center gap-3">
        <RadioGroup
          :value="filters.inPool"
          :options="[
            { label: $t('shell.leads.myLeads'), value: false },
            { label: $t('shell.leads.pool'), value: true },
          ]"
          option-type="button"
          @change="(v: unknown) => { filters.inPool = v === true; onPoolChange(); }"
        />
        <Select
          v-model:value="filters.stage"
          allow-clear
          class="w-40"
          :options="stageOptions"
          :placeholder="$t('shell.leads.stagePlaceholder')"
          @change="onStageChange"
        />
        <span class="text-sm text-muted-foreground">{{ $t('shell.leads.total', { total }) }}</span>
        <Button v-if="canWrite" class="ml-auto" type="primary" @click="createOpen = true">
          {{ $t('shell.leads.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :pagination="false"
        :locale="{ emptyText: $t('shell.leads.empty') }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <div class="font-semibold">{{ record.name }}</div>
            <div class="text-sm text-muted-foreground">{{ record.phone }}</div>
          </template>
          <template v-else-if="column.key === 'source'">
            {{ record.source }} → {{ record.destination }}
          </template>
          <template v-else-if="column.key === 'budget'">
            {{ formatMoney(record.budgetMin) }} ~ {{ formatMoney(record.budgetMax) }}
          </template>
          <template v-else-if="column.key === 'stage'">
            <Tag>{{ $t(stageLabelKey(record.stage)) }}</Tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <div v-if="canWrite" class="flex flex-wrap gap-1">
              <Button v-if="!record.ownerId" size="small" type="link" @click="action('claimLead', record as Lead)">
                {{ $t('shell.leads.claim') }}
              </Button>
              <Button v-else size="small" type="link" @click="openFollowUp(record as Lead)">
                {{ $t('shell.leads.followUp') }}
              </Button>
              <Button
                v-if="canConvert(record.stage as LeadStage) && !record.convertedCustomerId"
                size="small"
                type="link"
                @click="action('convertLead', record as Lead)"
              >
                {{ $t('shell.leads.convertCustomer') }}
              </Button>
              <Button
                v-if="canConvert(record.stage as LeadStage) && !record.convertedOrderId"
                size="small"
                type="link"
                @click="convertToOrder(record as Lead)"
              >
                {{ $t('shell.leads.convertOrder') }}
              </Button>
            </div>
            <span v-else class="text-muted-foreground">—</span>
          </template>
        </template>
      </Table>

      <div v-if="total > filters.pageSize" class="mt-4 flex justify-end">
        <Pagination
          :current="filters.page"
          :page-size="filters.pageSize"
          :show-size-changer="false"
          :total="total"
          @change="onPageChange"
        />
      </div>
    </Card>

    <Modal
      :cancel-text="$t('shell.common.cancel')"
      :confirm-loading="saving"
      :ok-text="$t('shell.leads.create')"
      :open="createOpen"
      :title="$t('shell.leads.createTitle')"
      :width="640"
      @cancel="createOpen = false"
      @ok="createLead"
    >
      <Form layout="vertical">
        <div class="grid grid-cols-2 gap-x-4">
          <FormItem html-for="lead-name" :label="$t('shell.leads.formName')">
            <Input id="lead-name" v-model:value="createForm.name" />
          </FormItem>
          <FormItem html-for="lead-phone" :label="$t('shell.leads.formPhone')">
            <Input id="lead-phone" v-model:value="createForm.phone" />
          </FormItem>
          <FormItem html-for="lead-source" :label="$t('shell.leads.formSource')">
            <Input id="lead-source" v-model:value="createForm.source" />
          </FormItem>
          <FormItem html-for="lead-dest" :label="$t('shell.leads.formDestination')">
            <Input id="lead-dest" v-model:value="createForm.destination" />
          </FormItem>
          <FormItem html-for="lead-city" :label="$t('shell.leads.formDepartureCity')">
            <Input id="lead-city" v-model:value="createForm.departureCity" />
          </FormItem>
          <FormItem html-for="lead-trip" :label="$t('shell.leads.formTripType')">
            <Input id="lead-trip" v-model:value="createForm.tripType" />
          </FormItem>
          <FormItem html-for="lead-intent" :label="$t('shell.leads.formIntentLevel')">
            <Input id="lead-intent" v-model:value="createForm.intentLevel" />
          </FormItem>
          <FormItem html-for="lead-date" :label="$t('shell.leads.formExpectedDate')">
            <Input id="lead-date" v-model:value="createForm.expectedDate" type="date" />
          </FormItem>
          <FormItem html-for="lead-bmin" :label="$t('shell.leads.formBudgetMin')">
            <InputNumber id="lead-bmin" v-model:value="createForm.budgetMin" class="w-full" :min="0" />
          </FormItem>
          <FormItem html-for="lead-bmax" :label="$t('shell.leads.formBudgetMax')">
            <InputNumber id="lead-bmax" v-model:value="createForm.budgetMax" class="w-full" :min="0" />
          </FormItem>
        </div>
        <FormItem html-for="lead-remark" :label="$t('shell.leads.formRemark')">
          <Input id="lead-remark" v-model:value="createForm.remark" />
        </FormItem>
      </Form>
    </Modal>

    <Modal
      :cancel-text="$t('shell.common.cancel')"
      :confirm-loading="saving"
      :ok-text="$t('shell.common.save')"
      :open="followUpOpen"
      :title="$t('shell.leads.followUpTitle')"
      @cancel="followUpOpen = false"
      @ok="submitFollowUp"
    >
      <Form layout="vertical">
        <FormItem html-for="fu-stage" :label="$t('shell.leads.colStage')">
          <Select id="fu-stage" v-model:value="followUpForm.stage" :options="stageOptions" />
        </FormItem>
        <FormItem html-for="fu-detail" :label="$t('shell.leads.formFollowUpDetail')">
          <Input id="fu-detail" v-model:value="followUpForm.detail" />
        </FormItem>
        <FormItem html-for="fu-next" :label="$t('shell.leads.formNextFollowUp')">
          <Input id="fu-next" v-model:value="followUpForm.nextFollowUpAt" type="datetime-local" />
        </FormItem>
      </Form>
    </Modal>
  </Page>
</template>
