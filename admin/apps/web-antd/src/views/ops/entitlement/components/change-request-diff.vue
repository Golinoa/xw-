<script lang="ts" setup>
import type {
  EntitlementDiff,
  EntitlementSummary,
  EntitlementSummaryFeature,
} from '#/api/ops/entitlement/types';

import { computed } from 'vue';

import { Alert, Table, Tag } from 'ant-design-vue';

import { formatQuota } from '#/api/ops/entitlement/format';

defineOptions({ name: 'EntitlementChangeDiff' });

/**
 * 权益差异预览（before / after）。
 *
 * 数据来自服务端 `before_summary` / `after_summary`（契约 §3.5），页面只做**展示性**
 * 对比：不计算额度差值（§2.2 只格式化），只标出「新增 / 移除 / 变更 / 不变」。
 * `jsonb` 结构契约未定死：拿到 `features` 时结构化对比，拿不到时降级为原文，不猜测。
 */
const props = defineProps<{
  diff: EntitlementDiff | null;
  emptyText?: string;
}>();

interface DiffRow {
  after?: EntitlementSummaryFeature;
  before?: EntitlementSummaryFeature;
  change: 'added' | 'changed' | 'removed' | 'unchanged';
  featureKey: string;
}

const columns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 200 },
  { dataIndex: 'change', key: 'change', title: '变更', width: 100 },
  { dataIndex: 'before', key: 'before', title: '变更前', width: 280 },
  { dataIndex: 'after', key: 'after', title: '变更后', width: 280 },
];

function featureMap(summary: EntitlementSummary | undefined) {
  const map = new Map<string, EntitlementSummaryFeature>();
  for (const feature of summary?.features ?? []) {
    map.set(feature.featureKey, feature);
  }
  return map;
}

function sameFeature(
  left: EntitlementSummaryFeature,
  right: EntitlementSummaryFeature,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.quota === right.quota &&
    left.termMonths === right.termMonths &&
    (left.displayName ?? '') === (right.displayName ?? '')
  );
}

const rows = computed<DiffRow[]>(() => {
  if (!props.diff) {
    return [];
  }
  const before = featureMap(props.diff.before);
  const after = featureMap(props.diff.after);
  const keys = [...new Set([...before.keys(), ...after.keys()])].toSorted(
    (a, b) => a.localeCompare(b),
  );
  return keys.map((featureKey) => {
    const beforeFeature = before.get(featureKey);
    const afterFeature = after.get(featureKey);
    if (!beforeFeature && afterFeature) {
      return { after: afterFeature, change: 'added', featureKey };
    }
    if (beforeFeature && !afterFeature) {
      return { before: beforeFeature, change: 'removed', featureKey };
    }
    if (beforeFeature && afterFeature) {
      return {
        after: afterFeature,
        before: beforeFeature,
        change: sameFeature(beforeFeature, afterFeature)
          ? 'unchanged'
          : 'changed',
        featureKey,
      };
    }
    return { change: 'unchanged', featureKey };
  });
});

const structured = computed(
  () =>
    (props.diff?.before.features?.length ?? 0) > 0 ||
    (props.diff?.after.features?.length ?? 0) > 0,
);

const CHANGE_VIEW: Readonly<
  Record<DiffRow['change'], { color: string; label: string }>
> = {
  added: { color: 'green', label: '新增' },
  changed: { color: 'blue', label: '变更' },
  removed: { color: 'red', label: '移除' },
  unchanged: { color: 'default', label: '不变' },
};

function changeTag(change: DiffRow['change']) {
  return CHANGE_VIEW[change] ?? CHANGE_VIEW.unchanged;
}

function featureText(feature: EntitlementSummaryFeature | undefined): string {
  if (!feature) {
    return '—';
  }
  const parts = [
    feature.displayName ?? feature.featureKey,
    feature.enabled ? '已启用' : '未启用',
  ];
  if (feature.quota !== null && feature.quota !== undefined) {
    parts.push(`额度 ${formatQuota(feature.quota)}`);
  }
  if (feature.termMonths !== null && feature.termMonths !== undefined) {
    parts.push(`期限 ${feature.termMonths} 个月`);
  }
  return parts.join(' · ');
}

const periodChanged = computed(() => {
  const before = props.diff?.before;
  const after = props.diff?.after;
  if (!before || !after) {
    return false;
  }
  return (
    (before.validFrom ?? '') !== (after.validFrom ?? '') ||
    (before.validTo ?? '') !== (after.validTo ?? '')
  );
});
</script>

<template>
  <div data-testid="entitlement-change-diff">
    <div v-if="!diff" class="text-sm text-muted-foreground">
      {{ emptyText ?? '暂无差异数据' }}
    </div>

    <template v-else>
      <Alert
        v-if="periodChanged"
        class="mb-2"
        :message="`生效区间：${diff.before.validFrom || '—'} ~ ${diff.before.validTo || '长期'} → ${diff.after.validFrom || '—'} ~ ${diff.after.validTo || '长期'}`"
        show-icon
        type="info"
      />

      <Table
        v-if="structured"
        :columns="columns"
        :data-source="rows"
        :pagination="false"
        :row-key="(row: DiffRow) => row.featureKey"
        :scroll="{ x: 900 }"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'change'">
            <Tag :color="changeTag(record.change).color">
              {{ changeTag(record.change).label }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'before'">
            {{ featureText(record.before) }}
          </template>
          <template v-else-if="column.key === 'after'">
            {{ featureText(record.after) }}
          </template>
        </template>
      </Table>

      <Alert
        v-else
        message="服务端返回的前后值摘要不含结构化功能键，无法逐行对比，以下为原文（不做推断）"
        show-icon
        type="warning"
      >
        <template #description>
          <pre class="mt-1 overflow-auto text-xs">{{
            JSON.stringify(diff, null, 2)
          }}</pre>
        </template>
      </Alert>
    </template>
  </div>
</template>
