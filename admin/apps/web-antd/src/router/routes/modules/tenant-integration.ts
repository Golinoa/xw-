import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/** udone 租户映射与开通命令（域：tenant-integration）。`meta.authority` 只写动作码。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.TENANT_READ],
      icon: 'lucide:git-branch',
      order: 7,
      title: $t('ops-shell.nav.tenant'),
    },
    name: 'TenantIntegration',
    path: '/tenants',
    children: [
      {
        component: () => import('#/views/ops/tenant-integration/mappings.vue'),
        meta: {
          authority: [OPS_PERMISSION.TENANT_READ],
          icon: 'lucide:link',
          order: 1,
          title: $t('ops-shell.menu.tenantMappings'),
        },
        name: 'TenantMappings',
        path: '/tenants/mappings',
      },
      {
        component: () => import('#/views/ops/tenant-integration/commands.vue'),
        meta: {
          authority: [OPS_PERMISSION.TENANT_READ],
          // 语言包不在本任务可写范围，故用字面标题（见 journal 待办）。
          icon: 'lucide:list-checks',
          order: 2,
          title: '命令与尝试记录',
        },
        name: 'TenantCommands',
        path: '/tenants/commands',
      },
    ],
  },
];

export default routes;
