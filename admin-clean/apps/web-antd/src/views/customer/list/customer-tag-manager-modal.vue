<script lang="ts" setup>
import type { CustomerTag } from '@erp/contracts';

import { ref, watch } from 'vue';

import { Alert, Button, Empty, Input, message, Modal, Popconfirm } from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

/**
 * 标签管理。改色统一用 `#RRGGBB` 文本输入 + 色点预览，不引第三方取色器：
 * 标签颜色只影响可读性，多一个依赖不值当。
 */
const props = defineProps<{ open: boolean; tags: readonly CustomerTag[] }>();

const emit = defineEmits<{
  changed: [];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const HEX = /^#[\dA-Fa-f]{6}$/;

const newName = ref('');
const newColor = ref('');
const creating = ref(false);
const busyTagId = ref<null | string>(null);
const error = ref('');
const drafts = ref<Record<string, string>>({});
const colorDrafts = ref<Record<string, string>>({});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = '';
    newName.value = '';
    newColor.value = '';
    creating.value = false;
    busyTagId.value = null;
    drafts.value = Object.fromEntries(props.tags.map((tag) => [tag.id, tag.name]));
    colorDrafts.value = Object.fromEntries(props.tags.map((tag) => [tag.id, tag.color ?? '']));
  },
);

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'OBJECT_REFERENCED') return $t('shell.customers.tagInUse');
    if (cause.status === 409) return $t('shell.customers.tagNameConflict');
    return cause.message;
  }
  return $t('shell.customers.actionFailed');
}

async function createTag() {
  const name = newName.value.trim();
  const color = newColor.value.trim();
  if (!name) {
    error.value = $t('shell.customers.tagNameRequired');
    return;
  }
  if (color && !HEX.test(color)) {
    error.value = $t('shell.customers.tagColorInvalid');
    return;
  }
  error.value = '';
  creating.value = true;
  try {
    await authStore.api.call('createCustomerTag', {
      body: { name, ...(color ? { color } : {}) },
    });
    newName.value = '';
    newColor.value = '';
    message.success($t('shell.customers.tagCreated'));
    emit('changed');
  } catch (error_) {
    error.value = describeError(error_);
  } finally {
    creating.value = false;
  }
}

async function renameTag(tag: CustomerTag) {
  // 回车与失焦会连续触发同一个改名，正在提交时直接忽略第二次。
  if (busyTagId.value === tag.id) return;
  const draft = (drafts.value[tag.id] ?? '').trim();
  if (!draft || draft === tag.name) return;
  error.value = '';
  busyTagId.value = tag.id;
  try {
    await authStore.api.call('updateCustomerTag', {
      body: { name: draft },
      params: { tagId: tag.id },
    });
    message.success($t('shell.customers.tagRenamed'));
    emit('changed');
  } catch (error_) {
    error.value = describeError(error_);
    drafts.value[tag.id] = tag.name;
  } finally {
    busyTagId.value = null;
  }
}

/**
 * 逐行改色。空串表示「清掉颜色」——契约里 `color: null` 才是清空，
 * `undefined` 是「不修改」，所以这里必须显式发 null。
 */
async function commitColor(tag: CustomerTag) {
  if (busyTagId.value === tag.id) return;
  const draft = (colorDrafts.value[tag.id] ?? '').trim();
  if (draft && !HEX.test(draft)) {
    error.value = $t('shell.customers.tagColorInvalid');
    colorDrafts.value[tag.id] = tag.color ?? '';
    return;
  }
  if (draft === (tag.color ?? '')) return;
  error.value = '';
  busyTagId.value = tag.id;
  try {
    await authStore.api.call('updateCustomerTag', {
      body: { color: draft || null },
      params: { tagId: tag.id },
    });
    message.success($t('shell.customers.tagColorUpdated'));
    emit('changed');
  } catch (error_) {
    error.value = describeError(error_);
    colorDrafts.value[tag.id] = tag.color ?? '';
  } finally {
    busyTagId.value = null;
  }
}

async function deleteTag(tag: CustomerTag) {
  error.value = '';
  busyTagId.value = tag.id;
  try {
    await authStore.api.call('deleteCustomerTag', { params: { tagId: tag.id } });
    message.success($t('shell.customers.tagDeleted', { name: tag.name }));
    emit('changed');
  } catch (error_) {
    error.value = describeError(error_);
  } finally {
    busyTagId.value = null;
  }
}

function close() {
  emit('update:open', false);
}
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    :title="$t('shell.customers.tagManagerTitle')"
    :width="560"
    @cancel="close"
  >
    <Alert v-if="error" class="mb-3" :message="error" show-icon type="error" />

    <div class="mb-4 flex items-center gap-2">
      <Input
        v-model:value="newName"
        class="flex-1"
        :maxlength="30"
        :placeholder="$t('shell.customers.tagNamePlaceholder')"
        @press-enter="createTag"
      />
      <Input
        v-model:value="newColor"
        class="w-24"
        :maxlength="7"
        placeholder="#1b2a4a"
      />
      <span
        class="size-4 shrink-0 rounded border border-border"
        :style="{ background: HEX.test(newColor.trim()) ? newColor.trim() : 'transparent' }"
      ></span>
      <Button :loading="creating" type="primary" @click="createTag">
        {{ $t('shell.customers.tagCreate') }}
      </Button>
    </div>

    <Empty v-if="tags.length === 0" :description="$t('shell.customers.tagEmpty')" />

    <ul v-else class="m-0 grid list-none gap-2 p-0">
      <li v-for="tag in tags" :key="tag.id" class="flex items-center gap-2">
        <span
          class="size-2.5 shrink-0 rounded-full border border-border"
          :style="{
            background: HEX.test((colorDrafts[tag.id] ?? '').trim())
              ? colorDrafts[tag.id]!.trim()
              : 'transparent',
            borderColor: tag.color ?? undefined,
          }"
        ></span>
        <Input
          v-model:value="drafts[tag.id]"
          class="flex-1"
          :maxlength="30"
          size="small"
          @blur="renameTag(tag)"
          @press-enter="renameTag(tag)"
        />
        <Input
          v-model:value="colorDrafts[tag.id]"
          class="w-24"
          :maxlength="7"
          :placeholder="$t('shell.customers.tagColorPlaceholder')"
          size="small"
          @blur="commitColor(tag)"
          @press-enter="commitColor(tag)"
        />
        <Popconfirm
          :cancel-text="$t('shell.customers.cancel')"
          :ok-text="$t('shell.customers.delete')"
          :title="$t('shell.customers.tagDeleteConfirm')"
          @confirm="deleteTag(tag)"
        >
          <Button danger :loading="busyTagId === tag.id" size="small">
            {{ $t('shell.customers.delete') }}
          </Button>
        </Popconfirm>
      </li>
    </ul>

    <p class="mt-4 text-sm text-muted-foreground">{{ $t('shell.customers.tagHint') }}</p>
  </Modal>
</template>
