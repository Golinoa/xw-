<script lang="ts" setup>
import { Alert } from 'ant-design-vue';

defineOptions({ name: 'OpsBillingDevDataNotice' });

/**
 * 开发态数据提示。
 *
 * 只在 `VITE_OPS_MOCK=true` 时出现，措辞明确「虚构、未集成、不可对账」，
 * 避免把桩数据误当成真实账款。文案写死在本组件，不在生产包里打包 fixtures。
 */
const visible = import.meta.env.VITE_OPS_MOCK === 'true';
</script>

<template>
  <Alert
    v-if="visible"
    class="mb-3"
    data-testid="billing-dev-notice"
    message="开发态数据（全部为虚构客户与虚构金额，未经真实后端集成，不可用于对账或决策）"
    show-icon
    type="warning"
  />
</template>
