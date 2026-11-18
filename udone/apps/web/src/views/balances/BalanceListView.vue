<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  FUND_METHODS,
  PERMISSIONS,
  authorizationForRole,
  type AccountBalance,
  type FundMethod,
  type Permission,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const loading = ref(true);
const errorText = ref('');
const rows = ref<AccountBalance[]>([]);
const createOpen = ref(false);
const adjustOpen = ref(false);
const adjusting = ref<AccountBalance | null>(null);
const saving = ref(false);

const METHOD_LABELS: Record<FundMethod, string> = {
  cash: '现金',
  bank: '银行',
  alipay: '支付宝',
  wechat: '微信',
  other: '其它',
};

const createForm = reactive({
  name: '',
  method: 'bank' as FundMethod,
  openingBalance: 0,
  remark: '',
});
const adjustForm = reactive({ amount: 0, reason: '' });

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canManage = computed(() => permissions.value.includes(PERMISSIONS.SETTINGS_MANAGE));
const canAdjust = computed(() => permissions.value.includes(PERMISSIONS.FINANCE_APPROVE));

const columns = [
  { title: '账户', key: 'accountName', dataIndex: 'accountName' },
  { title: '方式', key: 'method', dataIndex: 'method', width: 90 },
  { title: '期初', key: 'openingBalance', dataIndex: 'openingBalance', align: 'right' },
  { title: '已收', key: 'confirmedIn', dataIndex: 'confirmedIn', align: 'right' },
  { title: '已付', key: 'confirmedOut', dataIndex: 'confirmedOut', align: 'right' },
  { title: '调整', key: 'adjustments', dataIndex: 'adjustments', align: 'right' },
  { title: '余额', key: 'balance', dataIndex: 'balance', align: 'right' },
  { title: '操作', key: 'action', width: 100 },
];

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const result = await auth.api.call('listAccountBalances');
    rows.value = result.items;
  } catch (cause) {
    rows.value = [];
    errorText.value = cause instanceof ApiClientError ? cause.message : '加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

async function createAccount() {
  saving.value = true;
  try {
    await auth.api.call('createFundAccount', { body: createForm });
    message.success('资金账户已创建');
    createOpen.value = false;
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '创建失败，请重试';
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
    await auth.api.call('adjustAccountBalance', {
      body: {
        accountId: adjusting.value.accountId,
        amount: adjustForm.amount,
        reason: adjustForm.reason,
      },
    });
    message.success('余额已调整');
    adjustOpen.value = false;
    await load();
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '调整失败，请重试';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <a-card title="账户余额" class="balance-card">
    <p class="note">
      余额 = 期初 + 已确认收款 − 已确认付款 +
      调整。审批中和已驳回的申请不计入；调整只追加流水，不能涂改历史。
    </p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>

    <div class="toolbar">
      <span class="result-count">共 {{ rows.length }} 个账户</span>
      <a-button v-if="canManage" type="primary" @click="createOpen = true">新建账户</a-button>
    </div>

    <a-table
      :data-source="rows"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      row-key="accountId"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'method'">
          {{ METHOD_LABELS[record.method as FundMethod] ?? record.method }}
        </template>
        <template
          v-else-if="
            column.key.startsWith('opening') ||
            column.key.startsWith('confirmed') ||
            column.key === 'adjustments' ||
            column.key === 'balance'
          "
        >
          <span :class="column.key === 'balance' ? 'balance-value' : ''">
            {{ formatMoney(record[column.key as keyof AccountBalance] as number) }}
          </span>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-button v-if="canAdjust" type="link" @click="openAdjust(record)">调整</a-button>
        </template>
      </template>
      <template #emptyText>
        <div class="empty">还没有资金账户，点「新建账户」开始</div>
      </template>
    </a-table>

    <a-modal
      v-model:open="createOpen"
      title="新建资金账户"
      ok-text="创建"
      :confirm-loading="saving"
      @ok="createAccount"
    >
      <a-form layout="vertical">
        <a-form-item label="账户名称">
          <a-input v-model:value="createForm.name" maxlength="60" />
        </a-form-item>
        <a-form-item label="付款方式">
          <a-select v-model:value="createForm.method">
            <a-select-option v-for="method in FUND_METHODS" :key="method" :value="method">
              {{ METHOD_LABELS[method] }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="期初余额">
          <a-input-number
            v-model:value="createForm.openingBalance"
            :min="0"
            :precision="2"
            class="full"
          />
        </a-form-item>
        <a-form-item label="备注">
          <a-input v-model:value="createForm.remark" maxlength="200" />
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="adjustOpen"
      title="调整余额"
      ok-text="确认调整"
      :confirm-loading="saving"
      @ok="submitAdjust"
    >
      <p v-if="adjusting" class="adjust-target">账户：{{ adjusting.accountName }}</p>
      <a-form layout="vertical">
        <a-form-item label="调整金额（负数表示减少）">
          <a-input-number v-model:value="adjustForm.amount" :precision="2" class="full" />
        </a-form-item>
        <a-form-item label="原因">
          <a-input v-model:value="adjustForm.reason" maxlength="200" placeholder="如：银行手续费" />
        </a-form-item>
      </a-form>
    </a-modal>
  </a-card>
</template>

<style scoped>
.balance-card {
  max-width: 1080px;
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
  align-items: center;
  margin-bottom: var(--space-16);
}
.result-count {
  margin-right: auto;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.balance-value {
  font-weight: 600;
}
.full {
  width: 100%;
}
.adjust-target {
  margin-bottom: var(--space-12);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
.empty {
  padding: var(--space-32) 0;
  color: var(--color-secondary-text);
  text-align: center;
}
</style>
