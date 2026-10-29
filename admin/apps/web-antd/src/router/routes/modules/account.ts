import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * 个人中心。
 *
 * 无 `meta.authority`：任何已登录的运营账号都可访问自己的账号页。
 * 页面内可执行的动作（改密码等）由服务端再次校验。
 */
const routes: RouteRecordRaw[] = [
  {
    component: () => import('#/views/_core/profile/index.vue'),
    meta: {
      hideInMenu: true,
      hideInTab: true,
      icon: 'lucide:user',
      title: $t('page.auth.profile'),
    },
    name: 'Profile',
    path: '/profile',
  },
];

export default routes;
