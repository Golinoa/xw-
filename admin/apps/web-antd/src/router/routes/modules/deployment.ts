import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/** 私有化部署台账（域：deployment）。`meta.authority` 只写动作码。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.DEPLOYMENT_READ],
      icon: 'lucide:server',
      order: 8,
      title: $t('ops-shell.nav.deployment'),
    },
    name: 'Deployment',
    path: '/deployments',
    children: [
      {
        component: () => import('#/views/ops/deployment/instances.vue'),
        meta: {
          authority: [OPS_PERMISSION.DEPLOYMENT_READ],
          icon: 'lucide:hard-drive',
          order: 1,
          title: $t('ops-shell.menu.deploymentInstances'),
        },
        name: 'DeploymentInstances',
        path: '/deployments/instances',
      },
      {
        /**
         * 详情页不占菜单位（`hideInMenu`），用 `activePath` 保持左侧菜单高亮在实例列表。
         * 标题直写中文的原因见 `customer.ts` 顶部注释（locale 包不在本任务可写范围）。
         */
        component: () => import('#/views/ops/deployment/detail.vue'),
        meta: {
          activePath: '/deployments/instances',
          authority: [OPS_PERMISSION.DEPLOYMENT_READ],
          hideInMenu: true,
          title: '部署实例详情',
        },
        name: 'DeploymentInstanceDetail',
        path: '/deployments/instances/:deploymentId',
      },
    ],
  },
];

export default routes;
