/**
 * 当前运营操作人（申请人/审批人判定用）。
 *
 * 说明（与 journal 记录一致）：`useAuthStore()` 不直接暴露 `userInfo`，用户信息落在
 * `useUserStore().userInfo`，由 `authStore.fetchUserInfo()` 从 `GET /session` 回填；
 * 其中 `userId === operator.id`（见 `api/core/user.ts` 的 `toOpsUserInfo`）。
 * 因此这里读取 `useUserStore`，与 billing 域详情抽屉的取法一致，避免两套身份口径。
 */
import { computed } from 'vue';

import { useUserStore } from '@vben/stores';

export function useCurrentOperator() {
  const userStore = useUserStore();

  const currentOperatorId = computed<null | string>(
    () => userStore.userInfo?.userId ?? null,
  );
  const currentOperatorName = computed<string>(
    () => userStore.userInfo?.realName ?? '',
  );

  return { currentOperatorId, currentOperatorName };
}
