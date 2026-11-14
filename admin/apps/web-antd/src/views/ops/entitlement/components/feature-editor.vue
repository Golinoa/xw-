<script lang="ts" setup>
import type { EntitlementFeatureInput } from '#/api/ops/entitlement/types';

import {
  Button,
  Empty,
  Input,
  InputNumber,
  Switch,
  Table,
} from 'ant-design-vue';

defineOptions({ name: 'EntitlementFeatureEditor' });

/**
 * 权益行编辑器（创建草稿 / 提出变更申请时使用）。
 *
 * 只编辑「将要发放的新快照」，不接触任何已发放快照——已发放快照只读
 * （契约 §3.5：快照仅 INSERT）。额度用 `InputNumber`（最多 2 位小数，与
 * `numeric(14,2)` 对齐），前端不做任何额度运算。
 */
const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    modelValue: EntitlementFeatureInput[];
  }>(),
  { disabled: false },
);

const emit = defineEmits<{
  'update:modelValue': [EntitlementFeatureInput[]];
}>();

const columns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 210 },
  {
    dataIndex: 'displayName',
    key: 'displayName',
    title: '显示名',
    width: 200,
  },
  { dataIndex: 'enabled', key: 'enabled', title: '启用', width: 80 },
  { dataIndex: 'quota', key: 'quota', title: '额度', width: 160 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 130,
  },
  { key: 'actions', title: '操作', width: 80 },
];

function patchAt(index: number, patch: Partial<EntitlementFeatureInput>): void {
  const next = props.modelValue.map((row, rowIndex) =>
    rowIndex === index ? { ...row, ...patch } : row,
  );
  emit('update:modelValue', next);
}

function removeAt(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_row, rowIndex) => rowIndex !== index),
  );
}

function addRow(): void {
  emit('update:modelValue', [
    ...props.modelValue,
    {
      displayName: '',
      enabled: true,
      featureKey: '',
      quota: null,
      termMonths: null,
    },
  ]);
}
</script>

<template>
  <div>
    <Table
      :columns="columns"
      :data-source="modelValue"
      :pagination="false"
      :row-key="
        (_row: EntitlementFeatureInput, index?: number) => String(index ?? 0)
      "
      :scroll="{ x: 880 }"
      size="small"
    >
      <template #bodyCell="{ column, index, record }">
        <template v-if="column.key === 'featureKey'">
          <Input
            :disabled="disabled"
            :value="record.featureKey"
            placeholder="如 travel.guide"
            @update:value="patchAt(index, { featureKey: $event })"
          />
        </template>
        <template v-else-if="column.key === 'displayName'">
          <Input
            :disabled="disabled"
            :value="record.displayName"
            placeholder="展示名（写入快照）"
            @update:value="patchAt(index, { displayName: $event })"
          />
        </template>
        <template v-else-if="column.key === 'enabled'">
          <Switch
            :checked="record.enabled"
            :disabled="disabled"
            @update:checked="patchAt(index, { enabled: Boolean($event) })"
          />
        </template>
        <template v-else-if="column.key === 'quota'">
          <InputNumber
            :disabled="disabled"
            :min="0"
            :precision="2"
            :value="record.quota ?? undefined"
            placeholder="无数额留空"
            style="width: 100%"
            @update:value="
              patchAt(index, { quota: $event === null ? null : Number($event) })
            "
          />
        </template>
        <template v-else-if="column.key === 'termMonths'">
          <InputNumber
            :disabled="disabled"
            :min="0"
            :precision="0"
            :value="record.termMonths ?? undefined"
            placeholder="不限留空"
            style="width: 100%"
            @update:value="
              patchAt(index, {
                termMonths: $event === null ? null : Number($event),
              })
            "
          />
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button
            :disabled="disabled"
            danger
            size="small"
            type="link"
            @click="removeAt(index)"
          >
            移除
          </Button>
        </template>
      </template>
      <template #emptyText>
        <Empty
          description="还没有权益行：请至少添加一个功能键"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />
      </template>
    </Table>

    <Button class="mt-2" :disabled="disabled" size="small" @click="addRow">
      添加功能键
    </Button>
  </div>
</template>
