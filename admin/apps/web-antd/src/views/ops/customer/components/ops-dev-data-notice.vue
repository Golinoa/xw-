<script lang="ts" setup>
/**
 * 「开发态数据」提示条。
 *
 * 为什么放在 customer 域目录：`views/ops/_shared/` 由壳层负责人维护，不在本任务
 * 可写范围；本组件被 customer / catalog / contract 三个域共用，后续可迁入 `_shared`。
 *
 * 原则：只要 `VITE_OPS_MOCK=true`（数据来自 `api/ops/<domain>/mock.ts` 的虚构样例），
 * 页面就**必须**出现该提示，绝不冒充真实集成。
 */
import { Alert } from 'ant-design-vue';

defineOptions({ name: 'OpsDevDataNotice' });

const mockEnabled = import.meta.env.VITE_OPS_MOCK === 'true';
</script>

<template>
  <Alert
    v-if="mockEnabled"
    class="mb-4"
    type="warning"
    show-icon
    message="开发态数据（VITE_OPS_MOCK=true）"
    description="本页内容为前端虚构样例（api/ops 域 fixtures），后端 ops API 尚未接入，不代表真实业务数据，也不能作为集成验收依据。"
  />
</template>
