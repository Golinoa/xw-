<script lang="ts" setup>
/**
 * 审计事件详情抽屉。
 *
 * 审计是**只读事实**：这里没有任何编辑入口，`beforeSummary` / `afterSummary`
 * 原样展示（形状随实体变化，契约 §5.9 没有统一 schema）。
 *
 * 两个刻意的呈现选择：
 * 1. 用 `<pre>` 展示原始 JSON 而不是自造表格：契约没定义摘要的字段集，
 *    硬套一层「变更前/变更后」字段映射会在后端换形状时静默丢字段。
 * 2. `requestId` 单独给「可复制」入口：它是与前端的错误提示、后端日志对账的唯一线索。
 */
import type { OpsAuditEvent } from '#/api/ops/identity';

import { computed } from 'vue';

import { Descriptions, Drawer, Empty, Tag } from 'ant-design-vue';

import {
  auditActionLabel,
  formatDateTime,
  isKnownAuditAction,
} from '#/api/ops/identity';

defineOptions({ name: 'GovernanceAuditDetailDrawer' });

const props = withDefaults(
  defineProps<{ event?: null | OpsAuditEvent; open: boolean }>(),
  { event: null },
);

const emit = defineEmits<{ close: [] }>();

function stringify(value: null | Record<string, unknown>): string {
  if (!value) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '（摘要无法序列化）';
  }
}

const beforeText = computed(() =>
  stringify(props.event?.beforeSummary ?? null),
);
const afterText = computed(() => stringify(props.event?.afterSummary ?? null));

const actionKnown = computed(() =>
  props.event ? isKnownAuditAction(props.event.action) : true,
);
</script>

<template>
  <Drawer
    :open="open"
    placement="right"
    title="审计事件详情"
    :width="640"
    @close="emit('close')"
  >
    <template v-if="event">
      <Descriptions bordered size="small" :column="1">
        <Descriptions.Item label="动作">
          <span class="font-medium">{{ auditActionLabel(event.action) }}</span>
          <span class="ml-2 font-mono text-xs text-muted-foreground">
            {{ event.action }}
          </span>
          <Tag v-if="!actionKnown" class="ml-2" color="orange">
            未登记动作（原样显示）
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="时间">
          {{ formatDateTime(event.createdAt) }}
          <span class="ml-2 text-xs text-muted-foreground">
            {{ event.createdAt }}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="操作者">
          {{ event.actor.displayName }}
          <span class="ml-2 font-mono text-xs text-muted-foreground">
            {{ event.actor.id }}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="对象">
          {{ event.entityType }}
          <span class="ml-2 font-mono text-xs text-muted-foreground">
            {{ event.entityId || '—' }}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="原因">
          {{ event.reason || '未填写' }}
        </Descriptions.Item>
        <Descriptions.Item label="请求 ID">
          <span class="font-mono text-xs">{{ event.requestId || '—' }}</span>
          <span class="ml-2 text-xs text-muted-foreground">
            可与后端日志、前端错误提示对账
          </span>
        </Descriptions.Item>
      </Descriptions>

      <div class="mt-5">
        <p class="mb-2 text-sm font-medium text-foreground">变更前</p>
        <Empty
          v-if="!event.beforeSummary"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
          description="无变更前摘要（新增类操作）"
        />
        <pre
          v-else
          class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs"
          >{{ beforeText }}</pre
        >
      </div>

      <div class="mt-5">
        <p class="mb-2 text-sm font-medium text-foreground">变更后</p>
        <Empty
          v-if="!event.afterSummary"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
          description="无变更后摘要（删除类操作或服务端未提供）"
        />
        <pre
          v-else
          class="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs"
          >{{ afterText }}</pre
        >
      </div>

      <p class="mt-5 text-xs text-muted-foreground">
        审计记录仅追加、不可修改或删除；本抽屉不提供任何编辑入口。
      </p>
    </template>
  </Drawer>
</template>
