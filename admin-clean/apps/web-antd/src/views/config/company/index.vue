<script lang="ts" setup>
import type {
  ApprovalFlow,
  ApprovalStepPermission,
  CompanySettings,
  CompanySettingsData,
  Permission,
} from '@erp/contracts';

import { computed, onMounted, reactive, ref } from 'vue';

import { Page } from '@vben/common-ui';

import {
  APPROVAL_STEP_PERMISSIONS,
  authorizationForRole,
  PERMISSIONS,
} from '@erp/contracts';
import {
  Button,
  Card,
  Checkbox,
  Form,
  FormItem,
  Input,
  message,
  Modal,
  Select,
  SelectOption,
  Spin,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'ConfigCompany' });

/** 表单自己的形状：契约里每个字段都是可选的，界面上一律按「已填」处理，避免到处判空。 */
interface SettingsForm {
  address: string;
  approvalRules: { minApprovalSteps: number; selfApproval: boolean };
  businessDictionary: { key: string; label: string }[];
  companyName: string;
  contactPhone: string;
  fontSize: 'large' | 'medium' | 'small';
  orderRules: { defaultOrderType: 'active' | 'booking'; requireDeposit: boolean };
  theme: 'dark' | 'light' | 'system';
}

const authStore = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions : [];
});
const canManage = computed(() => permissions.value.includes(PERMISSIONS.SETTINGS_MANAGE));

const loading = ref(true);
const errorText = ref('');
const saving = ref(false);
const version = ref(0);
const confirmOpen = ref(false);
const pendingSensitiveKey = ref('');

const form = reactive<SettingsForm>({
  address: '',
  approvalRules: { minApprovalSteps: 2, selfApproval: false },
  businessDictionary: [],
  companyName: '',
  contactPhone: '',
  fontSize: 'medium',
  orderRules: { defaultOrderType: 'active', requireDeposit: false },
  theme: 'light',
});

function fill(settings: CompanySettings) {
  version.value = settings.version;
  const data = settings.data;
  form.companyName = data.companyName ?? '';
  form.contactPhone = data.contactPhone ?? '';
  form.address = data.address ?? '';
  form.theme = data.theme ?? 'light';
  form.fontSize = data.fontSize ?? 'medium';
  form.businessDictionary = data.businessDictionary ? [...data.businessDictionary] : [];
  form.approvalRules = {
    minApprovalSteps: data.approvalRules?.minApprovalSteps ?? 2,
    selfApproval: data.approvalRules?.selfApproval ?? false,
  };
  form.orderRules = {
    defaultOrderType: data.orderRules?.defaultOrderType ?? 'active',
    requireDeposit: data.orderRules?.requireDeposit ?? false,
  };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    fill(await authStore.api.call('getCompanySettings'));
  } catch (error) {
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.companySettings.loadFailed');
  } finally {
    loading.value = false;
  }
}

function payload(): CompanySettingsData {
  // 空字典项在契约里非法（key/label 都必须非空），提交前就地剔掉，不让用户先删空行才能保存。
  const dictionary = form.businessDictionary
    .map((item) => ({ key: item.key.trim(), label: item.label.trim() }))
    .filter((item) => item.key && item.label);
  return {
    address: form.address.trim() || undefined,
    approvalRules: form.approvalRules,
    businessDictionary: dictionary.length > 0 ? dictionary : undefined,
    companyName: form.companyName.trim() || undefined,
    contactPhone: form.contactPhone.trim() || undefined,
    fontSize: form.fontSize,
    orderRules: form.orderRules,
    theme: form.theme,
  };
}

async function save(confirmed = false) {
  saving.value = true;
  errorText.value = '';
  try {
    fill(
      await authStore.api.call('updateCompanySettings', {
        body: { confirmed, data: payload(), expectedVersion: version.value },
      }),
    );
    message.success($t('shell.companySettings.saved'));
  } catch (error) {
    /**
     * 改审批/订单规则要求二次确认，服务端回 400 + `details.field === 'confirmed'`。
     * 只能靠 `details` 判定：`message` 已被错误码映射成通用中文文案，
     * 按文案匹配永远不命中（旧前端就是这么写的，于是这个改法从来存不进去）。
     */
    const details = (error instanceof ApiClientError ? error.details : null) as
      | null
      | undefined
      | { field?: string };
    if (error instanceof ApiClientError && error.status === 400 && details?.field === 'confirmed') {
      pendingSensitiveKey.value = $t('shell.companySettings.sensitiveKeys');
      confirmOpen.value = true;
      return;
    }
    errorText.value =
      error instanceof ApiClientError ? error.message : $t('shell.companySettings.saveFailed');
  } finally {
    saving.value = false;
  }
}

function addDictionaryItem() {
  form.businessDictionary = [...form.businessDictionary, { key: '', label: '' }];
}

function removeDictionaryItem(index: number) {
  form.businessDictionary = form.businessDictionary.filter((_, position) => position !== index);
}

/**
 * 审批流（R-APPROVAL-01）单独一块：
 * 它没有版本号语义，走 `set_approval_flow` 覆盖写，跟配置的乐观锁不是一回事。
 */
const flow = reactive<ApprovalFlow>({
  allowSelfApproval: false,
  allowWithdraw: true,
  steps: [{ permission: 'finance.approve', step: 1 }],
});
const flowLoading = ref(true);
const flowSaving = ref(false);
const flowError = ref('');

const APPROVAL_PERMISSION_LABELS: Record<ApprovalStepPermission, string> = {
  'finance.approve': $t('shell.companySettings.permissionFinanceApprove'),
  'finance.write': $t('shell.companySettings.permissionFinanceWrite'),
  'settings.manage': $t('shell.companySettings.permissionSettingsManage'),
};

async function loadFlow() {
  flowLoading.value = true;
  flowError.value = '';
  try {
    const current = await authStore.api.call('getApprovalFlow');
    flow.steps = current.steps.map((step) => ({ ...step }));
    flow.allowSelfApproval = current.allowSelfApproval;
    flow.allowWithdraw = current.allowWithdraw;
  } catch (error) {
    flowError.value =
      error instanceof ApiClientError ? error.message : $t('shell.companySettings.flowLoadFailed');
  } finally {
    flowLoading.value = false;
  }
}

/** 级次必须从 1 连续编号，所以增删后统一重排，不让用户自己填数字。 */
function renumber() {
  flow.steps = flow.steps.map((step, index) => ({ ...step, step: index + 1 }));
}

function addFlowStep() {
  if (flow.steps.length >= 3) return;
  flow.steps = [
    ...flow.steps,
    { permission: 'settings.manage', step: flow.steps.length + 1 },
  ];
  renumber();
}

function removeFlowStep(index: number) {
  if (flow.steps.length <= 1) return;
  flow.steps = flow.steps.filter((_, position) => position !== index);
  renumber();
}

async function saveFlow() {
  flowSaving.value = true;
  flowError.value = '';
  try {
    const saved = await authStore.api.call('updateApprovalFlow', {
      body: {
        allowSelfApproval: flow.allowSelfApproval,
        allowWithdraw: flow.allowWithdraw,
        steps: flow.steps.map((step) => ({ ...step })),
      },
    });
    flow.steps = saved.steps.map((step) => ({ ...step }));
    flow.allowSelfApproval = saved.allowSelfApproval;
    flow.allowWithdraw = saved.allowWithdraw;
    message.success($t('shell.companySettings.flowSaved'));
  } catch (error) {
    flowError.value =
      error instanceof ApiClientError ? error.message : $t('shell.companySettings.flowSaveFailed');
  } finally {
    flowSaving.value = false;
  }
}

function confirmSave() {
  confirmOpen.value = false;
  void save(true);
}

onMounted(async () => {
  await Promise.all([load(), loadFlow()]);
});
</script>

<template>
  <Page :description="$t('shell.companySettings.description')" :title="$t('shell.menu.companySettings')">
    <div class="flex flex-col gap-4">
      <Card :title="$t('shell.companySettings.sectionTitle')">
        <p class="mb-4 text-sm text-muted-foreground">
          {{ $t('shell.companySettings.versionNote', { version }) }}
        </p>
        <p v-if="errorText" class="mb-4 text-sm text-red-600" role="alert">{{ errorText }}</p>

        <Spin :spinning="loading">
          <Form layout="vertical" class="max-w-[520px]">
            <FormItem :label="$t('shell.companySettings.companyName')" html-for="company-name">
              <Input
                id="company-name"
                v-model:value="form.companyName"
                :disabled="!canManage"
                :maxlength="80"
              />
            </FormItem>
            <FormItem :label="$t('shell.companySettings.contactPhone')" html-for="contact-phone">
              <Input
                id="contact-phone"
                v-model:value="form.contactPhone"
                :disabled="!canManage"
                :maxlength="20"
              />
            </FormItem>
            <FormItem :label="$t('shell.companySettings.address')" html-for="company-address">
              <Input
                id="company-address"
                v-model:value="form.address"
                :disabled="!canManage"
                :maxlength="200"
              />
            </FormItem>
            <FormItem :label="$t('shell.companySettings.theme')">
              <Select v-model:value="form.theme" :disabled="!canManage">
                <SelectOption value="light">{{ $t('shell.companySettings.themeLight') }}</SelectOption>
                <SelectOption value="dark">{{ $t('shell.companySettings.themeDark') }}</SelectOption>
                <SelectOption value="system">{{ $t('shell.companySettings.themeSystem') }}</SelectOption>
              </Select>
            </FormItem>
            <FormItem :label="$t('shell.companySettings.fontSize')">
              <Select v-model:value="form.fontSize" :disabled="!canManage">
                <SelectOption value="small">{{ $t('shell.companySettings.fontSmall') }}</SelectOption>
                <SelectOption value="medium">{{ $t('shell.companySettings.fontMedium') }}</SelectOption>
                <SelectOption value="large">{{ $t('shell.companySettings.fontLarge') }}</SelectOption>
              </Select>
            </FormItem>

            <h3 class="mb-2 font-medium">{{ $t('shell.companySettings.dictionaryTitle') }}</h3>
            <div
              v-for="(item, index) in form.businessDictionary"
              :key="index"
              class="mb-2 flex gap-2"
            >
              <Input v-model:value="item.key" :disabled="!canManage" :placeholder="$t('shell.companySettings.dictKey')" />
              <Input v-model:value="item.label" :disabled="!canManage" :placeholder="$t('shell.companySettings.dictLabel')" />
              <Button v-if="canManage" danger @click="removeDictionaryItem(index)">
                {{ $t('shell.companySettings.remove') }}
              </Button>
            </div>
            <Button v-if="canManage" class="mb-4" @click="addDictionaryItem">
              {{ $t('shell.companySettings.addDictionary') }}
            </Button>

            <h3 class="mb-2 font-medium">{{ $t('shell.companySettings.approvalRulesTitle') }}</h3>
            <FormItem>
              <Checkbox v-model:checked="form.approvalRules.selfApproval" :disabled="!canManage">
                {{ $t('shell.companySettings.selfApproval') }}
              </Checkbox>
            </FormItem>
            <FormItem :label="$t('shell.companySettings.minApprovalSteps')">
              <Select v-model:value="form.approvalRules.minApprovalSteps" :disabled="!canManage">
                <SelectOption :value="1">{{ $t('shell.companySettings.stepsOne') }}</SelectOption>
                <SelectOption :value="2">{{ $t('shell.companySettings.stepsTwo') }}</SelectOption>
                <SelectOption :value="3">{{ $t('shell.companySettings.stepsThree') }}</SelectOption>
              </Select>
            </FormItem>

            <h3 class="mb-2 font-medium">{{ $t('shell.companySettings.orderRulesTitle') }}</h3>
            <FormItem :label="$t('shell.companySettings.defaultOrderType')">
              <Select v-model:value="form.orderRules.defaultOrderType" :disabled="!canManage">
                <SelectOption value="active">{{ $t('shell.companySettings.orderTypeActive') }}</SelectOption>
                <SelectOption value="booking">{{ $t('shell.companySettings.orderTypeBooking') }}</SelectOption>
              </Select>
            </FormItem>
            <FormItem>
              <Checkbox v-model:checked="form.orderRules.requireDeposit" :disabled="!canManage">
                {{ $t('shell.companySettings.requireDeposit') }}
              </Checkbox>
            </FormItem>

            <Button v-if="canManage" type="primary" :loading="saving" @click="save()">
              {{ $t('shell.companySettings.save') }}
            </Button>
          </Form>
        </Spin>
      </Card>

      <Card :title="$t('shell.companySettings.flowTitle')">
        <p class="mb-4 text-sm text-muted-foreground">
          {{ $t('shell.companySettings.flowHint') }}
        </p>
        <p v-if="flowError" class="mb-4 text-sm text-red-600" role="alert">{{ flowError }}</p>

        <Spin :spinning="flowLoading">
          <div v-for="(step, index) in flow.steps" :key="index" class="mb-2 flex items-center gap-2">
            <span class="w-14 text-sm text-muted-foreground">
              {{ $t('shell.companySettings.stepIndex', { index: index + 1 }) }}
            </span>
            <Select v-model:value="step.permission" class="w-[220px]" :disabled="!canManage">
              <SelectOption
                v-for="permission in APPROVAL_STEP_PERMISSIONS"
                :key="permission"
                :value="permission"
              >
                {{ APPROVAL_PERMISSION_LABELS[permission] }}
              </SelectOption>
            </Select>
            <Button
              v-if="canManage && flow.steps.length > 1"
              danger
              @click="removeFlowStep(index)"
            >
              {{ $t('shell.companySettings.remove') }}
            </Button>
          </div>

          <Button v-if="canManage && flow.steps.length < 3" class="mb-4" @click="addFlowStep">
            {{ $t('shell.companySettings.addStep') }}
          </Button>

          <Form class="mb-4 mt-4 max-w-[520px]" layout="vertical">
            <FormItem>
              <Checkbox v-model:checked="flow.allowSelfApproval" :disabled="!canManage">
                {{ $t('shell.companySettings.flowSelfApproval') }}
              </Checkbox>
            </FormItem>
            <FormItem>
              <Checkbox v-model:checked="flow.allowWithdraw" :disabled="!canManage">
                {{ $t('shell.companySettings.flowWithdraw') }}
              </Checkbox>
            </FormItem>
          </Form>

          <Button v-if="canManage" type="primary" :loading="flowSaving" @click="saveFlow">
            {{ $t('shell.companySettings.saveFlow') }}
          </Button>
        </Spin>
      </Card>

      <Modal
        v-model:open="confirmOpen"
        :cancel-text="$t('shell.companySettings.confirmBack')"
        :ok-text="$t('shell.companySettings.confirmOk')"
        :title="$t('shell.companySettings.confirmTitle')"
        @ok="confirmSave"
      >
        <p>{{ $t('shell.companySettings.confirmBody', { keys: pendingSensitiveKey }) }}</p>
      </Modal>
    </div>
  </Page>
</template>
