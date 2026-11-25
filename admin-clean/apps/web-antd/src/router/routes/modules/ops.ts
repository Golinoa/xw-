import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * 运营域：报表、审计、通知。三页均已在阶段 3 迁移完成。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:activity',
      order: 5,
      title: $t('shell.nav.ops'),
    },
    name: 'Operations',
    path: '/operations',
    children: [
      {
        component: () => import('#/views/operations/reports/index.vue'),
        meta: { icon: 'lucide:bar-chart-3', order: 1, title: $t('shell.menu.reports') },
        name: 'OpsReports',
        path: '/operations/reports',
      },
      {
        component: () => import('#/views/operations/audit/index.vue'),
        meta: { icon: 'lucide:scroll-text', order: 2, title: $t('shell.menu.audit') },
        name: 'OpsAudit',
        path: '/operations/audit',
      },
      {
        component: () => import('#/views/operations/notifications/index.vue'),
        meta: { icon: 'lucide:bell', order: 3, title: $t('shell.menu.notifications') },
        name: 'OpsNotifications',
        path: '/operations/notifications',
      },
    ],
  },
];

export default routes;
