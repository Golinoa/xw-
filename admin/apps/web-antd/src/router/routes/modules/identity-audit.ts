import type { RouteRecordRaw } from 'vue-router';

import { OPS_PERMISSION } from '#/constants/permissions';
import { $t } from '#/locales';

/**
 * 运营总览 / 运营配置 / 审计与集成（域：identity-audit）
 *
 * 约定：
 * 1. `meta.authority` 只写**权限动作码**（`OPS_PERMISSION`），禁止写角色名。
 * 2. `meta.authority` 为 OR 语义：具备任一动作即可进入路由。
 * 3. 父级 `authority` 取子级动作并集，用于在无权时整棵子树从路由与菜单中消失。
 * 4. 菜单隐藏只改善体验，真实授权由后端按动作码拒绝。
 */
const routes: RouteRecordRaw[] = [
  {
    component: () => import('#/views/ops/identity-audit/overview.vue'),
    meta: {
      affixTab: true,
      authority: [OPS_PERMISSION.OVERVIEW_READ],
      icon: 'lucide:gauge',
      order: 1,
      title: $t('ops-shell.nav.overview'),
    },
    name: 'Overview',
    path: '/overview',
  },
  {
    meta: {
      authority: [
        OPS_PERMISSION.OPERATOR_READ,
        OPS_PERMISSION.ROLE_MANAGE,
        OPS_PERMISSION.SETTINGS_MANAGE,
      ],
      icon: 'lucide:settings',
      order: 10,
      title: $t('ops-shell.nav.governance'),
    },
    name: 'Governance',
    path: '/governance',
    children: [
      {
        component: () => import('#/views/ops/identity-audit/operators.vue'),
        meta: {
          authority: [OPS_PERMISSION.OPERATOR_READ],
          icon: 'lucide:users-round',
          order: 1,
          title: $t('ops-shell.menu.governanceOperators'),
        },
        name: 'GovernanceOperators',
        path: '/governance/operators',
      },
      {
        component: () => import('#/views/ops/identity-audit/settings.vue'),
        meta: {
          authority: [OPS_PERMISSION.SETTINGS_MANAGE],
          icon: 'lucide:sliders-horizontal',
          order: 2,
          title: $t('ops-shell.menu.governanceSettings'),
        },
        name: 'GovernanceSettings',
        path: '/governance/settings',
      },
    ],
  },
  {
    meta: {
      authority: [OPS_PERMISSION.AUDIT_READ, OPS_PERMISSION.EXPORT_READ],
      icon: 'lucide:scroll-text',
      order: 11,
      title: $t('ops-shell.nav.audit'),
    },
    name: 'Audit',
    path: '/audit',
    children: [
      {
        component: () => import('#/views/ops/identity-audit/audit.vue'),
        meta: {
          authority: [OPS_PERMISSION.AUDIT_READ],
          icon: 'lucide:clipboard-list',
          order: 1,
          title: $t('ops-shell.menu.auditEvents'),
        },
        name: 'AuditEvents',
        path: '/audit/events',
      },
      {
        component: () => import('#/views/ops/identity-audit/exports.vue'),
        meta: {
          authority: [OPS_PERMISSION.EXPORT_READ],
          icon: 'lucide:download',
          order: 2,
          title: $t('ops-shell.menu.auditExports'),
        },
        name: 'AuditExports',
        path: '/audit/exports',
      },
    ],
  },
];

export default routes;
