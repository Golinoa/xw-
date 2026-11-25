import type { RouteRecordRaw } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

const BasicLayout = () => import('#/layouts/basic.vue');
const AuthPageLayout = () => import('#/layouts/auth.vue');

/**
 * 全局 404 页面。
 *
 * 口径（已采纳）：无权限路由在登录后**不生成**，直接输入 URL 会落到本兜底路由，
 * 因此 404 文案必须包含「不存在或无访问权限」，避免把资源是否存在泄露成 403。
 * 该路由不属于 `coreRoutes`，未登录访问仍会先被守卫送到登录页。
 */
const fallbackNotFoundRoute: RouteRecordRaw = {
  component: () => import('#/views/_core/fallback/not-found.vue'),
  meta: {
    hideInBreadcrumb: true,
    hideInMenu: true,
    hideInTab: true,
    title: '404',
  },
  name: 'FallbackNotFound',
  path: '/:path(.*)*',
};

/** 基本路由，这些路由是必须存在的 */
const coreRoutes: RouteRecordRaw[] = [
  /**
   * 根路由
   * 使用基础布局，作为所有页面的父级容器，子级就不必配置BasicLayout。
   * 此路由必须存在，且不应修改
   */
  {
    component: BasicLayout,
    meta: {
      hideInBreadcrumb: true,
      title: 'Root',
    },
    name: 'Root',
    path: '/',
    redirect: preferences.app.defaultHomePath,
    children: [],
  },
  {
    component: AuthPageLayout,
    meta: {
      hideInTab: true,
      title: 'Authentication',
    },
    name: 'Authentication',
    path: '/auth',
    redirect: LOGIN_PATH,
    children: [
      {
        name: 'Login',
        path: 'login',
        component: () => import('#/views/_core/authentication/login.vue'),
        meta: {
          title: $t('page.auth.login'),
        },
      },
      /**
       * 忘记密码：只发重置邮件，不发业务请求。
       *
       * 独立成页而不是塞进登录卡片，是因为 Vben 登录组件把「忘记密码」做成跳转
       * （`forgetPasswordPath`）：在卡片里再开一个模式，两套状态会互相遮挡。
       */
      {
        name: 'ForgetPassword',
        path: 'forget-password',
        component: () => import('#/views/_core/authentication/forget-password.vue'),
        meta: {
          title: $t('page.auth.forgetPassword'),
        },
      },
    ],
  },
  /**
   * 403 拒绝页。
   *
   * 本阶段无权限一律走 404（见 `fallbackNotFoundRoute` 注释），
   * 该路由用于两处：① 页面内需要「功能存在但无权限」明示的场景；
   * ② 路由声明 `meta.menuVisibleWithForbidden` 后由 `forbiddenComponent` 复用同一页面。
   */
  {
    component: () => import('#/views/_core/fallback/forbidden.vue'),
    meta: {
      hideInBreadcrumb: true,
      hideInMenu: true,
      hideInTab: true,
      ignoreAccess: true,
      title: '403',
    },
    name: 'Forbidden',
    path: '/error/403',
  },
];

export { coreRoutes, fallbackNotFoundRoute };
