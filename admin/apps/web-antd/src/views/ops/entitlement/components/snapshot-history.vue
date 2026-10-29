<script lang="ts" setup>
import type { EntitlementSnapshotSummary } from '#/api/ops/entitlement/types';

import { Alert, Button, Empty, Table, Tag } from 'ant-design-vue';

import { actorName, formatDateTime } from '#/api/ops/entitlement/format';
import { SNAPSHOT_IMMUTABLE_NOTE } from '#/api/ops/entitlement/rules';

defineOptions({ name: 'EntitlementSnapshotHistory' });

/**
 * 快照历史（只读）。
 *
 * 界面**不得**提供编辑/删除快照的入口：快照仅 INSERT（契约 §3.5、源码参考门 §3.4），
 * 权益调整只能新增变更申请。历史按 `createdAt` 倒序展示，由服务端排序。
 * 这里唯一的按钮是「查看明细」——纯读取。
 */
defineProps<{
  currentSnapshotId?: null | string;
  loading?: boolean;
  snapshots: EntitlementSnapshotSummary[];
}>();

const emit = defineEmits<{
  view: [string];
}>();

const columns = [
  { dataIndex: 'createdAt', key: 'createdAt', title: '生成时间', width: 170 },
  { dataIndex: 'sourceType', key: 'sourceType', title: '来源', width: 130 },
  { dataIndex: 'valid', key: 'valid', title: '生效区间', width: 200 },
  { dataIndex: 'lineCount', key: 'lineCount', title: '权益行', width: 90 },
  { dataIndex: 'createdBy', key: 'createdBy', title: '生成人', width: 150 },
  { key: 'actions', title: '操作', width: 110 },
];
</script>

<template>
  <div data-testid="snapshot-history">
    <Alert
      class="mb-2"
      :message="SNAPSHOT_IMMUTABLE_NOTE"
      show-icon
      type="info"
    />

    <Table
      :columns="columns"
      :data-source="snapshots"
      :loading="loading"
      :pagination="false"
      :row-key="(row: EntitlementSnapshotSummary) => row.id"
      :scroll="{ x: 900 }"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">
          <div class="flex items-center gap-2">
            <span>{{ formatDateTime(record.createdAt) }}</span>
            <Tag
              v-if="currentSnapshotId && record.id === currentSnapshotId"
              color="green"
            >
              当前
            </Tag>
          </div>
        </template>
        <template v-else-if="column.key === 'sourceType'">
          {{ record.sourceType === 'change_request' ? '变更申请' : '合同条目' }}
        </template>
        <template v-else-if="column.key === 'valid'">
          {{ record.validFrom || '—' }} ~ {{ record.validTo || '长期' }}
        </template>
        <template v-else-if="column.key === 'lineCount'">
          {{ record.lineCount ?? '—' }}
        </template>
        <template v-else-if="column.key === 'createdBy'">
          {{ actorName(record.createdBy) }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button size="small" type="link" @click="emit('view', record.id)">
            查看明细
          </Button>
        </template>
      </template>
      <template #emptyText>
        <Empty
          description="暂无历史快照"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />
      </template>
    </Table>
  </div>
</template>
