import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 工作台：当前公司/角色/账号 + 管理员可见的成员管理。 */
const routes: RouteRecordRaw[] = [
  {
    component: () => import('#/views/workbench/index.vue'),
    meta: {
      hideInMenu: false,
      icon: 'lucide:layout-dashboard',
      order: 1,
      title: $t('shell.menu.workbench'),
    },
    name: 'Workbench',
    path: '/workbench',
  },
];

export default routes;
