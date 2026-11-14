<script lang="ts" setup>
import type { TimelineEntry } from '../timeline';

import { computed } from 'vue';

import { Empty, Tag, Timeline, TimelineItem } from 'ant-design-vue';

import { TICKET_TIMELINE_IMMUTABLE_NOTE } from '#/api/ops/support';

import { summarizeTimeline } from '../timeline';

defineOptions({ name: 'SupportTicketTimeline' });

/**
 * 工单时间线（详情页主视图）。
 *
 * 升序展示「事件类型 + 操作者 + 时间 + 原因/备注」：从上到下就是处理经过，
 * 状态类事件额外画出「旧状态 → 新状态」，一眼能看出流转路径。
 * 数据排序在 `timeline.ts` 的 `buildTicketTimeline` 里完成（纯函数、可单测）。
 */
const props = withDefaults(
  defineProps<{
    entries: TimelineEntry[];
    loading?: boolean;
  }>(),
  { loading: false },
);

const summary = computed(() => summarizeTimeline(props.entries));
</script>

<template>
  <div data-testid="ticket-timeline">
    <div
      class="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
    >
      <span>共 {{ summary.total }} 条</span>
      <span>状态变更 {{ summary.statusChanges }}</span>
      <span>分派 {{ summary.assignments }}</span>
      <span>备注 {{ summary.comments }}</span>
      <span class="text-muted-foreground/80"
        >· {{ TICKET_TIMELINE_IMMUTABLE_NOTE }}</span
      >
    </div>

    <div v-if="loading" class="py-8 text-center text-sm text-muted-foreground">
      时间线加载中…
    </div>

    <Empty
      v-else-if="entries.length === 0"
      description="还没有任何事件（新建工单至少会有一条「创建」事件，若为空请刷新）"
      :image="Empty.PRESENTED_IMAGE_SIMPLE"
    />

    <Timeline v-else class="pt-1">
      <TimelineItem
        v-for="entry in entries"
        :key="entry.id"
        :color="entry.color"
        data-testid="ticket-timeline-item"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Tag :color="entry.color" data-testid="ticket-timeline-kind">
            {{ entry.label }}
          </Tag>
          <span v-if="entry.change" class="text-sm font-medium">
            {{ entry.change }}
          </span>
          <span class="text-xs text-muted-foreground">
            {{ entry.actor }} · {{ entry.at }}
          </span>
        </div>

        <p
          v-if="entry.reason"
          class="mt-1 whitespace-pre-wrap text-sm text-foreground"
          data-testid="ticket-timeline-body"
        >
          {{ entry.reason }}
        </p>
        <p v-else class="mt-1 text-xs text-muted-foreground">
          该事件未填写原因/备注
        </p>

        <p v-if="entry.waitingOn" class="mt-1 text-xs text-orange-600">
          等待对象：{{ entry.waitingOn }}
        </p>
      </TimelineItem>
    </Timeline>
  </div>
</template>
