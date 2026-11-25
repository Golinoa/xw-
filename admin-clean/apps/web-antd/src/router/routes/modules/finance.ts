import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 财务域：资金账户、收付款、审批申请、结算均已迁移为真实页面。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:wallet',
      order: 4,
      title: $t('shell.nav.finance'),
    },
    name: 'Finance',
    path: '/finance',
    children: [
      {
        component: () => import('#/views/finance/receipts/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:receipt',
          order: 1,
          title: $t('shell.menu.finance'),
        },
        name: 'FinanceReceipts',
        path: '/finance/receipts',
      },
      {
        component: () => import('#/views/finance/balances/index.vue'),
        meta: { icon: 'lucide:banknote', order: 2, title: $t('shell.menu.balances') },
        name: 'FinanceBalances',
        path: '/finance/balances',
      },
      {
        component: () => import('#/views/finance/applications/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:clipboard-check',
          order: 3,
          title: $t('shell.menu.financeApplications'),
        },
        name: 'FinanceApplications',
        path: '/finance/applications',
      },
      {
        component: () => import('#/views/finance/settlements/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:scale',
          order: 4,
          title: $t('shell.menu.settlements'),
        },
        name: 'FinanceSettlements',
        path: '/finance/settlements',
      },
    ],
  },
];

export default routes;
