<script lang="ts" setup>
import type {
  CreateCustomerRequest,
  CustomerDetail,
  CustomerDuplicate,
  CustomerIdType,
  CustomerSource,
  CustomerTag,
  UpdateCustomerRequest,
} from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import {
  Alert,
  DatePicker,
  Form,
  FormItem,
  Input,
  Modal,
  Select,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError, ContractViolationError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { CUSTOMER_ID_TYPE_LABEL_KEYS, CUSTOMER_ID_TYPE_ORDER } from '../display';

/**
 * `customer` 有值就是编辑，没值就是新建。
 *
 * 编辑必须回传详情里的 `version`：两人同时编辑时后写会被服务端拒掉，
 * 而不是悄悄覆盖先写的人。
 */
const props = defineProps<{
  customer?: CustomerDetail | null;
  open: boolean;
  tags: readonly CustomerTag[];
}>();

const emit = defineEmits<{
  saved: [payload: { customer: CustomerDetail; duplicates: CustomerDuplicate[] }];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const saving = ref(false);
const formError = ref('');

const form = reactive({
  birthday: '',
  email: '',
  idNumber: '',
  idType: undefined as CustomerIdType | undefined,
  name: '',
  phone: '',
  remark: '',
  sourceId: undefined as string | undefined,
  tagIds: [] as string[],
});

const isEdit = computed(() => Boolean(props.customer));

const sources = ref<CustomerSource[]>([]);

/**
 * 两级来源平铺成「父 / 子」：选项组在搜索时会丢分组语义，且搜「小红书」也要命中。
 *
 * 停用项也要进选项表并标「已停用」：客户挂着的来源被停用后，如果这里没有它，
 * 编辑表单会把原始 UUID 直接显示在来源框里——用户以为数据坏了。
 * 停用项只作展示，`disabled` 之后不能再被选中。
 */
const sourceOptions = computed(() => {
  const roots = sources.value.filter((source) => !source.parentId);
  const disabledSuffix = $t('shell.customers.sourceDisabledSuffix');
  return roots.flatMap((root) => {
    const children = sources.value.filter((source) => source.parentId === root.id);
    return [
      {
        disabled: !root.isActive,
        label: root.isActive ? root.name : `${root.name}${disabledSuffix}`,
        value: root.id,
      },
      ...children.map((child) => ({
        disabled: !child.isActive,
        label: child.isActive
          ? `${root.name} / ${child.name}`
          : `${root.name} / ${child.name}${disabledSuffix}`,
        value: child.id,
      })),
    ];
  });
});

const idTypeOptions = computed(() =>
  CUSTOMER_ID_TYPE_ORDER.map((value) => ({ label: $t(CUSTOMER_ID_TYPE_LABEL_KEYS[value]), value })),
);

const tagOptions = computed(() => props.tags.map((tag) => ({ label: tag.name, value: tag.id })));

async function loadSources() {
  try {
    // 连停用项一起取：停用项要能被识别成「已停用」，而不是掉出选项表变成 UUID。
    const result = await authStore.api.call('listCustomerSources', {
      body: { includeInactive: '1' },
    });
    sources.value = result.sources;
  } catch {
    // 来源选不了不该挡住建档：保持空列表，用户可以不填来源。
    sources.value = [];
  }
}

/**
 * 服务端按 `customer.sensitive.read` 决定是否返回原值。只有「有掩码、没原值」才说明
 * 当前账号读不到：此时整个证件字段不可编辑——只回传类型而省略号码会破坏成对约束。
 */
const identityReadable = computed(
  () =>
    !props.customer ||
    props.customer.idNumber !== undefined ||
    props.customer.idNumberMasked === undefined,
);

const phoneReadable = computed(
  () =>
    !props.customer ||
    props.customer.phone !== undefined ||
    props.customer.phoneMasked === undefined,
);

const emailReadable = computed(
  () =>
    !props.customer ||
    props.customer.email !== undefined ||
    props.customer.emailMasked === undefined,
);

const identityPairIncomplete = computed(
  () => identityReadable.value && Boolean(form.idType) !== Boolean(form.idNumber.trim()),
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void loadSources();
    const current = props.customer;
    formError.value = '';
    form.name = current?.name ?? '';
    form.phone = current?.phone ?? '';
    form.email = current?.email ?? '';
    form.idType = current?.idType;
    form.idNumber = current?.idNumber ?? '';
    form.birthday = current?.birthday ?? '';
    form.sourceId = current?.sourceId;
    form.tagIds = current ? current.tags.map((tag) => tag.id) : [];
    form.remark = current?.remark ?? '';
  },
  { immediate: true },
);

interface CustomerFormFields {
  birthday?: null | string;
  email?: null | string;
  idNumber?: null | string;
  idType?: CustomerIdType | null;
  name: string;
  phone?: null | string;
  remark?: null | string;
  sourceId?: null | string;
  tagIds: string[];
}

/**
 * 契约用「缺失 = 不修改、null = 清空」区分两种意图，提交时必须如实表达：
 * - 新建，或当前账号看不到原值（例如无 sensitive 权限）：空值一律省略，
 *   否则会把用户根本没看到的原号码清掉；
 * - 编辑且能读到原值：空值传 null，用户才能真正删掉填错的字段。
 * `tagIds` 例外：传空数组即「清空全部标签」。
 */
function buildFields(options: {
  clearEmail: boolean;
  clearOptional: boolean;
  clearPhone: boolean;
  includeIdentity: boolean;
}): CustomerFormFields {
  const phone = form.phone.trim();
  const email = form.email.trim();
  const idNumber = form.idNumber.trim();
  const remark = form.remark.trim();
  const fields: CustomerFormFields = {
    name: form.name.trim(),
    tagIds: [...form.tagIds],
    ...(phone ? { phone } : (options.clearPhone ? { phone: null } : {})),
    ...(email ? { email } : (options.clearEmail ? { email: null } : {})),
    ...(form.birthday
      ? { birthday: form.birthday }
      : (options.clearOptional
        ? { birthday: null }
        : {})),
    ...(form.sourceId
      ? { sourceId: form.sourceId }
      : (options.clearOptional
        ? { sourceId: null }
        : {})),
    ...(remark ? { remark } : (options.clearOptional ? { remark: null } : {})),
  };
  if (!options.includeIdentity) return fields;

  const identity: Partial<CustomerFormFields> = {};
  if (form.idType) identity.idType = form.idType;
  else if (options.clearOptional) identity.idType = null;
  if (idNumber) identity.idNumber = idNumber;
  else if (options.clearOptional) identity.idNumber = null;
  return { ...fields, ...identity };
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.status === 409) {
      // 编辑的 409 是乐观锁冲突；新建的 409 更可能是手机号重复，两者动作不同。
      return isEdit.value
        ? $t('shell.customers.conflictEdit')
        : $t('shell.customers.conflictCreate');
    }
    return cause.message;
  }
  if (cause instanceof ContractViolationError) return $t('shell.customers.contractMismatch');
  return $t('shell.customers.saveFailed');
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  if (!form.name.trim()) {
    formError.value = $t('shell.customers.nameRequired');
    return;
  }
  if (identityPairIncomplete.value) {
    formError.value = $t('shell.customers.idPairRequired');
    return;
  }

  saving.value = true;
  try {
    const fields = buildFields({
      clearEmail: Boolean(props.customer) && emailReadable.value,
      clearOptional: Boolean(props.customer),
      clearPhone: Boolean(props.customer) && phoneReadable.value,
      includeIdentity: identityReadable.value,
    });
    if (props.customer) {
      const body: UpdateCustomerRequest = { ...fields, version: props.customer.version };
      const result = await authStore.api.call('updateCustomer', {
        body,
        params: { customerId: props.customer.id },
      });
      emit('saved', { customer: result.customer, duplicates: [] });
    } else {
      const body: CreateCustomerRequest = fields;
      const result = await authStore.api.call('createCustomer', { body });
      emit('saved', { customer: result.customer, duplicates: result.duplicates });
    }
    emit('update:open', false);
  } catch (error) {
    formError.value = describeError(error);
  } finally {
    saving.value = false;
  }
}

function close() {
  if (saving.value) return;
  emit('update:open', false);
}
</script>

<template>
  <Modal
    :cancel-text="$t('shell.customers.cancel')"
    :closable="!saving"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :ok-text="$t('shell.customers.save')"
    :open="open"
    :title="isEdit ? $t('shell.customers.editTitle') : $t('shell.customers.createTitle')"
    :width="720"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="formError" class="mb-4" :message="formError" role="alert" show-icon type="error" />
    <Form layout="vertical" :model="form">
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem html-for="customer-name" :label="$t('shell.customers.formName')" required>
          <Input
            id="customer-name"
            v-model:value="form.name"
            :maxlength="100"
            :placeholder="$t('shell.customers.formNamePlaceholder')"
          />
        </FormItem>
        <FormItem html-for="customer-phone" :label="$t('shell.customers.formPhone')">
          <Input
            id="customer-phone"
            v-model:value="form.phone"
            :maxlength="32"
            :placeholder="
              phoneReadable
                ? $t('shell.customers.formPhonePlaceholder')
                : $t('shell.customers.formPhoneMaskedHint')
            "
          />
        </FormItem>
        <FormItem html-for="customer-email" :label="$t('shell.customers.formEmail')">
          <Input
            id="customer-email"
            v-model:value="form.email"
            :maxlength="120"
            :placeholder="$t('shell.customers.formEmailPlaceholder')"
          />
        </FormItem>
        <FormItem html-for="customer-birthday" :label="$t('shell.customers.formBirthday')">
          <DatePicker
            id="customer-birthday"
            v-model:value="form.birthday"
            class="w-full"
            :placeholder="$t('shell.customers.formBirthdayPlaceholder')"
            value-format="YYYY-MM-DD"
          />
        </FormItem>
        <FormItem html-for="customer-id-type" :label="$t('shell.customers.formIdType')">
          <Select
            id="customer-id-type"
            v-model:value="form.idType"
            allow-clear
            :disabled="!identityReadable"
            :options="idTypeOptions"
            :placeholder="$t('shell.customers.optionalHint')"
          />
        </FormItem>
        <FormItem html-for="customer-id-number" :label="$t('shell.customers.formIdNumber')">
          <Input
            id="customer-id-number"
            v-model:value="form.idNumber"
            :disabled="!identityReadable"
            :maxlength="64"
            :placeholder="
              identityReadable
                ? $t('shell.customers.formIdNumberPlaceholder')
                : $t('shell.customers.formIdNumberLocked')
            "
          />
        </FormItem>
        <FormItem class="col-span-2" html-for="customer-source" :label="$t('shell.customers.formSource')">
          <Select
            id="customer-source"
            v-model:value="form.sourceId"
            allow-clear
            :options="sourceOptions"
            option-filter-prop="label"
            :placeholder="$t('shell.customers.formSourcePlaceholder')"
            show-search
          />
        </FormItem>
        <FormItem class="col-span-2" html-for="customer-tags" :label="$t('shell.customers.formTags')">
          <Select
            id="customer-tags"
            v-model:value="form.tagIds"
            allow-clear
            mode="multiple"
            :max-tag-count="6"
            :options="tagOptions"
            :placeholder="$t('shell.customers.formTagsPlaceholder')"
          />
        </FormItem>
        <FormItem class="col-span-2" html-for="customer-remark" :label="$t('shell.customers.formRemark')">
          <Textarea
            id="customer-remark"
            v-model:value="form.remark"
            :maxlength="2000"
            :placeholder="$t('shell.customers.formRemarkPlaceholder')"
            :rows="3"
            show-count
          />
        </FormItem>
      </div>
      <p v-if="identityPairIncomplete" class="text-sm text-amber-600">
        {{ $t('shell.customers.idPairRequired') }}
      </p>
    </Form>
  </Modal>
</template>
