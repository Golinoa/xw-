<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  PERMISSIONS,
  authorizationForRole,
  type CompanySettings,
  type CompanySettingsData,
  type Permission,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const saving = ref(false);
const loading = ref(true);
const errorText = ref('');
const version = ref(0);
const confirmOpen = ref(false);
const pendingSensitiveKey = ref('');

const form = reactive<CompanySettingsData>({
  companyName: '',
  contactPhone: '',
  address: '',
  theme: 'light',
  fontSize: 'medium',
  businessDictionary: [],
  approvalRules: { selfApproval: false, minApprovalSteps: 2 },
  orderRules: { defaultOrderType: 'active', requireDeposit: false },
});

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canManage = computed(() => permissions.value.includes(PERMISSIONS.SETTINGS_MANAGE));

function fill(settings: CompanySettings) {
  version.value = settings.version;
  const data = settings.data;
  form.companyName = data.companyName ?? '';
  form.contactPhone = data.contactPhone ?? '';
  form.address = data.address ?? '';
  form.theme = data.theme ?? 'light';
  form.fontSize = data.fontSize ?? 'medium';
  form.businessDictionary = data.businessDictionary ? [...data.businessDictionary] : [];
  form.approvalRules = data.approvalRules
    ? { ...data.approvalRules }
    : { selfApproval: false, minApprovalSteps: 2 };
  form.orderRules = data.orderRules
    ? { ...data.orderRules }
    : { defaultOrderType: 'active', requireDeposit: false };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    fill(await auth.api.call('getCompanySettings'));
  } catch (cause) {
    errorText.value = cause instanceof ApiClientError ? cause.message : '配置加载失败，请重试';
  } finally {
    loading.value = false;
  }
}

function payload(): CompanySettingsData {
  return {
    companyName: form.companyName?.trim() || undefined,
    contactPhone: form.contactPhone?.trim() || undefined,
    address: form.address?.trim() || undefined,
    theme: form.theme,
    fontSize: form.fontSize,
    businessDictionary: form.businessDictionary?.length ? form.businessDictionary : undefined,
    approvalRules: form.approvalRules,
    orderRules: form.orderRules,
  };
}

async function save(confirmed = false) {
  saving.value = true;
  errorText.value = '';
  try {
    fill(
      await auth.api.call('updateCompanySettings', {
        body: { data: payload(), expectedVersion: version.value, confirmed },
      }),
    );
    message.success('公司配置已保存');
  } catch (cause) {
    if (
      cause instanceof ApiClientError &&
      cause.status === 400 &&
      cause.message.includes('confirmation')
    ) {
      pendingSensitiveKey.value = 'approvalRules / orderRules';
      confirmOpen.value = true;
      return;
    }
    errorText.value = cause instanceof ApiClientError ? cause.message : '保存失败，请稍后重试';
  } finally {
    saving.value = false;
  }
}

function addDictionaryItem() {
  form.businessDictionary = [...(form.businessDictionary ?? []), { key: '', label: '' }];
}

function removeDictionaryItem(index: number) {
  form.businessDictionary = (form.businessDictionary ?? []).filter((_, i) => i !== index);
}

onMounted(load);
</script>

<template>
  <a-card title="公司配置" class="settings-card">
    <p class="version-note">当前版本 {{ version }} · 保存后版本自动递增</p>
    <div v-if="errorText" class="error-note">{{ errorText }}</div>
    <a-form v-if="!loading" layout="vertical" class="settings-form">
      <a-form-item label="公司名称">
        <a-input v-model:value="form.companyName" :disabled="!canManage" maxlength="80" />
      </a-form-item>
      <a-form-item label="联系电话">
        <a-input v-model:value="form.contactPhone" :disabled="!canManage" maxlength="20" />
      </a-form-item>
      <a-form-item label="公司地址">
        <a-input v-model:value="form.address" :disabled="!canManage" maxlength="200" />
      </a-form-item>
      <a-form-item label="主题">
        <a-select v-model:value="form.theme" :disabled="!canManage">
          <a-select-option value="light">浅色</a-select-option>
          <a-select-option value="dark">深色</a-select-option>
          <a-select-option value="system">跟随系统</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="字号">
        <a-select v-model:value="form.fontSize" :disabled="!canManage">
          <a-select-option value="small">小</a-select-option>
          <a-select-option value="medium">中</a-select-option>
          <a-select-option value="large">大</a-select-option>
        </a-select>
      </a-form-item>

      <h3>业务字典</h3>
      <div v-for="(item, index) in form.businessDictionary" :key="index" class="dictionary-row">
        <a-input v-model:value="item.key" placeholder="键" :disabled="!canManage" />
        <a-input v-model:value="item.label" placeholder="显示名" :disabled="!canManage" />
        <a-button v-if="canManage" danger @click="removeDictionaryItem(index)">删除</a-button>
      </div>
      <a-button v-if="canManage" @click="addDictionaryItem">新增字典项</a-button>

      <h3>审批规则</h3>
      <a-form-item>
        <a-checkbox v-model:checked="form.approvalRules!.selfApproval" :disabled="!canManage">
          允许审批人审批自己提交的申请
        </a-checkbox>
      </a-form-item>
      <a-form-item label="审批级数">
        <a-select v-model:value="form.approvalRules!.minApprovalSteps" :disabled="!canManage">
          <a-select-option :value="1">一级</a-select-option>
          <a-select-option :value="2">二级</a-select-option>
          <a-select-option :value="3">三级</a-select-option>
        </a-select>
      </a-form-item>

      <h3>订单规则</h3>
      <a-form-item label="默认订单类型">
        <a-select v-model:value="form.orderRules!.defaultOrderType" :disabled="!canManage">
          <a-select-option value="active">正式</a-select-option>
          <a-select-option value="booking">预订</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item>
        <a-checkbox v-model:checked="form.orderRules!.requireDeposit" :disabled="!canManage">
          下单必须收定金
        </a-checkbox>
      </a-form-item>

      <a-button v-if="canManage" type="primary" :loading="saving" @click="save()"
        >保存配置</a-button
      >
    </a-form>

    <a-modal
      v-model:open="confirmOpen"
      title="二次确认"
      ok-text="确认保存"
      cancel-text="返回修改"
      @ok="
        confirmOpen = false;
        save(true);
      "
    >
      <p>本次修改包含 {{ pendingSensitiveKey }}，会影响审批或订单规则。确认保存吗？</p>
    </a-modal>
  </a-card>
</template>

<style scoped>
.settings-card {
  max-width: 720px;
}

.settings-form {
  max-width: 520px;
}

.version-note {
  margin-bottom: var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}

.error-note {
  margin-bottom: var(--space-16);
  color: var(--color-error-text);
  font-size: var(--font-size-sm);
}

.dictionary-row {
  display: flex;
  gap: var(--space-8);
  margin-bottom: var(--space-8);
}
</style>
