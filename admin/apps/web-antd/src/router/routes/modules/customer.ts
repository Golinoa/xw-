import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/**
 * 软件客户与联系人（域：customer）。`meta.authority` 只写动作码。
 *
 * 详情/子页为 `hideInMenu`，用 `activePath` 保持左侧菜单高亮在「客户列表」。
 * 标题文案在本文件内直写中文：locale 包（`locales/langs/*`）不在本任务可写范围，
 * 待壳层负责人补 key 后再迁移到 `$t()`。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.CUSTOMER_READ],
      icon: 'lucide:building-2',
      order: 2,
      title: $t('ops-shell.nav.customer'),
    },
    name: 'Customer',
    path: '/customers',
    children: [
      {
        component: () => import('#/views/ops/customer/list.vue'),
        meta: {
          authority: [OPS_PERMISSION.CUSTOMER_READ],
          icon: 'lucide:contact-round',
          order: 1,
          title: $t('ops-shell.menu.customerList'),
        },
        name: 'CustomerList',
        path: '/customers/list',
      },
      {
        component: () => import('#/views/ops/customer/detail.vue'),
        meta: {
          activePath: '/customers/list',
          authority: [OPS_PERMISSION.CUSTOMER_READ],
          hideInMenu: true,
          title: '客户详情',
        },
        name: 'CustomerDetail',
        path: '/customers/detail/:customerId',
      },
    ],
  },
];

export default routes;
