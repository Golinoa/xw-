<script setup lang="ts">
import { ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { CustomerTag } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

const props = defineProps<{
  open: boolean;
  tags: readonly CustomerTag[];
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  changed: [];
}>();

const auth = useAuthStore();
const HEX = /^#[0-9a-fA-F]{6}$/;

const newName = ref('');
const newColor = ref('');
const creating = ref(false);
const busyTagId = ref<string | null>(null);
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
    if (cause.code === 'OBJECT_REFERENCED')
      return '该标签仍有客户在用，请先在客户上取消该标签再删除';
    if (cause.status === 409) return '已有同名标签，换一个名字再试';
    return cause.message;
  }
  return '操作失败，请稍后重试';
}

async function createTag() {
  const name = newName.value.trim();
  const color = newColor.value.trim();
  if (!name) {
    error.value = '请填写标签名称';
    return;
  }
  if (color && !HEX.test(color)) {
    error.value = '颜色需为 #RRGGBB 格式，例如 #1b2a4a';
    return;
  }
  error.value = '';
  creating.value = true;
  try {
    await auth.api.call('createCustomerTag', {
      body: { name, ...(color ? { color } : {}) },
    });
    newName.value = '';
    newColor.value = '';
    message.success('标签已创建');
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
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
    await auth.api.call('updateCustomerTag', {
      params: { tagId: tag.id },
      body: { name: draft },
    });
    message.success('标签已改名');
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
    drafts.value[tag.id] = tag.name;
  } finally {
    busyTagId.value = null;
  }
}

/**
 * 逐行改色。
 *
 * 空串表示「清掉颜色」——契约里 `color: null` 才是清空，`undefined` 是「不修改」，
 * 所以这里必须显式发 null，否则用户清空输入框后颜色永远去不掉。
 */
async function commitColor(tag: CustomerTag) {
  if (busyTagId.value === tag.id) return;
  const draft = (colorDrafts.value[tag.id] ?? '').trim();
  if (draft && !HEX.test(draft)) {
    error.value = '颜色需为 #RRGGBB 格式，例如 #1b2a4a';
    colorDrafts.value[tag.id] = tag.color ?? '';
    return;
  }
  if (draft === (tag.color ?? '')) return;
  error.value = '';
  busyTagId.value = tag.id;
  try {
    await auth.api.call('updateCustomerTag', {
      params: { tagId: tag.id },
      body: { color: draft || null },
    });
    message.success('标签颜色已更新');
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
    colorDrafts.value[tag.id] = tag.color ?? '';
  } finally {
    busyTagId.value = null;
  }
}

async function deleteTag(tag: CustomerTag) {
  error.value = '';
  busyTagId.value = tag.id;
  try {
    await auth.api.call('deleteCustomerTag', { params: { tagId: tag.id } });
    message.success(`已删除标签「${tag.name}」`);
    emit('changed');
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    busyTagId.value = null;
  }
}

function close() {
  emit('update:open', false);
}
</script>

<template>
  <a-modal :open="open" title="标签管理" :footer="null" width="560px" @cancel="close">
    <a-alert v-if="error" class="manager-error" type="error" show-icon :message="error" />

    <div class="create-row">
      <a-input
        v-model:value="newName"
        :maxlength="30"
        placeholder="新标签名称"
        class="name-input"
        @press-enter="createTag"
      />
      <a-input v-model:value="newColor" :maxlength="7" placeholder="#1b2a4a" class="color-input" />
      <span
        class="color-preview"
        :style="{ background: HEX.test(newColor.trim()) ? newColor.trim() : 'transparent' }"
      />
      <a-button type="primary" :loading="creating" @click="createTag">新建</a-button>
    </div>

    <a-empty v-if="tags.length === 0" description="还没有标签，先在上方新建一个" />

    <ul v-else class="tag-list">
      <li v-for="tag in tags" :key="tag.id" class="tag-row">
        <span
          class="tag-dot"
          :style="{
            background: HEX.test((colorDrafts[tag.id] ?? '').trim())
              ? colorDrafts[tag.id].trim()
              : 'transparent',
            borderColor: tag.color ?? undefined,
          }"
        />
        <a-input
          v-model:value="drafts[tag.id]"
          :maxlength="30"
          size="small"
          class="rename-input"
          @press-enter="renameTag(tag)"
          @blur="renameTag(tag)"
        />
        <a-input
          v-model:value="colorDrafts[tag.id]"
          :maxlength="7"
          size="small"
          class="color-input"
          placeholder="留空即无颜色"
          @press-enter="commitColor(tag)"
          @blur="commitColor(tag)"
        />
        <a-popconfirm
          title="删除后无法恢复，确定删除这个标签？"
          ok-text="删除"
          cancel-text="取消"
          @confirm="deleteTag(tag)"
        >
          <a-button size="small" danger :loading="busyTagId === tag.id">删除</a-button>
        </a-popconfirm>
      </li>
    </ul>

    <p class="manager-hint">改名或删除后，已打标的客户会立即跟着变；仍有客户在用的标签删不掉。</p>
  </a-modal>
</template>

<style scoped>
.manager-error {
  margin-bottom: var(--space-12);
}

.create-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  margin-bottom: var(--space-16);
}

.name-input {
  flex: 1;
}

.color-input {
  width: 96px;
}

.color-preview {
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-default);
}

.tag-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: var(--space-8);
}

.tag-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}

.tag-dot {
  width: 10px;
  height: 10px;
  flex: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
}

.rename-input {
  flex: 1;
}

.manager-hint {
  margin: var(--space-16) 0 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
}
</style>
