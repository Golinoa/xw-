<script lang="ts" setup>
import type { Ticket } from '#/api/ops/support/types';

import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

import { formatDateTime, ticketOverdueView } from '#/api/ops/support/format';

defineOptions({ name: 'SupportTicketOverdueBadge' });

/**
 * 逾期徽标（列表与详情共用）。
 *
 * **只读服务端字段 `isOverdue`**，不接收「当前时间」参数，也不在这里比较 `dueAt`
 * ——把「不能自算」这件事做成组件签名层面的约束（源码参考门 §4.2）。
 * 服务端没下发该字段时显示「逾期标识未返回」，而不是猜一个结果。
 *
 * 接收整条工单（而不是拆成 `boolean` prop）是有意的：Vue 会把缺省的 `Boolean` prop
 * 强制转成 `false`，那样「字段缺失」与「未逾期」就分不开了，恰好会掩盖契约缺字段。
 */
const props = withDefaults(
  defineProps<{
    /** 是否同时展示到期时间（列表里时间与徽标同格显示）。 */
    showDueAt?: boolean;
    ticket: Pick<Ticket, 'dueAt' | 'isOverdue'>;
  }>(),
  { showDueAt: false },
);

const view = computed(() => ticketOverdueView(props.ticket));
</script>

<template>
  <div data-testid="ticket-overdue">
    <div v-if="showDueAt" class="text-xs text-muted-foreground">
      {{ formatDateTime(ticket.dueAt) }}
    </div>
    <Tag
      v-if="view.known && view.overdue"
      color="red"
      data-testid="ticket-overdue-badge"
    >
      已逾期
    </Tag>
    <span
      v-else-if="view.known"
      class="text-xs text-muted-foreground"
      data-testid="ticket-not-overdue"
    >
      未逾期
    </span>
    <span
      v-else
      class="text-xs text-muted-foreground"
      data-testid="ticket-overdue-unknown"
    >
      逾期标识未返回
    </span>
  </div>
</template>
