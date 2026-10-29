import type { Router } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';
import { startProgress, stopProgress } from '@vben/utils';

import { accessRoutes, coreRouteNames } from '#/router/routes';
import { useAuthStore } from '#/store';

import { generateAccess } from './access';

/**
 * 解析当前账号的权限动作码。
 *
 * 优先取 `useAccessStore().accessCodes`（登录时由 `/me` 或 `/auth/codes` 写入，
 * 也是 `v-access:code` 与 `useAccess().hasAccessByCodes` 的数据源），
 * 其次回退到 `userInfo.accessCodes`（同一份授权的另一种投递方式）。
 *
 * 注意：**绝不读取 `userInfo.roles`**。角色只用于后台配置与审计展示，
 * 不参与前端呈现判断（PRD §4.2）。
 */
function resolveAccessCodes(
  storeCodes: readonly string[] | undefined,
  userInfo: unknown,
): string[] {
  if (storeCodes && storeCodes.length > 0) {
    return [...storeCodes];
  }

  const codes = (userInfo as null | { accessCodes?: unknown })?.accessCodes;
  if (!Array.isArray(codes)) {
    return [];
  }

  return codes.filter((code): code is string => typeof code === 'string');
}

/**
 * 通用守卫配置
 * @param router
 */
function setupCommonGuard(router: Router) {
  // 记录已经加载的页面
  const loadedPaths = new Set<string>();

  router.beforeEach((to) => {
    to.meta.loaded = loadedPaths.has(to.path);

    // 页面加载进度条
    if (!to.meta.loaded && preferences.transition.progress) {
      startProgress();
    }
    return true;
  });

  router.afterEach((to) => {
    // 记录页面是否加载,如果已经加载，后续的页面切换动画等效果不在重复执行

    loadedPaths.add(to.path);

    // 关闭页面加载进度条
    if (preferences.transition.progress) {
      stopProgress();
    }
  });
}

/**
 * 权限访问守卫配置
 *
 * 呈现口径：
 * - 无权限的动作路由在 `generateAccess` 阶段被整棵剔除，不会注册到 router，
 *   直接输入 URL 会命中 `FallbackNotFound`（404 文案含「不存在或不具备访问权限」）。
 * - 这是体验层保护，不是安全边界；服务端必须按动作码再次拒绝。
 * - 登录成功但权限集合为空时，本守卫仍会「放行」到 homePath 并落到 404；
 *   「无运营权限 / 账号停用」的判定与提示由登录流程（store 侧）负责，避免重复实现。
 */
function setupAccessGuard(router: Router) {
  router.beforeEach(async (to, from) => {
    const accessStore = useAccessStore();
    const userStore = useUserStore();
    const authStore = useAuthStore();

    // 基本路由，这些路由不需要进入权限拦截
    if (coreRouteNames.includes(to.name as string)) {
      if (to.path === LOGIN_PATH && accessStore.accessToken) {
        return decodeURIComponent(
          (to.query?.redirect as string) ||
            userStore.userInfo?.homePath ||
            preferences.app.defaultHomePath,
        );
      }
      return true;
    }

    // accessToken 检查
    if (!accessStore.accessToken) {
      // 明确声明忽略权限访问权限，则可以访问
      if (to.meta.ignoreAccess) {
        return true;
      }

      // 没有访问权限，跳转登录页面
      if (to.fullPath !== LOGIN_PATH) {
        return {
          path: LOGIN_PATH,
          // 如不需要，直接删除 query
          query:
            to.fullPath === preferences.app.defaultHomePath
              ? {}
              : { redirect: encodeURIComponent(to.fullPath) },
          // 携带当前跳转的页面，登录后重新跳转该页面
          replace: true,
        };
      }
      return to;
    }

    // 是否已经生成过动态路由
    if (accessStore.isAccessChecked) {
      return true;
    }

    // 生成路由表
    const userInfo = userStore.userInfo || (await authStore.fetchUserInfo());
    // 关键改造：由 roles 改为动作码集合（原实现传 userInfo.roles，导致动作码永不命中）
    const accessCodes = resolveAccessCodes(accessStore.accessCodes, userInfo);

    // 回填，保证按钮级 `v-access:code` 与路由使用同一份授权
    if (accessStore.accessCodes.length === 0 && accessCodes.length > 0) {
      accessStore.setAccessCodes(accessCodes);
    }

    // 生成菜单和路由
    const { accessibleMenus, accessibleRoutes } = await generateAccess({
      accessCodes,
      router,
      routes: accessRoutes,
    });

    // 保存菜单信息和路由信息
    accessStore.setAccessMenus(accessibleMenus);
    accessStore.setAccessRoutes(accessibleRoutes);
    accessStore.setIsAccessChecked(true);
    const redirectPath = (from.query.redirect ??
      (to.path === preferences.app.defaultHomePath
        ? userInfo.homePath || preferences.app.defaultHomePath
        : to.fullPath)) as string;

    return {
      ...router.resolve(decodeURIComponent(redirectPath)),
      replace: true,
    };
  });
}

/**
 * 项目守卫配置
 * @param router
 */
function createRouterGuard(router: Router) {
  /** 通用 */
  setupCommonGuard(router);
  /** 权限访问 */
  setupAccessGuard(router);
}

export { createRouterGuard, resolveAccessCodes };
