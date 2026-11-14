import type { OpsPermission } from '#/constants/permissions';

import { computed } from 'vue';

import { useAccessStore } from '@vben/stores';

/**
 * 动作码级权限判断（业务页复用）。
 *
 * 数据源与路由守卫、`v-access:code` 完全一致：`useAccessStore().accessCodes`。
 * 因此「路由可见」与「按钮可用」不会出现两套口径。
 *
 * 使用前提：真正的授权由服务端按动作码执行；本函数只用于呈现
 * （隐藏/禁用按钮、展示无权限说明），**不能**作为跳过请求校验的理由。
 *
 * @example
 * const { hasPermission } = useOpsPermission();
 * const canApprove = computed(() => hasPermission(OPS_PERMISSION.CONTRACT_APPROVE));
 */
export function useOpsPermission() {
  const accessStore = useAccessStore();

  const grantedCodes = computed(() => new Set<string>(accessStore.accessCodes));

  /** 是否具备某个动作码 */
  function hasPermission(code: OpsPermission): boolean {
    return grantedCodes.value.has(code);
  }

  /** 是否具备任意一个动作码（OR） */
  function hasAnyPermission(codes: readonly OpsPermission[]): boolean {
    return codes.some((code) => grantedCodes.value.has(code));
  }

  return { grantedCodes, hasAnyPermission, hasPermission };
}
