<script lang="ts" setup>
import type {
  CreateSupplierRequest,
  Supplier,
  SupplierSettlement,
  SupplierType,
} from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import {
  Alert,
  Form,
  FormItem,
  Input,
  Modal,
  Select,
  SelectOption,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import {
  SUPPLIER_SETTLEMENT_LABEL_KEYS,
  SUPPLIER_SETTLEMENT_ORDER,
  SUPPLIER_TYPE_LABEL_KEYS,
  SUPPLIER_TYPE_ORDER,
} from '../display';

/**
 * `supplier` 有值就是编辑：空值发 `null` 表示清空，新建则省略这些字段。
 * 两种语义不能合并成「把表单原样发过去」，否则编辑时清空手机号会变成「不修改」。
 */
const props = defineProps<{ open: boolean; supplier?: null | Supplier }>();

const emit = defineEmits<{
  saved: [supplier: Supplier];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const saving = ref(false);
const formError = ref('');

const isEdit = computed(() => Boolean(props.supplier));

const form = reactive({
  contactName: '',
  name: '',
  phone: '',
  remark: '',
  /** 默认单团结算：大多数供应商是一次性付款，月结要人工确认。 */
  settlement: 'per_trip' as SupplierSettlement,
  type: undefined as SupplierType | undefined,
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    formError.value = '';
    const current = props.supplier;
    form.name = current?.name ?? '';
    form.type = current?.type;
    form.contactName = current?.contactName ?? '';
    form.phone = current?.phone ?? '';
    form.settlement = current?.settlement ?? 'per_trip';
    form.remark = current?.remark ?? '';
  },
);

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    // 供应商只有名称唯一约束会回 409，其余直接用客户端映射后的文案。
    if (cause.code === 'CONFLICT') return $t('shell.suppliers.nameConflict');
    return cause.message;
  }
  return $t('shell.suppliers.saveFailed');
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  const name = form.name.trim();
  if (!name) {
    formError.value = $t('shell.suppliers.nameRequired');
    return;
  }
  if (!form.type) {
    formError.value = $t('shell.suppliers.typeRequired');
    return;
  }

  saving.value = true;
  try {
    if (props.supplier) {
      const result = await authStore.api.call('updateSupplier', {
        body: {
          contactName: form.contactName.trim() || null,
          name,
          phone: form.phone.trim() || null,
          remark: form.remark.trim() || null,
          settlement: form.settlement,
          type: form.type,
        },
        params: { supplierId: props.supplier.id },
      });
      emit('saved', result.supplier);
      emit('update:open', false);
      return;
    }

    const body: CreateSupplierRequest = {
      name,
      settlement: form.settlement,
      type: form.type,
      ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
    };
    const result = await authStore.api.call('createSupplier', { body });
    emit('saved', result.supplier);
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
    :cancel-text="$t('shell.suppliers.cancel')"
    :closable="!saving"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :ok-text="$t('shell.suppliers.save')"
    :open="open"
    :title="isEdit ? $t('shell.suppliers.editTitle') : $t('shell.suppliers.createTitle')"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="formError" class="mb-4" :message="formError" role="alert" show-icon type="error" />
    <Form layout="vertical" :model="form">
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem class="col-span-2" html-for="supplier-name" :label="$t('shell.suppliers.formName')" required>
          <Input id="supplier-name" v-model:value="form.name" :maxlength="100" />
        </FormItem>
        <FormItem html-for="supplier-type" :label="$t('shell.suppliers.formType')" required>
          <Select
            id="supplier-type"
            v-model:value="form.type"
            :placeholder="$t('shell.suppliers.formTypePlaceholder')"
          >
            <SelectOption v-for="type in SUPPLIER_TYPE_ORDER" :key="type" :value="type">
              {{ $t(SUPPLIER_TYPE_LABEL_KEYS[type]) }}
            </SelectOption>
          </Select>
        </FormItem>
        <FormItem html-for="supplier-settlement" :label="$t('shell.suppliers.formSettlement')">
          <Select id="supplier-settlement" v-model:value="form.settlement">
            <SelectOption
              v-for="settlement in SUPPLIER_SETTLEMENT_ORDER"
              :key="settlement"
              :value="settlement"
            >
              {{ $t(SUPPLIER_SETTLEMENT_LABEL_KEYS[settlement]) }}
            </SelectOption>
          </Select>
        </FormItem>
        <FormItem html-for="supplier-contact" :label="$t('shell.suppliers.formContact')">
          <Input id="supplier-contact" v-model:value="form.contactName" :maxlength="50" />
        </FormItem>
        <FormItem html-for="supplier-phone" :label="$t('shell.suppliers.formPhone')">
          <Input id="supplier-phone" v-model:value="form.phone" :maxlength="32" />
        </FormItem>
      </div>
      <FormItem html-for="supplier-remark" :label="$t('shell.suppliers.formRemark')">
        <Textarea
          id="supplier-remark"
          v-model:value="form.remark"
          :maxlength="2000"
          :placeholder="$t('shell.suppliers.formRemarkPlaceholder')"
          :rows="3"
        />
      </FormItem>
    </Form>
  </Modal>
</template>
