<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { CustomerTag } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

const props = defineProps<{
  open: boolean;
  customerIds: readonly string[];
  tags: readonly CustomerTag[];
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  applied: [];
}>();

const auth = useAuthStore();
const mode = ref<'add' | 'remove'>('add');
const tagIds = ref<string[]>([]);
const saving = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    mode.value = 'add';
    tagIds.value = [];
    error.value = '';
    saving.value = false;
  },
);

const tagOptions = computed(() => props.tags.map((tag) => ({ value: tag.id, label: tag.name })));
const summary = computed(() => `已选 ${props.customerIds.length} 位客户`);

async function submit() {
  if (saving.value) return;
  if (tagIds.value.length === 0) {
    error.value = mode.value === 'add' ? '请选择要添加的标签' : '请选择要移除的标签';
    return;
  }
  error.value = '';
  saving.value = true;
  try {
    const result = await auth.api.call('batchTagCustomers', {
      body: {
        customerIds: [...props.customerIds],
        ...(mode.value === 'add'
          ? { addTagIds: [...tagIds.value] }
          : { removeTagIds: [...tagIds.value] }),
      },
    });
    message.success(`已更新 ${result.updatedCustomerIds.length} 位客户的标签`);
    emit('applied');
    emit('update:open', false);
  } catch (cause) {
    error.value =
      cause instanceof ApiClientError
        ? cause.code === 'NOT_FOUND'
          ? '部分客户已被删除或不在你的数据范围内，请刷新列表后重新选择'
          : cause.message
        : '批量打标失败，请稍后重试';
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
    title="批量打标"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    ok-text="应用"
    cancel-text="取消"
    width="480px"
    @ok="submit"
    @cancel="close"
  >
    <a-alert v-if="error" class="batch-error" type="error" show-icon :message="error" />

    <a-form layout="vertical">
      <a-form-item label="对象">
        <span class="batch-summary">{{ summary }}</span>
      </a-form-item>
      <a-form-item label="操作">
        <a-radio-group v-model:value="mode" button-style="solid">
          <a-radio-button value="add">添加标签</a-radio-button>
          <a-radio-button value="remove">移除标签</a-radio-button>
        </a-radio-group>
      </a-form-item>
      <a-form-item :label="mode === 'add' ? '要添加的标签' : '要移除的标签'">
        <a-select
          v-model:value="tagIds"
          mode="multiple"
          allow-clear
          :options="tagOptions"
          :max-tag-count="6"
          :placeholder="mode === 'add' ? '选择标签' : '选择要移除的标签'"
        />
      </a-form-item>
    </a-form>
    <p class="batch-hint">整批要么全部成功，要么一条都不改；中途有客户被删除会提示你重新选择。</p>
  </a-modal>
</template>

<style scoped>
.batch-error {
  margin-bottom: var(--space-12);
}

.batch-summary {
  color: var(--color-secondary-text);
}

.batch-hint {
  margin: 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
</style>
