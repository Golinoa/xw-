<script lang="ts" setup>
import type {
  Tourist,
  TouristDocumentType,
  TouristGender,
  TouristPersonType,
} from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import { Alert, Form, FormItem, Input, InputNumber, Modal, Select, Textarea } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  TOURIST_DOCUMENT_TYPE_LABEL_KEYS,
  TOURIST_DOCUMENT_TYPES,
  TOURIST_GENDER_LABEL_KEYS,
  TOURIST_GENDERS,
  TOURIST_PERSON_TYPE_LABEL_KEYS,
  TOURIST_PERSON_TYPES,
} from './tourist-display';

const props = defineProps<{
  open: boolean;
  orderId: string;
  /** null 表示新增。 */
  tourist: null | Tourist;
}>();

const emit = defineEmits<{
  saved: [];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const saving = ref(false);
const error = ref('');

const form = reactive({
  age: undefined as number | undefined,
  documentNumber: '',
  documentType: undefined as TouristDocumentType | undefined,
  gender: 'unknown' as TouristGender,
  name: '',
  personType: 'adult' as TouristPersonType,
  phone: '',
  remark: '',
});

const isEdit = computed(() => props.tourist !== null);

watch(
  () => [props.open, props.tourist] as const,
  ([open, tourist]) => {
    if (!open) return;
    error.value = '';
    saving.value = false;
    form.name = tourist?.name ?? '';
    form.phone = tourist?.phone ?? '';
    form.documentType = tourist?.documentType;
    form.documentNumber = tourist?.documentNumber ?? '';
    form.personType = tourist?.personType ?? 'adult';
    form.age = tourist?.age;
    form.gender = tourist?.gender ?? 'unknown';
    form.remark = tourist?.remark ?? '';
  },
  { immediate: true },
);

/**
 * 无 customer.sensitive.read 时服务端只回掩码、原值为空。
 * 锁住输入框并从提交体剔除：对着 11****34 改字符会把掩码当原值写回，
 * 一次「只是改个备注」的保存就覆盖了真实号码。
 */
const documentLocked = computed(
  () =>
    isEdit.value && Boolean(props.tourist?.documentNumberMasked) && !props.tourist?.documentNumber,
);
const phoneLocked = computed(
  () => isEdit.value && Boolean(props.tourist?.phoneMasked) && !props.tourist?.phone,
);

function optionList<T extends string>(values: readonly T[], keys: Record<T, string>) {
  return values.map((value) => ({ label: $t(keys[value]), value }));
}

const personTypeOptions = computed(() => optionList(TOURIST_PERSON_TYPES, TOURIST_PERSON_TYPE_LABEL_KEYS));
const documentTypeOptions = computed(() => optionList(TOURIST_DOCUMENT_TYPES, TOURIST_DOCUMENT_TYPE_LABEL_KEYS));
const genderOptions = computed(() => optionList(TOURIST_GENDERS, TOURIST_GENDER_LABEL_KEYS));

function close() {
  if (saving.value) return;
  emit('update:open', false);
}

async function submit() {
  if (saving.value) return;
  const name = form.name.trim();
  if (!name) {
    error.value = $t('shell.tourists.nameRequired');
    return;
  }
  const documentNumber = form.documentNumber.trim();
  if (documentNumber && !form.documentType) {
    error.value = $t('shell.tourists.docTypeRequired');
    return;
  }
  if (form.age !== undefined && (form.age < 0 || form.age > 150)) {
    error.value = $t('shell.tourists.ageRange');
    return;
  }

  saving.value = true;
  error.value = '';
  try {
    await (props.tourist ? authStore.api.call('updateTourist', {
        body: {
          age: form.age ?? null,
          gender: form.gender,
          name,
          personType: form.personType,
          remark: form.remark.trim() || null,
          ...(phoneLocked.value ? {} : { phone: form.phone.trim() || null }),
          ...(documentLocked.value
            ? {}
            : { documentNumber: documentNumber || null, documentType: form.documentType ?? null }),
        },
        params: { orderId: props.orderId, touristId: props.tourist.id },
      }) : authStore.api.call('createTourist', {
        body: {
          age: form.age ?? null,
          documentNumber: documentNumber || null,
          documentType: form.documentType ?? null,
          gender: form.gender,
          name,
          personType: form.personType,
          phone: form.phone.trim() || null,
          remark: form.remark.trim() || null,
        },
        params: { orderId: props.orderId },
      }));
    emit('saved');
    emit('update:open', false);
  } catch (error_) {
    if (error_ instanceof ApiClientError && error_.code === 'TOURIST_DOCUMENT_CONFLICT') {
      error.value = $t('shell.tourists.docConflict');
    } else {
      error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.tourists.saveFailed');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :confirm-loading="saving"
    :mask-closable="!saving"
    :cancel-text="$t('shell.tourists.cancel')"
    :ok-text="isEdit ? $t('shell.tourists.save') : $t('shell.tourists.add')"
    :open="open"
    :title="isEdit ? $t('shell.tourists.editTitle') : $t('shell.tourists.createTitle')"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="error" class="mb-3" show-icon type="error" :message="error" role="alert" />
    <Form layout="vertical">
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem html-for="tourist-name" :label="$t('shell.tourists.formName')" required>
          <Input
            id="tourist-name"
            v-model:value="form.name"
            :maxlength="50"
            :placeholder="$t('shell.tourists.namePlaceholder')"
          />
        </FormItem>
        <FormItem html-for="tourist-person" :label="$t('shell.tourists.formPersonType')" required>
          <Select id="tourist-person" v-model:value="form.personType" :options="personTypeOptions" />
        </FormItem>
        <FormItem html-for="tourist-doc-type" :label="$t('shell.tourists.formDocType')">
          <Select
            id="tourist-doc-type"
            v-model:value="form.documentType"
            allow-clear
            :options="documentTypeOptions"
            :placeholder="$t('shell.tourists.optional')"
          />
        </FormItem>
        <FormItem html-for="tourist-doc-number" :label="$t('shell.tourists.formDocNumber')">
          <Input
            id="tourist-doc-number"
            v-model:value="form.documentNumber"
            :disabled="documentLocked"
            :maxlength="40"
            :placeholder="
              documentLocked
                ? $t('shell.tourists.docLocked')
                : $t('shell.tourists.docNumberPlaceholder')
            "
          />
        </FormItem>
        <FormItem html-for="tourist-phone" :label="$t('shell.tourists.formPhone')">
          <Input
            id="tourist-phone"
            v-model:value="form.phone"
            :disabled="phoneLocked"
            :maxlength="20"
            :placeholder="phoneLocked ? $t('shell.tourists.phoneLocked') : $t('shell.tourists.optional')"
          />
        </FormItem>
        <FormItem html-for="tourist-age" :label="$t('shell.tourists.formAge')">
          <InputNumber id="tourist-age" v-model:value="form.age" class="w-full" :max="150" :min="0" />
        </FormItem>
        <FormItem html-for="tourist-gender" :label="$t('shell.tourists.formGender')">
          <Select id="tourist-gender" v-model:value="form.gender" :options="genderOptions" />
        </FormItem>
        <FormItem html-for="tourist-remark" :label="$t('shell.tourists.formRemark')">
          <Textarea
            id="tourist-remark"
            v-model:value="form.remark"
            :maxlength="500"
            :rows="2"
            show-count
          />
        </FormItem>
      </div>
    </Form>
  </Modal>
</template>
