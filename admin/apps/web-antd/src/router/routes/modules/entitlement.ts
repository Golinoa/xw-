import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/** 订阅与授权（域：entitlement）。`meta.authority` 只写动作码。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.ENTITLEMENT_READ],
      icon: 'lucide:key-round',
      order: 6,
      title: $t('ops-shell.nav.entitlement'),
    },
    name: 'Entitlement',
    path: '/entitlements',
    children: [
      {
        component: () => import('#/views/ops/entitlement/subscriptions.vue'),
        meta: {
          authority: [OPS_PERMISSION.ENTITLEMENT_READ],
          icon: 'lucide:repeat',
          order: 1,
          title: $t('ops-shell.menu.entitlementSubscriptions'),
        },
        name: 'EntitlementSubscriptions',
        path: '/entitlements/subscriptions',
      },
      {
        component: () => import('#/views/ops/entitlement/licenses.vue'),
        meta: {
          authority: [OPS_PERMISSION.ENTITLEMENT_READ],
          icon: 'lucide:badge-check',
          order: 2,
          title: $t('ops-shell.menu.entitlementLicenses'),
        },
        name: 'EntitlementLicenses',
        path: '/entitlements/licenses',
      },
      {
        component: () => import('#/views/ops/entitlement/change-requests.vue'),
        meta: {
          authority: [OPS_PERMISSION.ENTITLEMENT_READ],
          icon: 'lucide:git-pull-request-arrow',
          order: 3,
          /**
           * 语言包不在本任务可写路径内，这里直接写中文标题；
           * 待 locales 负责人补 `ops-shell.menu.entitlementChangeRequests` 后替换为 `$t(...)`。
           */
          title: '权益变更申请',
        },
        name: 'EntitlementChangeRequests',
        path: '/entitlements/change-requests',
      },
    ],
  },
];

export default routes;
