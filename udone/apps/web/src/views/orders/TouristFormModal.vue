<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type {
  Tourist,
  TouristDocumentType,
  TouristGender,
  TouristPersonType,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';
import {
  TOURIST_DOCUMENT_TYPE_OPTIONS,
  TOURIST_GENDER_OPTIONS,
  TOURIST_PERSON_TYPE_OPTIONS,
} from './tourist-display';

const props = defineProps<{
  open: boolean;
  orderId: string;
  /** null 表示新增。 */
  tourist: Tourist | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [];
}>();

const auth = useAuthStore();
const saving = ref(false);
const error = ref('');

const form = reactive({
  name: '',
  phone: '',
  documentType: undefined as TouristDocumentType | undefined,
  documentNumber: '',
  personType: 'adult' as TouristPersonType,
  age: undefined as number | undefined,
  gender: 'unknown' as TouristGender,
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
 * 证件号与手机的可编辑性。
 *
 * 没有 `customer.sensitive.read` 时服务端只返回掩码，原值字段是空的。
 * 这时把输入框锁住并从提交体里剔除：让用户对着 `11****34` 改字符，等于把
 * 掩码当原值写回去，一次「只是改个备注」的保存就把真实号码覆盖掉了。
 */
const documentLocked = computed(
  () =>
    isEdit.value && Boolean(props.tourist?.documentNumberMasked) && !props.tourist?.documentNumber,
);
const phoneLocked = computed(
  () => isEdit.value && Boolean(props.tourist?.phoneMasked) && !props.tourist?.phone,
);

function close() {
  if (saving.value) return;
  emit('update:open', false);
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'TOURIST_DOCUMENT_CONFLICT') return '这个证件号已经在名单里了';
    return cause.message;
  }
  return '保存失败，请稍后重试';
}

async function submit() {
  if (saving.value) return;
  const name = form.name.trim();
  if (!name) {
    error.value = '请填写姓名';
    return;
  }
  const documentNumber = form.documentNumber.trim();
  if (documentNumber && !form.documentType) {
    error.value = '填了证件号就必须选证件类型';
    return;
  }
  if (form.age !== undefined && (form.age < 0 || form.age > 150)) {
    error.value = '年龄需在 0–150 之间';
    return;
  }

  saving.value = true;
  error.value = '';
  try {
    if (props.tourist) {
      await auth.api.call('updateTourist', {
        params: { orderId: props.orderId, touristId: props.tourist.id },
        body: {
          name,
          age: form.age ?? null,
          gender: form.gender,
          remark: form.remark.trim() || null,
          ...(phoneLocked.value ? {} : { phone: form.phone.trim() || null }),
          ...(documentLocked.value
            ? {}
            : {
                documentType: form.documentType ?? null,
                documentNumber: documentNumber || null,
              }),
        },
      });
      message.success('游客已更新');
    } else {
      await auth.api.call('createTourist', {
        params: { orderId: props.orderId },
        body: {
          name,
          personType: form.personType,
          phone: form.phone.trim() || null,
          documentType: form.documentType ?? null,
          documentNumber: documentNumber || null,
          age: form.age ?? null,
          gender: form.gender,
          remark: form.remark.trim() || null,
        },
      });
      message.success('游客已添加');
    }
    emit('saved');
    emit('update:open', false);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="open"
    :title="isEdit ? '编辑游客' : '添加游客'"
    :ok-text="isEdit ? '保存' : '添加'"
    cancel-text="取消"
    :confirm-loading="saving"
    :mask-closable="!saving"
    @ok="submit"
    @cancel="close"
  >
    <a-alert v-if="error" class="form-error" type="error" show-icon :message="error" />
    <a-form layout="vertical">
      <a-row :gutter="16">
        <a-col :span="12">
          <a-form-item label="姓名" required>
            <a-input v-model:value="form.name" :maxlength="50" placeholder="与证件一致" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="类型" required>
            <a-select v-model:value="form.personType" :options="TOURIST_PERSON_TYPE_OPTIONS" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="证件类型">
            <a-select
              v-model:value="form.documentType"
              :options="TOURIST_DOCUMENT_TYPE_OPTIONS"
              allow-clear
              placeholder="选填"
            />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="证件号">
            <a-input
              v-model:value="form.documentNumber"
              :maxlength="40"
              :disabled="documentLocked"
              :placeholder="documentLocked ? '无权限查看完整证件号' : '选填，填写后同团不能重复'"
            />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="手机">
            <a-input
              v-model:value="form.phone"
              :maxlength="20"
              :disabled="phoneLocked"
              :placeholder="phoneLocked ? '无权限查看完整手机号' : '选填'"
            />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="年龄">
            <a-input-number v-model:value="form.age" :min="0" :max="150" class="full-width" />
          </a-form-item>
        </a-col>
        <a-col :span="12">
          <a-form-item label="性别">
            <a-select v-model:value="form.gender" :options="TOURIST_GENDER_OPTIONS" />
          </a-form-item>
        </a-col>
        <a-col :span="24">
          <a-form-item label="备注">
            <a-textarea v-model:value="form.remark" :rows="2" :maxlength="500" show-count />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>
  </a-modal>
</template>

<style scoped>
.form-error {
  margin-bottom: var(--space-12);
}

.full-width {
  width: 100%;
}
</style>
