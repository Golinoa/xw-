import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 交易域：供应商、线路、订单、游客名单均已迁移为真实页面。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:briefcase',
      order: 2,
      title: $t('shell.nav.trade'),
    },
    name: 'Trade',
    path: '/trade',
    children: [
      {
        component: () => import('#/views/trade/order/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:file-text',
          order: 1,
          title: $t('shell.menu.orders'),
        },
        name: 'TradeOrders',
        path: '/trade/orders',
      },
      {
        component: () => import('#/views/trade/tourists/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:users',
          order: 2,
          title: $t('shell.menu.tourists'),
        },
        name: 'TradeTourists',
        path: '/trade/tourists',
      },
      {
        component: () => import('#/views/trade/suppliers/index.vue'),
        meta: { icon: 'lucide:truck', order: 3, title: $t('shell.menu.suppliers') },
        name: 'TradeSuppliers',
        path: '/trade/suppliers',
      },
      {
        component: () => import('#/views/trade/routes/index.vue'),
        meta: { icon: 'lucide:map', order: 4, title: $t('shell.menu.tourRoutes') },
        name: 'TradeRoutes',
        path: '/trade/routes',
      },
    ],
  },
];

export default routes;
