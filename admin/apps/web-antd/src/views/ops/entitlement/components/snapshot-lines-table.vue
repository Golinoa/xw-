<script lang="ts" setup>
import type { EntitlementSnapshotLine } from '#/api/ops/entitlement/types';

import { Table, Tag } from 'ant-design-vue';

import { formatQuota } from '#/api/ops/entitlement/format';

defineOptions({ name: 'EntitlementSnapshotLines' });

/**
 * 权益行表格（只读）。
 *
 * 快照行来自服务端 `snapshot.lines`，本组件不提供任何输入控件——快照发放后不可覆写
 * （契约 §3.5「仅 INSERT」）。额度只格式化，不做运算。
 */
defineProps<{
  lines: EntitlementSnapshotLine[];
}>();

const columns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 200 },
  {
    dataIndex: 'displayNameSnapshot',
    key: 'displayNameSnapshot',
    title: '显示名（快照）',
    width: 200,
  },
  { dataIndex: 'enabled', key: 'enabled', title: '启用', width: 90 },
  { dataIndex: 'quota', key: 'quota', title: '额度', width: 160 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 110,
  },
];
</script>

<template>
  <Table
    :columns="columns"
    :data-source="lines"
    :pagination="false"
    :row-key="(row: EntitlementSnapshotLine) => row.featureKey"
    :scroll="{ x: 760 }"
    size="small"
  >
    <template #bodyCell="{ column, record }">
      <template v-if="column.key === 'enabled'">
        <Tag :color="record.enabled ? 'green' : 'default'">
          {{ record.enabled ? '已启用' : '未启用' }}
        </Tag>
      </template>
      <template v-else-if="column.key === 'quota'">
        {{ formatQuota(record.quota) }}
      </template>
      <template v-else-if="column.key === 'termMonths'">
        {{ record.termMonths === null ? '—' : `${record.termMonths} 个月` }}
      </template>
    </template>
    <template #emptyText>
      <span class="text-sm text-muted-foreground">该快照没有权益行</span>
    </template>
  </Table>
</template>
