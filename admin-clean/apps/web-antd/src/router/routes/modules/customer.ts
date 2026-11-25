import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 客户域：来源、客户、回收站、CRM 线索均已迁移为真实页面。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:contact',
      order: 3,
      title: $t('shell.nav.customer'),
    },
    name: 'Customer',
    path: '/customer',
    children: [
      {
        component: () => import('#/views/customer/list/index.vue'),
        meta: {
          // 客户列表把筛选、排序、页码写进查询串（可分享、可刷新还原）。
          // 页签按 path 去重，否则每翻一页都会多开一个页签。
          fullPathKey: false,
          icon: 'lucide:users-round',
          order: 1,
          title: $t('shell.menu.customers'),
        },
        name: 'CustomerList',
        path: '/customer/list',
      },
      {
        component: () => import('#/views/customer/recycle/index.vue'),
        meta: { icon: 'lucide:trash-2', order: 2, title: $t('shell.menu.customerRecycle') },
        name: 'CustomerRecycle',
        path: '/customer/recycle',
      },
      {
        component: () => import('#/views/customer/sources/index.vue'),
        meta: { icon: 'lucide:share-2', order: 3, title: $t('shell.menu.customerSources') },
        name: 'CustomerSources',
        path: '/customer/sources',
      },
      {
        component: () => import('#/views/crm/leads/index.vue'),
        meta: {
          fullPathKey: false,
          icon: 'lucide:funnel',
          order: 4,
          title: $t('shell.menu.crmLeads'),
        },
        name: 'CrmLeads',
        path: '/customer/leads',
      },
    ],
  },
];

export default routes;
