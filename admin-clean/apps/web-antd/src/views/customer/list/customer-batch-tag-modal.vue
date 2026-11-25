<script lang="ts" setup>
import type { CustomerTag } from '@erp/contracts';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Form,
  FormItem,
  message,
  Modal,
  RadioButton,
  RadioGroup,
  Select,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

/**
 * 批量打标。
 *
 * 走 batchTagCustomers 而不是循环 PATCH：循环会在第 N 个失败时留下
 * 「前 N-1 个已改」的中间态，用户重试又会重复打标。
 */
const props = defineProps<{
  customerIds: readonly string[];
  open: boolean;
  tags: readonly CustomerTag[];
}>();

const emit = defineEmits<{
  applied: [];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
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

const tagOptions = computed(() => props.tags.map((tag) => ({ label: tag.name, value: tag.id })));
const summary = computed(() =>
  $t('shell.customers.batchTargetValue', { count: props.customerIds.length }),
);

async function submit() {
  if (saving.value) return;
  if (tagIds.value.length === 0) {
    error.value =
      mode.value === 'add'
        ? $t('shell.customers.batchPickAdd')
        : $t('shell.customers.batchPickRemove');
    return;
  }
  error.value = '';
  saving.value = true;
  try {
    const result = await authStore.api.call('batchTagCustomers', {
      body: {
        customerIds: [...props.customerIds],
        ...(mode.value === 'add'
          ? { addTagIds: [...tagIds.value] }
          : { removeTagIds: [...tagIds.value] }),
      },
    });
    message.success(
      $t('shell.customers.batchApplied', { count: result.updatedCustomerIds.length }),
    );
    emit('applied');
    emit('update:open', false);
  } catch (error_) {
    if (error_ instanceof ApiClientError) {
      error.value =
        error_.code === 'NOT_FOUND' ? $t('shell.customers.batchMissing') : error_.message;
    } else {
      error.value = $t('shell.customers.batchFailed');
    }
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
    :ok-text="$t('shell.customers.apply')"
    :open="open"
    :title="$t('shell.customers.batchTitle')"
    :width="480"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="error" class="mb-3" :message="error" show-icon type="error" />

    <Form layout="vertical">
      <FormItem :label="$t('shell.customers.batchTarget')">
        <span class="text-muted-foreground">{{ summary }}</span>
      </FormItem>
      <FormItem :label="$t('shell.customers.batchMode')">
        <RadioGroup v-model:value="mode" button-style="solid">
          <RadioButton value="add">{{ $t('shell.customers.batchAdd') }}</RadioButton>
          <RadioButton value="remove">{{ $t('shell.customers.batchRemove') }}</RadioButton>
        </RadioGroup>
      </FormItem>
      <FormItem
        html-for="batch-tag-select"
        :label="
          mode === 'add' ? $t('shell.customers.batchAddTags') : $t('shell.customers.batchRemoveTags')
        "
      >
        <Select
          id="batch-tag-select"
          v-model:value="tagIds"
          allow-clear
          mode="multiple"
          :max-tag-count="6"
          :options="tagOptions"
          :placeholder="
            mode === 'add' ? $t('shell.customers.batchPickAdd') : $t('shell.customers.batchPickRemove')
          "
        />
      </FormItem>
    </Form>
    <p class="m-0 text-sm text-muted-foreground">{{ $t('shell.customers.batchHint') }}</p>
  </Modal>
</template>
