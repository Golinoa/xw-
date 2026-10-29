<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  type CreateCustomerRequest,
  type CustomerDetail,
  type CustomerDuplicate,
  type CustomerIdType,
  type CustomerTag,
  type UpdateCustomerRequest,
} from '@erp/contracts';
import { ApiClientError, ContractViolationError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

const props = defineProps<{
  open: boolean;
  /** 传入详情表示编辑；为空表示新建。编辑必须回传详情里的 version。 */
  customer: CustomerDetail | null;
  tags: readonly CustomerTag[];
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [payload: { customer: CustomerDetail; duplicates: CustomerDuplicate[] }];
}>();

const auth = useAuthStore();
const saving = ref(false);
const formError = ref('');

const form = reactive({
  name: '',
  phone: '',
  email: '',
  idType: undefined as CustomerIdType | undefined,
  idNumber: '',
  birthday: '',
  sourceId: undefined as string | undefined,
  tagIds: [] as string[],
  remark: '',
});

const isEditing = computed(() => props.customer !== null);

/**
 * 服务端按 `customer.sensitive.read` 决定是否返回证件号原值。只有「有掩码、没原值」
 * 才说明当前账号读不到，此时把证件字段整体当作不可编辑：只回传证件类型而省略号码
 * 会破坏「成对填写」的约束。
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

const identityPairIncomplete = computed(
  () => identityReadable.value && Boolean(form.idType) !== Boolean(form.idNumber.trim()),
);

const tagOptions = computed(() => props.tags.map((tag) => ({ value: tag.id, label: tag.name })));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const customer = props.customer;
    formError.value = '';
    form.name = customer?.name ?? '';
    form.phone = customer?.phone ?? '';
    form.email = customer?.email ?? '';
    form.idType = customer?.idType;
    form.idNumber = customer?.idNumber ?? '';
    form.birthday = customer?.birthday ?? '';
    form.sourceId = customer?.sourceId;
    form.tagIds = customer ? customer.tags.map((tag) => tag.id) : [];
    form.remark = customer?.remark ?? '';
  },
  { immediate: true },
);

interface CustomerFormFields {
  name: string;
  phone?: string | null;
  email?: string | null;
  idType?: CustomerIdType | null;
  idNumber?: string | null;
  birthday?: string | null;
  sourceId?: string | null;
  tagIds: string[];
  remark?: string | null;
}

/**
 * 契约用「缺失 = 不修改、null = 清空」区分两种意图，提交时必须如实表达：
 * - 新建，或当前账号看不到原值（例如无 sensitive 权限）：空值一律省略，
 *   否则会把用户根本没看到的原号码清掉；
 * - 编辑且能从响应里读到原值：空值传 null，用户才能真正删掉填错的字段。
 * `tagIds` 例外：传空数组即「清空全部标签」。
 */
function buildFields(options: {
  includeIdentity: boolean;
  clearPhone: boolean;
  clearEmail: boolean;
  clearOptional: boolean;
}): CustomerFormFields {
  const phone = form.phone.trim();
  const email = form.email.trim();
  const idNumber = form.idNumber.trim();
  const remark = form.remark.trim();
  const fields: CustomerFormFields = {
    name: form.name.trim(),
    tagIds: [...form.tagIds],
    ...(phone ? { phone } : options.clearPhone ? { phone: null } : {}),
    ...(email ? { email } : options.clearEmail ? { email: null } : {}),
    ...(form.birthday
      ? { birthday: form.birthday }
      : options.clearOptional
        ? { birthday: null }
        : {}),
    ...(form.sourceId
      ? { sourceId: form.sourceId }
      : options.clearOptional
        ? { sourceId: null }
        : {}),
    ...(remark ? { remark } : options.clearOptional ? { remark: null } : {}),
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
      return isEditing.value
        ? '数据已被他人修改，请刷新后重试'
        : '数据已存在或状态冲突，请确认手机号是否重复后重试';
    }
    return cause.message;
  }
  if (cause instanceof ContractViolationError) return '提交内容与服务端约定不一致，请联系管理员';
  return '保存失败，请稍后重试';
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  if (!form.name.trim()) {
    formError.value = '请填写客户姓名';
    return;
  }
  if (identityPairIncomplete.value) {
    formError.value = '证件类型与证件号需要同时填写，或同时留空';
    return;
  }

  saving.value = true;
  try {
    const fields = buildFields({
      includeIdentity: identityReadable.value,
      clearPhone: Boolean(props.customer) && phoneReadable.value,
      clearEmail: Boolean(props.customer) && props.customer?.email !== undefined,
      clearOptional: Boolean(props.customer),
    });
    if (props.customer) {
      const body: UpdateCustomerRequest = { ...fields, version: props.customer.version };
      const result = await auth.api.call('updateCustomer', {
        params: { customerId: props.customer.id },
        body,
      });
      emit('saved', { customer: result.customer, duplicates: [] });
    } else {
      const body: CreateCustomerRequest = fields;
      const result = await auth.api.call('createCustomer', { body });
      emit('saved', { customer: result.customer, duplicates: result.duplicates });
    }
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
    :title="isEditing ? '编辑客户' : '新建客户'"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    ok-text="保存"
    cancel-text="取消"
    width="720px"
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
        <a-form-item label="姓名" name="name" required>
          <a-input v-model:value="form.name" :maxlength="100" placeholder="客户姓名" />
        </a-form-item>
        <a-form-item label="电话" name="phone">
          <a-input
            v-model:value="form.phone"
            :maxlength="32"
            :placeholder="phoneReadable ? '手机号或座机' : '当前账号无权查看原号码，留空表示不修改'"
          />
        </a-form-item>
        <a-form-item label="邮箱" name="email">
          <a-input v-model:value="form.email" :maxlength="120" placeholder="用于联系与通知" />
        </a-form-item>
        <a-form-item label="生日" name="birthday">
          <a-date-picker
            v-model:value="form.birthday"
            value-format="YYYY-MM-DD"
            placeholder="选择出生日期"
            style="width: 100%"
          />
        </a-form-item>
        <a-form-item label="证件类型" name="idType">
          <a-select
            v-model:value="form.idType"
            allow-clear
            :disabled="!identityReadable"
            placeholder="可不填"
            :options="[
              { value: 'id_card', label: '身份证' },
              { value: 'passport', label: '护照' },
              { value: 'other', label: '其他证件' },
            ]"
          />
        </a-form-item>
        <a-form-item label="证件号" name="idNumber">
          <a-input
            v-model:value="form.idNumber"
            :maxlength="64"
            :disabled="!identityReadable"
            :placeholder="identityReadable ? '与证件类型成对填写' : '当前账号无权查看，暂不可修改'"
          />
        </a-form-item>
        <a-form-item label="来源" name="sourceId" class="span-2">
          <a-select
            v-model:value="form.sourceId"
            disabled
            allow-clear
            placeholder="来源维护功能尚未开放"
          />
        </a-form-item>
        <a-form-item label="标签" name="tagIds" class="span-2">
          <a-select
            v-model:value="form.tagIds"
            mode="multiple"
            allow-clear
            :options="tagOptions"
            placeholder="选择客户标签"
            :max-tag-count="6"
          />
        </a-form-item>
        <a-form-item label="备注" name="remark" class="span-2">
          <a-textarea
            v-model:value="form.remark"
            :maxlength="2000"
            :rows="3"
            show-count
            placeholder="补充说明，最多 2000 字"
          />
        </a-form-item>
      </div>
      <a-typography-text v-if="identityPairIncomplete" type="warning">
        证件类型与证件号需要同时填写，或同时留空。
      </a-typography-text>
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
