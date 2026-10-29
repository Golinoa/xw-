import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/**
 * 售后工单（域：support）。`meta.authority` 只写动作码。
 *
 * 详情页为 `hideInMenu`，用 `activePath` 让左侧菜单保持高亮在「工单列表」；
 * 标题直写中文（locale 包不在本任务可写范围，与 customer.ts 同一处理方式）。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.TICKET_READ],
      icon: 'lucide:life-buoy',
      order: 9,
      title: $t('ops-shell.nav.support'),
    },
    name: 'Support',
    path: '/support',
    children: [
      {
        component: () => import('#/views/ops/support/list.vue'),
        meta: {
          authority: [OPS_PERMISSION.TICKET_READ],
          icon: 'lucide:ticket',
          order: 1,
          title: $t('ops-shell.menu.ticketList'),
        },
        name: 'SupportTicketList',
        path: '/support/tickets',
      },
      {
        component: () => import('#/views/ops/support/detail.vue'),
        meta: {
          activePath: '/support/tickets',
          authority: [OPS_PERMISSION.TICKET_READ],
          hideInMenu: true,
          title: '工单详情',
        },
        name: 'SupportTicketDetail',
        path: '/support/tickets/detail/:ticketId',
      },
    ],
  },
];

export default routes;
