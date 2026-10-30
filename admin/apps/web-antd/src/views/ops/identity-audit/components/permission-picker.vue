<script lang="ts" setup>
/**
 * 权限动作码选择器（角色编辑用）。
 *
 * 目录来自 `GET /permissions`（真源为契约 §4），按 `domain` 分组展示。
 * 三条设计决定：
 * 1. **不校验组合合法性**：哪些码能共存是后端与审计的职责，前端只如实展示与提交。
 * 2. **高风险动作有视觉标记**：`isHighRisk` 为真时加红色标签，避免管理员顺手勾上
 *    `contract.approve` 这类需要二次确认的动作。
 * 3. **只读模式**：无 `role.manage` 时禁用勾选但保留展示，让只读账号能看到现有配置。
 */
import type { OpsPermissionItem } from '#/api/ops/identity';

import { computed } from 'vue';

import { Checkbox, Tag } from 'ant-design-vue';

import { groupPermissions } from '../governance';

defineOptions({ name: 'GovernancePermissionPicker' });

const props = withDefaults(
  defineProps<{
    catalog: OpsPermissionItem[];
    disabled?: boolean;
    modelValue: string[];
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const groups = computed(() => groupPermissions(props.catalog));

const selected = computed(() => new Set(props.modelValue));

function toggle(code: string, checked: boolean) {
  if (props.disabled) {
    return;
  }
  const next = new Set(props.modelValue);
  if (checked) {
    next.add(code);
  } else {
    next.delete(code);
  }
  // 排序后回传，保证同一组勾选产生同样的数组——便于在审计里对比两次提交的差异。
  emit('update:modelValue', [...next].toSorted());
}

function toggleDomain(codes: string[], checked: boolean) {
  if (props.disabled) {
    return;
  }
  const next = new Set(props.modelValue);
  for (const code of codes) {
    if (checked) {
      next.add(code);
    } else {
      next.delete(code);
    }
  }
  emit('update:modelValue', [...next].toSorted());
}

function domainState(codes: string[]): {
  all: boolean;
  some: boolean;
} {
  const picked = codes.filter((code) => selected.value.has(code)).length;
  return { all: picked === codes.length && codes.length > 0, some: picked > 0 };
}
</script>

<template>
  <div class="space-y-3">
    <div
      v-for="group in groups"
      :key="group.domain"
      class="rounded-md border border-border p-3"
    >
      <div class="mb-2 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-muted-foreground">
            {{ group.domain }}
          </span>
          <span class="text-xs text-muted-foreground">
            {{ group.items.length }} 项
          </span>
        </div>
        <Checkbox
          :checked="domainState(group.items.map((item) => item.code)).all"
          :disabled="disabled"
          :indeterminate="
            domainState(group.items.map((item) => item.code)).some
          "
          @change="
            (event) =>
              toggleDomain(
                group.items.map((item) => item.code),
                Boolean(event.target.checked),
              )
          "
        >
          全选
        </Checkbox>
      </div>

      <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Checkbox
          v-for="item in group.items"
          :key="item.code"
          :checked="selected.has(item.code)"
          :disabled="disabled"
          @change="(event) => toggle(item.code, Boolean(event.target.checked))"
        >
          <span class="font-mono text-xs">{{ item.code }}</span>
          <Tag v-if="item.isHighRisk" class="ml-2" color="red">高风险</Tag>
          <span class="ml-2 text-xs text-muted-foreground">
            {{ item.description }}
          </span>
        </Checkbox>
      </div>
    </div>

    <p v-if="groups.length === 0" class="text-sm text-muted-foreground">
      未取到权限目录（`GET /permissions` 需要
      operator.read），暂时无法配置权限。
    </p>
  </div>
</template>
