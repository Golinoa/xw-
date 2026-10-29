import { createRouter, createWebHistory, type RouterHistory } from 'vue-router';
import { createAuthStore, useAuthStore } from '../stores/auth';

type AuthStore = ReturnType<typeof createAuthStore>;

export function createAppRouter(
  auth: AuthStore = useAuthStore(),
  history: RouterHistory = createWebHistory(),
) {
  const router = createRouter({
    history,
    routes: [
      {
        path: '/login',
        name: 'login',
        component: () => import('../views/LoginView.vue'),
        meta: { public: true },
      },
      {
        path: '/',
        component: () => import('../layouts/AppLayout.vue'),
        children: [
          { path: '', name: 'home', component: () => import('../views/HomeView.vue') },
          {
            path: 'customers',
            name: 'customers',
            component: () => import('../views/customers/CustomerListView.vue'),
          },
          {
            path: 'orders',
            name: 'orders',
            component: () => import('../views/orders/OrderListView.vue'),
          },
          {
            path: 'suppliers',
            name: 'suppliers',
            component: () => import('../views/suppliers/SupplierListView.vue'),
          },
          {
            path: 'finance',
            name: 'finance',
            component: () => import('../views/finance/FinanceListView.vue'),
          },
        ],
      },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  });
  router.beforeEach(async (to) => {
    await auth.initialize();
    if (
      to.meta.public &&
      auth.isAuthenticated.value &&
      !(to.name === 'login' && typeof to.query.invitationId === 'string')
    )
      return { name: 'home' };
    if (!to.meta.public && !auth.isAuthenticated.value)
      return { name: 'login', query: { redirect: to.fullPath } };
  });
  return router;
}
