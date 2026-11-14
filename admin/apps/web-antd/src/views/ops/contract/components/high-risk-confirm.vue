<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

/**
 * 高风险动作二次确认弹窗（`contract.approve` 等 `is_high_risk=true` 的动作）。
 *
 * 硬约束（PRD §1.3、§4.3；契约 §4 高风险动作说明）：
 * 1. **不能** 一次点击直接生效：必须先在弹窗里确认影响摘要；
 * 2. 必须填写原因（写入审计，后端也会校验 `reason`）；
 * 3. 未确认时**不发请求**——校验在组件内部完成，只有通过后才 `emit('confirm')`。
 */
import { Alert, Button, Checkbox, Input, Modal, Tag } from 'ant-design-vue';

defineOptions({ name: 'ContractHighRiskConfirm' });

const props = withDefaults(
  defineProps<{
    /** 动作说明，例如「确认生效」 */
    actionLabel: string;
    danger?: boolean;
    /** 服务端返回的可读错误（409/403 等），失败时弹窗不关闭 */
    errorMessage?: null | string;
    hint?: string;
    /** 影响摘要（只读展示，来自已加载的详情数据） */
    impactItems?: { label: string; value: string }[];
    okText?: string;
    open: boolean;
    /** 所需动作码，例如 contract.approve */
    permissionLabel: string;
    /** 高风险动作必须填原因；中风险动作（提交/撤回）可为选填 */
    reasonRequired?: boolean;
    submitting?: boolean;
    title: string;
  }>(),
  {
    danger: true,
    errorMessage: null,
    hint: '',
    impactItems: () => [],
    okText: '确认执行',
    reasonRequired: true,
    submitting: false,
  },
);

const emit = defineEmits<{
  cancel: [];
  confirm: [reason: string];
}>();

const reason = ref('');
const acknowledged = ref(false);
const localError = ref('');

const displayError = computed(
  () => localError.value || props.errorMessage || '',
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      reason.value = '';
      acknowledged.value = false;
      localError.value = '';
    }
  },
);

function handleConfirm() {
  localError.value = '';
  if (props.reasonRequired && reason.value.trim() === '') {
    localError.value = '请填写操作原因（将写入审计事件）';
    return;
  }
  if (!acknowledged.value) {
    localError.value = '请先确认已阅读影响摘要';
    return;
  }
  emit('confirm', reason.value.trim());
}

function handleCancel() {
  emit('cancel');
}
</script>

<template>
  <Modal
    :open="props.open"
    :title="props.title"
    :confirm-loading="props.submitting"
    :mask-closable="!props.submitting"
    destroy-on-close
    @cancel="handleCancel"
  >
    <Alert
      class="mb-3"
      type="warning"
      show-icon
      message="高风险动作"
      :description="
        props.hint || '该动作会改变合同的法律状态并写入审计，请确认影响后执行。'
      "
    />

    <div
      class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>所需权限：</span>
      <Tag color="processing">{{ props.permissionLabel }}</Tag>
      <span>动作：</span>
      <Tag color="red">{{ props.actionLabel }}</Tag>
    </div>

    <div v-if="props.impactItems.length > 0" class="mb-3 rounded border p-3">
      <p class="mb-2 text-sm font-medium">影响摘要（只读）</p>
      <dl class="grid grid-cols-2 gap-2 text-sm">
        <template v-for="item in props.impactItems" :key="item.label">
          <dt class="text-muted-foreground">{{ item.label }}</dt>
          <dd class="font-medium">{{ item.value }}</dd>
        </template>
      </dl>
    </div>

    <!-- 额外字段（如签署日/生效日），由调用方注入 -->
    <slot></slot>

    <Alert
      v-if="displayError"
      class="mb-3 mt-3"
      type="error"
      show-icon
      :message="displayError"
      data-testid="hrc-error"
    />

    <label class="mb-1 block text-sm" for="hrc-reason">
      操作原因{{ props.reasonRequired ? '（必填）' : '（选填）' }}
    </label>
    <Input.TextArea
      id="hrc-reason"
      v-model:value="reason"
      data-testid="hrc-reason"
      :maxlength="200"
      :rows="3"
      placeholder="说明本次操作的业务原因，便于审计追溯"
    />

    <Checkbox v-model:checked="acknowledged" class="mt-3" data-testid="hrc-ack">
      我已确认上述影响摘要，理解该操作不可静默撤回
    </Checkbox>

    <template #footer>
      <Button :disabled="props.submitting" @click="handleCancel">取消</Button>
      <Button
        :danger="props.danger"
        :loading="props.submitting"
        data-testid="hrc-confirm"
        type="primary"
        @click="handleConfirm"
      >
        {{ props.okText }}
      </Button>
    </template>
  </Modal>
</template>
