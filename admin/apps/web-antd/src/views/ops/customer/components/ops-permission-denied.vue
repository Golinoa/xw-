<script lang="ts" setup>
/**
 * 无权限说明（不是白屏，也不是报错）。
 *
 * 三条硬约束（`admin/.harness/FRONTEND.md`）：
 * 1. 明确说明「缺哪个动作码」，便于找管理员开通；
 * 2. **不泄露数据是否存在**：不显示记录数、不显示「共 0 条」之类的探测信息；
 * 3. 不提供重试按钮——重试不会改变授权结果，只会误导用户。
 */
import { Card, Result, Tag } from 'ant-design-vue';

defineOptions({ name: 'OpsPermissionDenied' });

withDefaults(
  defineProps<{
    /** 页面要求的动作码（契约 §4） */
    permissions?: string[];
    /** 页面名称，用于文案 */
    title?: string;
  }>(),
  {
    permissions: () => [],
    title: '该页面',
  },
);
</script>

<template>
  <Card>
    <Result
      status="403"
      title="无访问权限"
      :sub-title="`当前账号没有访问${title}的权限，如需开通请联系运营管理员。`"
    >
      <template #extra>
        <div
          v-if="permissions.length > 0"
          class="flex flex-wrap justify-center gap-2"
        >
          <span class="text-sm text-muted-foreground">所需动作码：</span>
          <Tag v-for="code in permissions" :key="code" color="processing">
            {{ code }}
          </Tag>
        </div>
      </template>
    </Result>
  </Card>
</template>
