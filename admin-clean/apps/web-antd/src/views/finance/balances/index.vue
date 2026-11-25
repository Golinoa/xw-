<script lang="ts" setup>
import type { AccountBalance, FundMethod, Permission } from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import { authorizationForRole, FUND_METHODS, PERMISSIONS } from '@erp/contracts';
import {
  Button,
  Card,
  Form,
  FormItem,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  SelectOption,
  Table,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'FinanceBalances' });

const authStore = useAuthStore();

const loading = ref(true);
const errorText = ref('');
const rows = ref<AccountBalance[]>([]);
const createOpen = ref(false);
const adjustOpen = ref(false);
const adjusting = ref<AccountBalance | null>(null);
const saving = ref(false);

const METHOD_LABELS: Record<FundMethod, string> = {
  alipay: $t('shell.balances.methodAlipay'),
  bank: $t('shell.balances.methodBank'),
  cash: $t('shell.balances.methodCash'),
  other: $t('shell.balances.methodOther'),
  wechat: $t('shell.balances.methodWechat'),
};

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
// 建账户与调余额是两个不同权限，别合并：财务能调余额但不能改公司配置。
const canManage = computed(() => permissions.value.includes(PERMISSIONS.SETTINGS_MANAGE));
const canAdjust = computed(() => permissions.value.includes(PERMISSIONS.FINANCE_APPROVE));

const createForm = reactive({
  method: 'bank' as FundMethod,
  name: '',
  openingBalance: 0,
  remark: '',
});
const adjustForm = reactive({ amount: 0, reason: '' });

const columns = computed(() => [
  { dataIndex: 'accountName', key: 'accountName', title: $t('shell.balances.colAccount') },
  { dataIndex: 'method', key: 'method', title: $t('shell.balances.colMethod'), width: 90 },
  {
    align: 'right' as const,
    dataIndex: 'openingBalance',
    key: 'openingBalance',
    title: $t('shell.balances.colOpening'),
  },
  {
    align: 'right' as const,
    dataIndex: 'confirmedIn',
    key: 'confirmedIn',
    title: $t('shell.balances.colConfirmedIn'),
  },
  {
    align: 'right' as const,
    dataIndex: 'confirmedOut',
    key: 'confirmedOut',
    title: $t('shell.balances.colConfirmedOut'),
  },
  {
    align: 'right' as const,
    dataIndex: 'adjustments',
    key: 'adjustments',
    title: $t('shell.balances.colAdjustments'),
  },
  {
    align: 'right' as const,
    dataIndex: 'balance',
    key: 'balance',
    title: $t('shell.balances.colBalance'),
  },
  { key: 'action', title: $t('shell.balances.colAction'), width: 100 },
]);

const MONEY_KEYS = new Set(['adjustments', 'balance', 'confirmedIn', 'confirmedOut', 'openingBalance']);

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await authStore.api.call('listAccountBalances');
    rows.value = result.items;
  } catch (error) {
    rows.value = [];
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.balances.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function createAccount() {
  saving.value = true;
  try {
    await authStore.api.call('createFundAccount', {
      body: {
        method: createForm.method,
        name: createForm.name.trim(),
        openingBalance: createForm.openingBalance,
        ...(createForm.remark.trim() ? { remark: createForm.remark.trim() } : {}),
      },
    });
    message.success($t('shell.balances.created'));
    createOpen.value = false;
    createForm.name = '';
    createForm.remark = '';
    createForm.method = 'bank';
    createForm.openingBalance = 0;
    await load();
  } catch (error) {
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.balances.createFailed');
  } finally {
    saving.value = false;
  }
}

function openAdjust(row: AccountBalance) {
  adjusting.value = row;
  adjustForm.amount = 0;
  adjustForm.reason = '';
  adjustOpen.value = true;
}

async function submitAdjust() {
  if (!adjusting.value) return;
  saving.value = true;
  try {
    await authStore.api.call('adjustAccountBalance', {
      body: {
        accountId: adjusting.value.accountId,
        amount: adjustForm.amount,
        reason: adjustForm.reason.trim(),
      },
    });
    message.success($t('shell.balances.adjusted'));
    adjustOpen.value = false;
    await load();
  } catch (error) {
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.balances.adjustFailed');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Page :description="$t('shell.balances.description')" :title="$t('shell.menu.balances')">
    <Card>
      <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.balances.formulaNote') }}</p>
      <p v-if="errorText" class="mb-4 text-sm text-red-600" role="alert">{{ errorText }}</p>

      <div class="mb-4 flex items-center gap-3">
        <span class="mr-auto text-sm text-muted-foreground">
          {{ $t('shell.balances.total', { total: rows.length }) }}
        </span>
        <Button v-if="canManage" type="primary" @click="createOpen = true">
          {{ $t('shell.balances.create') }}
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="rows"
        :loading="loading"
        :pagination="false"
        row-key="accountId"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'method'">
            {{ METHOD_LABELS[(record as AccountBalance).method] ?? (record as AccountBalance).method }}
          </template>
          <template v-else-if="MONEY_KEYS.has(String(column.key))">
            <span :class="column.key === 'balance' ? 'font-semibold' : ''">
              {{
                formatMoney(
                  (record as unknown as Record<string, number>)[String(column.key)],
                )
              }}
            </span>
          </template>
          <template v-else-if="column.key === 'action'">
            <Button v-if="canAdjust" type="link" @click="openAdjust(record as AccountBalance)">
              {{ $t('shell.balances.adjust') }}
            </Button>
          </template>
        </template>
        <template #emptyText>
          <div class="py-8 text-center text-muted-foreground">{{ $t('shell.balances.empty') }}</div>
        </template>
      </Table>
    </Card>

    <Modal
      v-model:open="createOpen"
      :confirm-loading="saving"
      :ok-text="$t('shell.balances.createOk')"
      :title="$t('shell.balances.createTitle')"
      @ok="createAccount"
    >
      <Form layout="vertical">
        <FormItem :label="$t('shell.balances.accountName')">
          <Input v-model:value="createForm.name" :maxlength="60" />
        </FormItem>
        <FormItem :label="$t('shell.balances.method')">
          <Select v-model:value="createForm.method">
            <SelectOption v-for="method in FUND_METHODS" :key="method" :value="method">
              {{ METHOD_LABELS[method] }}
            </SelectOption>
          </Select>
        </FormItem>
        <FormItem :label="$t('shell.balances.openingBalance')">
          <InputNumber
            v-model:value="createForm.openingBalance"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </FormItem>
        <FormItem :label="$t('shell.balances.remark')">
          <Input v-model:value="createForm.remark" :maxlength="200" />
        </FormItem>
      </Form>
    </Modal>

    <Modal
      v-model:open="adjustOpen"
      :confirm-loading="saving"
      :ok-text="$t('shell.balances.adjustOk')"
      :title="$t('shell.balances.adjustTitle')"
      @ok="submitAdjust"
    >
      <p v-if="adjusting" class="mb-3 text-sm text-muted-foreground">
        {{ $t('shell.balances.adjustTarget', { name: adjusting.accountName }) }}
      </p>
      <Form layout="vertical">
        <FormItem :label="$t('shell.balances.adjustAmount')">
          <InputNumber v-model:value="adjustForm.amount" class="w-full" :precision="2" />
        </FormItem>
        <FormItem :label="$t('shell.balances.adjustReason')">
          <Input
            v-model:value="adjustForm.reason"
            :maxlength="200"
            :placeholder="$t('shell.balances.adjustReasonPlaceholder')"
          />
        </FormItem>
      </Form>
    </Modal>
  </Page>
</template>
