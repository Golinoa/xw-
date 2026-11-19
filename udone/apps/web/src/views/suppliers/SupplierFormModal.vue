<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  type CreateSupplierRequest,
  type Supplier,
  type SupplierSettlement,
  type SupplierType,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import { SUPPLIER_SETTLEMENT_OPTIONS, SUPPLIER_TYPE_OPTIONS } from './supplier-display';

/** `supplier` 有值就是编辑：空值发 `null` 表示清空，新建则省略这些字段。 */
const props = defineProps<{ open: boolean; supplier?: Supplier | null }>();
const isEdit = computed(() => Boolean(props.supplier));

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [supplier: Supplier];
}>();

const auth = useAuthStore();
const saving = ref(false);
const formError = ref('');

const form = reactive({
  name: '',
  type: undefined as SupplierType | undefined,
  contactName: '',
  phone: '',
  /** 默认单团结算：大多数线路是一次性付款，月结要人工确认。 */
  settlement: 'per_trip' as SupplierSettlement,
  remark: '',
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
    // 新建供应商只有名称唯一约束会返回 409，其余情况直接展示客户端映射后的文案。
    if (cause.code === 'CONFLICT') return '供应商名称已存在，请换一个名称';
    return cause.message;
  }
  return '保存失败，请稍后重试';
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  const name = form.name.trim();
  if (!name) {
    formError.value = '请填写供应商名称';
    return;
  }
  if (!form.type) {
    formError.value = '请选择供应商类型';
    return;
  }

  saving.value = true;
  try {
    if (props.supplier) {
      const result = await auth.api.call('updateSupplier', {
        params: { supplierId: props.supplier.id },
        body: {
          name,
          type: form.type,
          settlement: form.settlement,
          contactName: form.contactName.trim() || null,
          phone: form.phone.trim() || null,
          remark: form.remark.trim() || null,
        },
      });
      emit('saved', result.supplier);
      emit('update:open', false);
      return;
    }

    const body: CreateSupplierRequest = {
      name,
      type: form.type,
      settlement: form.settlement,
      ...(form.contactName.trim() ? { contactName: form.contactName.trim() } : {}),
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
    };
    const result = await auth.api.call('createSupplier', { body });
    emit('saved', result.supplier);
    emit('update:open', false);
  } catch (cause) {
    formError.value = describeError(cause);
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
  <a-modal
    :open="open"
    :title="isEdit ? '编辑供应商' : '新建供应商'"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    ok-text="保存"
    cancel-text="取消"
    width="560px"
    @ok="submit"
    @cancel="close"
  >
    <a-alert
      v-if="formError"
      class="form-error"
      type="error"
      show-icon
      :message="formError"
      role="alert"
    />
    <a-form layout="vertical" :model="form">
      <div class="form-grid">
        <a-form-item label="名称" name="name" required class="span-2">
          <a-input v-model:value="form.name" :maxlength="100" placeholder="供应商名称" />
        </a-form-item>
        <a-form-item label="类型" name="type" required>
          <a-select
            v-model:value="form.type"
            :options="SUPPLIER_TYPE_OPTIONS"
            placeholder="选择供应商类型"
          />
        </a-form-item>
        <a-form-item label="结算方式" name="settlement">
          <a-select v-model:value="form.settlement" :options="SUPPLIER_SETTLEMENT_OPTIONS" />
        </a-form-item>
        <a-form-item label="联系人" name="contactName">
          <a-input v-model:value="form.contactName" :maxlength="50" placeholder="对接人姓名" />
        </a-form-item>
        <a-form-item label="电话" name="phone">
          <a-input v-model:value="form.phone" :maxlength="32" placeholder="手机号或座机" />
        </a-form-item>
        <a-form-item label="备注" name="remark" class="span-2">
          <a-textarea
            v-model:value="form.remark"
            :maxlength="2000"
            :rows="3"
            show-count
            placeholder="结算约定等补充说明，最多 2000 字"
          />
        </a-form-item>
      </div>
    </a-form>
  </a-modal>
</template>

<style scoped>
.form-error {
  margin-bottom: var(--space-16);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--space-16);
}

.span-2 {
  grid-column: span 2;
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .span-2 {
    grid-column: span 1;
  }
}
</style>
