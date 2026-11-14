<script lang="ts" setup>
/**
 * 字典项新增 / 编辑（契约 §5.9 `/dictionaries/{code}/items`、`/dictionary-items/{itemId}`）。
 *
 * 两条约束：
 * 1. **只有停用没有删除**：`value` 是历史单据上的取值，删掉会让旧数据回显不出中文，
 *    所以编辑态只能改文案、排序与启用状态。
 * 2. **编辑需要条目 id**：契约 §5.9 的字典项响应没有 `id`，而 PATCH 端点按 id 寻址。
 *    缺少 id 时禁用编辑并说明原因（已登记为契约缺口 G-4），不猜一个 id 出来。
 */
import type { IdentityErrorView, OpsDictionaryItem } from '#/api/ops/identity';

import { computed, ref, watch } from 'vue';

import { Alert, Input, InputNumber, Modal, Switch } from 'ant-design-vue';

defineOptions({ name: 'GovernanceDictionaryItemModal' });

const props = withDefaults(
  defineProps<{
    dictionaryName: string;
    error: IdentityErrorView | null;
    item?: null | OpsDictionaryItem;
    mode: 'create' | 'edit';
    open: boolean;
    submitting?: boolean;
  }>(),
  { item: null, submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [
    payload: {
      isActive?: boolean;
      label: string;
      sortOrder?: number;
      value?: string;
    },
  ];
}>();

const value = ref('');
const label = ref('');
const sortOrder = ref<number>(1);
const isActive = ref(true);
const localError = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    value.value = props.item?.value ?? '';
    label.value = props.item?.label ?? '';
    sortOrder.value = props.item?.sortOrder ?? 1;
    isActive.value = props.item?.isActive ?? true;
    localError.value = null;
  },
);

const isEdit = computed(() => props.mode === 'edit');

function onOk() {
  if (props.submitting) {
    return;
  }
  const trimmedLabel = label.value.trim();
  if (trimmedLabel === '') {
    localError.value = '请填写展示文案';
    return;
  }
  if (!isEdit.value) {
    const trimmedValue = value.value.trim();
    if (trimmedValue === '') {
      localError.value = '请填写取值（写入单据，创建后不可修改）';
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(trimmedValue)) {
      localError.value =
        '取值需为小写字母/数字开头，仅含小写字母、数字、下划线与连字符';
      return;
    }
    localError.value = null;
    emit('submit', {
      label: trimmedLabel,
      sortOrder: sortOrder.value,
      value: trimmedValue,
    });
    return;
  }
  localError.value = null;
  emit('submit', {
    isActive: isActive.value,
    label: trimmedLabel,
    sortOrder: sortOrder.value,
  });
}

function onCancel() {
  if (props.submitting) {
    return;
  }
  emit('cancel');
}
</script>

<template>
  <Modal
    :cancel-button-props="{ disabled: submitting }"
    :confirm-loading="submitting"
    :mask-closable="false"
    :ok-text="isEdit ? '保存' : '新增'"
    :open="open"
    :title="`${isEdit ? '编辑' : '新增'}字典项 · ${dictionaryName}`"
    :width="520"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <div>
        <div class="mb-1 text-sm text-foreground">取值</div>
        <Input
          v-model:value="value"
          :disabled="isEdit"
          placeholder="例如 bank_transfer"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          {{
            isEdit
              ? '取值写入历史单据，创建后不可修改（改了旧单据就回显不出对应文案）。'
              : '同一字典内不可重复（重复返回 409）。'
          }}
        </p>
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">展示文案</div>
        <Input v-model:value="label" placeholder="例如 银行转账" />
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">排序</div>
        <InputNumber v-model:value="sortOrder" :min="0" :precision="0" />
        <p class="mt-1 text-xs text-muted-foreground">
          数字越小越靠前；同值时的先后由服务端决定。
        </p>
      </div>

      <div v-if="isEdit">
        <div class="mb-1 text-sm text-foreground">启用</div>
        <div class="flex items-center gap-3">
          <Switch v-model:checked="isActive" />
          <span class="text-sm text-muted-foreground">
            {{
              isActive
                ? '可选（新单据能选到）'
                : '已停用（历史单据仍显示此文案）'
            }}
          </span>
        </div>
      </div>

      <Alert v-if="localError" :message="localError" show-icon type="warning" />

      <Alert v-if="error" :message="error.title" show-icon type="error">
        <template #description>
          <p>{{ error.description }}</p>
          <p v-if="error.requestId" class="mt-1 text-xs">
            请求 ID：{{ error.requestId }}
          </p>
        </template>
      </Alert>
    </div>
  </Modal>
</template>
