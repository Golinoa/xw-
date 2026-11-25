import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 配置域：公司信息与审批流配置。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:settings',
      order: 6,
      title: $t('shell.nav.config'),
    },
    name: 'Config',
    path: '/config',
    children: [
      {
        component: () => import('#/views/config/company/index.vue'),
        meta: { icon: 'lucide:building-2', order: 1, title: $t('shell.menu.companySettings') },
        name: 'ConfigCompany',
        path: '/config/company',
      },
    ],
  },
];

export default routes;
