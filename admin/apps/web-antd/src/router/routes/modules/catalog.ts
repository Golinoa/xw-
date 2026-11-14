import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/**
 * 产品与套餐（域：catalog）。`meta.authority` 只写动作码。
 *
 * 详情/功能键子页为 `hideInMenu`，用 `activePath` 保持菜单高亮。
 * 标题文案直写中文的原因见 `customer.ts` 顶部注释（locale 包不在本任务可写范围）。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.CATALOG_READ],
      icon: 'lucide:package',
      order: 3,
      title: $t('ops-shell.nav.catalog'),
    },
    name: 'Catalog',
    path: '/catalog',
    children: [
      {
        component: () => import('#/views/ops/catalog/products.vue'),
        meta: {
          authority: [OPS_PERMISSION.CATALOG_READ],
          icon: 'lucide:boxes',
          order: 1,
          title: $t('ops-shell.menu.catalogProducts'),
        },
        name: 'CatalogProducts',
        path: '/catalog/products',
      },
      {
        component: () => import('#/views/ops/catalog/plans.vue'),
        meta: {
          authority: [OPS_PERMISSION.CATALOG_READ],
          icon: 'lucide:tags',
          order: 2,
          title: $t('ops-shell.menu.catalogPlans'),
        },
        name: 'CatalogPlans',
        path: '/catalog/plans',
      },
      {
        component: () => import('#/views/ops/catalog/plan-detail.vue'),
        meta: {
          activePath: '/catalog/plans',
          authority: [OPS_PERMISSION.CATALOG_READ],
          hideInMenu: true,
          title: '套餐详情',
        },
        name: 'CatalogPlanDetail',
        path: '/catalog/plans/:packageId',
      },
      {
        component: () => import('#/views/ops/catalog/features.vue'),
        meta: {
          authority: [OPS_PERMISSION.CATALOG_READ],
          icon: 'lucide:list-checks',
          order: 3,
          title: '功能键目录',
        },
        name: 'CatalogFeatures',
        path: '/catalog/features',
      },
    ],
  },
];

export default routes;
