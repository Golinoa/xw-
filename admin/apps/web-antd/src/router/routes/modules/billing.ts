import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/** 应收与收款（域：billing）。`meta.authority` 只写动作码。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: [OPS_PERMISSION.RECEIVABLE_READ],
      icon: 'lucide:wallet',
      order: 5,
      title: $t('ops-shell.nav.billing'),
    },
    name: 'Billing',
    path: '/billing',
    children: [
      {
        component: () => import('#/views/ops/billing/receivables.vue'),
        meta: {
          authority: [OPS_PERMISSION.RECEIVABLE_READ],
          icon: 'lucide:calendar-clock',
          order: 1,
          title: $t('ops-shell.menu.billingReceivables'),
        },
        name: 'BillingReceivables',
        path: '/billing/receivables',
      },
      {
        component: () => import('#/views/ops/billing/receipts.vue'),
        meta: {
          authority: [OPS_PERMISSION.RECEIVABLE_READ],
          icon: 'lucide:receipt-text',
          order: 2,
          title: $t('ops-shell.menu.billingReceipts'),
        },
        name: 'BillingReceipts',
        path: '/billing/receipts',
      },
      {
        // 契约 §4 没有 receipt.read 动作码，读权限统一用 receivable.read
        component: () => import('#/views/ops/billing/refunds.vue'),
        meta: {
          authority: [OPS_PERMISSION.RECEIVABLE_READ],
          icon: 'lucide:rotate-ccw',
          order: 3,
          title: '退款与冲正',
        },
        name: 'BillingRefunds',
        path: '/billing/refunds',
      },
      {
        component: () => import('#/views/ops/billing/ledger.vue'),
        meta: {
          authority: [OPS_PERMISSION.RECEIVABLE_READ],
          icon: 'lucide:list-tree',
          order: 4,
          title: '账款明细',
        },
        name: 'BillingLedger',
        path: '/billing/ledger',
      },
    ],
  },
];

export default routes;
