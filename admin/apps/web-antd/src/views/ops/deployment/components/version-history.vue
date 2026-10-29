<script lang="ts" setup>
import type { DeploymentVersionRecord } from '#/api/ops/deployment';

import { Empty, Table, Tag } from 'ant-design-vue';

import {
  actorName,
  formatDate,
  formatDateTime,
  VERSION_HISTORY_IMMUTABLE_NOTE,
  versionResultView,
  versionTransitionText,
} from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentVersionHistory' });

/**
 * 版本升级历史（**只读**）。
 *
 * 契约 §3.7：`ops.deployment_version_records` 仅 INSERT，没有 UPDATE/DELETE 授权。
 * 因此本组件不渲染任何操作列：没有编辑、没有删除、没有「撤销登记」。
 * 写错了只能再登记一条更正记录——历史是事实，不是可编辑的字段。
 */
const props = withDefaults(
  defineProps<{
    loading?: boolean;
    /** 服务端按 `executed_on` 倒序返回，前端不再排序。 */
    records: DeploymentVersionRecord[];
  }>(),
  { loading: false },
);

const columns = [
  { key: 'version', title: '升级前后版本', width: 230 },
  { key: 'executedOn', title: '执行日期', width: 120 },
  { key: 'executedBy', title: '操作人', width: 150 },
  { key: 'result', title: '结果', width: 100 },
  { key: 'impactNote', title: '影响说明', width: 260 },
  { key: 'rollbackNote', title: '回滚备注', width: 220 },
  { key: 'createdAt', title: '登记时间', width: 150 },
];
</script>

<template>
  <div data-testid="deployment-version-history">
    <Table
      :columns="columns"
      :data-source="props.records"
      :loading="props.loading"
      :pagination="false"
      :row-key="
        (row: DeploymentVersionRecord) =>
          row.id ?? `${row.executedOn}-${row.toVersion}`
      "
      :scroll="{ x: 1200 }"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'version'">
          <span class="font-mono text-xs">
            {{ versionTransitionText(record.fromVersion, record.toVersion) }}
          </span>
        </template>
        <template v-else-if="column.key === 'executedOn'">
          {{ formatDate(record.executedOn) }}
        </template>
        <template v-else-if="column.key === 'executedBy'">
          {{ actorName(record.executedBy) }}
        </template>
        <template v-else-if="column.key === 'result'">
          <Tag :color="versionResultView(record.result).color">
            {{ versionResultView(record.result).label }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'impactNote'">
          {{ record.impactNote || '—' }}
        </template>
        <template v-else-if="column.key === 'rollbackNote'">
          {{ record.rollbackNote || '—' }}
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ formatDateTime(record.createdAt) }}
        </template>
      </template>
      <template #emptyText>
        <Empty
          description="尚无升级记录（首次升级登记后会出现在这里）"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
        />
      </template>
    </Table>

    <p
      class="mt-2 text-xs text-muted-foreground"
      data-testid="deployment-version-history-note"
    >
      {{ VERSION_HISTORY_IMMUTABLE_NOTE }}
    </p>
  </div>
</template>
