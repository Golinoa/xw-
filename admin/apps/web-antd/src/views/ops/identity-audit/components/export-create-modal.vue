<script lang="ts" setup>
/**
 * 发起数据导出（契约 §5.9 `POST /exports`，高风险动作 `export.create`）。
 *
 * 三条设计决定：
 * 1. **筛选条件是 JSON**：契约要求 `filters` 与对应列表端点同构，而各列表端点的筛选
 *    参数不同（`status[]`、`customerId`、`from/to`…）。这里不做「猜一套表单」，
 *    而是让调用方写 JSON 并在本地做**语法**校验——语义合法性由服务端判定（400 拒绝非法筛选）。
 *    硬套一层表单会在后端加筛选参数时变成假选项。
 * 2. **默认导出全量**（`{}`），避免用户以为选了空条件就「没数据」。
 * 3. **原因必填**：`export.create` 是高风险动作，导出会留痕（谁、什么时候、什么条件、多少行）。
 */
import type {
  CreateExportPayload,
  IdentityErrorView,
  OpsExportType,
} from '#/api/ops/identity';

import { computed, ref, watch } from 'vue';

import { Alert, Input, Modal, Select, Tag } from 'ant-design-vue';

import { EXPORT_TYPE_OPTIONS } from '#/api/ops/identity';

defineOptions({ name: 'GovernanceExportCreateModal' });

const props = withDefaults(
  defineProps<{
    error: IdentityErrorView | null;
    open: boolean;
    submitting?: boolean;
  }>(),
  { submitting: false },
);

const emit = defineEmits<{
  cancel: [];
  submit: [payload: CreateExportPayload];
}>();

const FILTER_EXAMPLES: Record<OpsExportType, string> = {
  contracts: '{"status":["active"],"customerId":"<客户 uuid>"}',
  customers: '{"keyword":"示例"}',
  receipts: '{"status":["recorded"]}',
  receivables: '{"status":["overdue"],"dueFrom":"2026-01-01"}',
  tickets: '{"status":["new","assigned"],"priority":["high"]}',
};

const exportType = ref<OpsExportType>('receivables');
const filtersText = ref('{}');
const reason = ref('');
const localError = ref<null | string>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    exportType.value = 'receivables';
    filtersText.value = '{}';
    reason.value = '';
    localError.value = null;
  },
);

const filterPlaceholder = computed(() => FILTER_EXAMPLES[exportType.value]);

const parsedFilters = computed<null | Record<string, unknown>>(() => {
  const text = filtersText.value.trim();
  if (text === '') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
});

const filterPreview = computed(() => {
  const parsed = parsedFilters.value;
  if (parsed === null) {
    return 'JSON 语法错误';
  }
  const keys = Object.keys(parsed);
  return keys.length === 0
    ? '无筛选条件（导出全量）'
    : `筛选键：${keys.join('、')}`;
});

function onOk() {
  if (props.submitting) {
    return;
  }
  if (parsedFilters.value === null) {
    localError.value = '筛选条件不是合法的 JSON 对象，请修正后再提交';
    return;
  }
  if (reason.value.trim() === '') {
    localError.value = '请填写导出原因（会写入审计，含筛选条件与行数）';
    return;
  }
  localError.value = null;
  emit('submit', {
    exportType: exportType.value,
    filters: parsedFilters.value,
    reason: reason.value.trim(),
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
    ok-text="提交导出任务"
    :open="open"
    title="发起数据导出"
    :width="620"
    destroy-on-close
    @cancel="onCancel"
    @ok="onOk"
  >
    <div class="space-y-4">
      <Alert
        message="导出是异步任务：提交后状态为「排队中」，完成后才能下载，下载链接 5 分钟内有效。"
        show-icon
        type="info"
      />

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">导出对象</span>
          <Tag color="orange">必填</Tag>
        </div>
        <Select
          v-model:value="exportType"
          class="w-full"
          :options="EXPORT_TYPE_OPTIONS"
        />
      </div>

      <div>
        <div class="mb-1 text-sm text-foreground">筛选条件（JSON，可留空）</div>
        <Input.TextArea
          v-model:value="filtersText"
          :rows="3"
          :placeholder="filterPlaceholder"
          class="font-mono text-xs"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          键需与对应列表端点一致（如
          <code>status</code>、<code>customerId</code>）。 本页只校验 JSON
          语法，语义由服务端判定——非法筛选会返回 400。
        </p>
        <p
          class="mt-1 text-xs"
          :class="
            parsedFilters === null ? 'text-red-600' : 'text-muted-foreground'
          "
        >
          {{ filterPreview }}
        </p>
      </div>

      <div>
        <div class="mb-1 flex items-center gap-2">
          <span class="text-sm text-foreground">导出原因</span>
          <Tag color="red">高风险动作</Tag>
        </div>
        <Input.TextArea
          v-model:value="reason"
          :maxlength="200"
          :rows="2"
          placeholder="例如：月度对账需要，导出逾期应收明细"
        />
        <p class="mt-1 text-xs text-muted-foreground">
          审计会记录导出者、筛选条件、时间与行数（PRD §6.10）。
        </p>
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
