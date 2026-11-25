import type { Router, RouteRecordRaw } from 'vue-router';

import type {
  ComponentRecordType,
  GenerateMenuAndRoutesOptions,
} from '@vben/types';

import { generateAccessible } from '@vben/access';
import { preferences } from '@vben/preferences';
import { resetStaticRoutes } from '@vben/utils';

import { BasicLayout, IFrameView } from '#/layouts';

/**
 * 权限驱动呈现的入口。
 *
 * 语义约定（与 `src/constants/permissions.ts` 配套）：
 * 1. 传入的是**权限动作码**（如 `contract.approve`），不是角色名；
 * 2. `meta.authority` 为 OR 语义，具备任一动作即可进入该路由；
 * 3. 无权路由不会生成 → 直接输入 URL 落到 `FallbackNotFound`（文案含「不存在或不具备访问权限」）；
 * 4. 菜单隐藏只改善体验，真实授权由服务端按动作码拒绝。
 *
 * 上游 `GenerateMenuAndRoutesOptions` 把该字段命名为 `roles`（历史命名）。
 * 这里用显式的 `accessCodes` 作为入参，避免调用方误传角色名。
 */
type GenerateOpsAccessOptions = {
  /** 当前账号已授予的权限动作码（来自 `useAccessStore().accessCodes`）。 */
  accessCodes: readonly string[];
} & Omit<GenerateMenuAndRoutesOptions, 'roles'>;

/**
 * 需要「菜单可见、点击进 403」的模块可在路由上声明：
 * `meta: { menuVisibleWithForbidden: true }`。
 * 本阶段默认全部走 404 口径，该能力保留但未启用。
 */
const forbiddenComponent = () => import('#/views/_core/fallback/forbidden.vue');

async function generateAccess(options: GenerateOpsAccessOptions) {
  const pageMap: ComponentRecordType = import.meta.glob('../views/**/*.vue');

  const layoutMap: ComponentRecordType = {
    BasicLayout,
    IFrameView,
  };

  const { accessCodes, ...rest } = options;

  return await generateAccessible(preferences.app.accessMode, {
    ...rest,
    // 上游字段名固定为 roles；本项目只允许把它当作动作码集合使用。
    roles: [...accessCodes],
    // 可以指定没有权限跳转403页面（仅在声明 menuVisibleWithForbidden 时生效）
    forbiddenComponent,
    // 如果 route.meta.menuVisibleWithForbidden = true
    layoutMap,
    pageMap,
  });
}

export { generateAccess };
export type { GenerateOpsAccessOptions };

/**
 * 登出 / 换账号时清理动态路由。
 *
 * 上游 `resetStaticRoutes` 只清理 matcher，但 `generateAccessible` 会把动态路由
 * 直接 push 进 `Root` 记录对象的 `children` 数组；该数组在 removeRoute 之后仍然保留。
 * 结果是下一次登录时 `names.includes(route.name)` 命中「按 name 更新」分支，
 * 上一账号的路由被复活（跨账号呈现泄漏）。
 *
 * 因此在静态路由清理后，把 `Root` 换成 children 为空的干净容器。
 * 语义等价于「重新挂载布局容器」，不触碰 core 路由（登录页、403、404）。
 */
function resetAccessRoutes(router: Router, staticRoutes: RouteRecordRaw[]) {
  resetStaticRoutes(router, staticRoutes);

  const root = staticRoutes.find((route) => route.name === 'Root');
  if (!root || !root.name) {
    return;
  }

  if (router.hasRoute(root.name)) {
    router.removeRoute(root.name);
  }

  router.addRoute({ ...root, children: [] });
}

export { resetAccessRoutes };
