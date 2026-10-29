import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/**
 * 合同与订单（域：contract）。`meta.authority` 只写动作码。
 *
 * 草拟页与详情页为 `hideInMenu`，用 `activePath` 保持菜单高亮。
 * 标题文案直写中文的原因见 `customer.ts` 顶部注释（locale 包不在本任务可写范围）。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.CONTRACT_READ],
      icon: 'lucide:file-text',
      order: 4,
      title: $t('ops-shell.nav.contract'),
    },
    name: 'Contract',
    path: '/contracts',
    children: [
      {
        component: () => import('#/views/ops/contract/list.vue'),
        meta: {
          authority: [OPS_PERMISSION.CONTRACT_READ],
          icon: 'lucide:files',
          order: 1,
          title: $t('ops-shell.menu.contractList'),
        },
        name: 'ContractList',
        path: '/contracts/list',
      },
      {
        component: () => import('#/views/ops/contract/create.vue'),
        meta: {
          activePath: '/contracts/list',
          authority: [OPS_PERMISSION.CONTRACT_READ],
          hideInMenu: true,
          title: '草拟合同',
        },
        name: 'ContractCreate',
        path: '/contracts/create',
      },
      {
        component: () => import('#/views/ops/contract/detail.vue'),
        meta: {
          activePath: '/contracts/list',
          authority: [OPS_PERMISSION.CONTRACT_READ],
          hideInMenu: true,
          title: '合同详情',
        },
        name: 'ContractDetail',
        path: '/contracts/detail/:contractId',
      },
    ],
  },
];

export default routes;
