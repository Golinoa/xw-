<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
async function onOrganizationChange(organizationId: string) {
  await auth.switchOrganization(organizationId);
}
async function logout() {
  await auth.signOut();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <a-layout class="app-shell">
    <a-layout-header class="app-header">
      <div class="header-main">
        <RouterLink to="/" class="brand">有单·旅游管理系统</RouterLink>
        <nav class="app-nav" aria-label="主导航">
          <RouterLink to="/" class="nav-link" :class="{ 'nav-link-active': route.name === 'home' }">
            工作台
          </RouterLink>
          <RouterLink
            to="/customers"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'customers' }"
          >
            客户
          </RouterLink>
          <RouterLink
            to="/orders"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'orders' }"
          >
            订单
          </RouterLink>
          <RouterLink
            to="/suppliers"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'suppliers' }"
          >
            供应商
          </RouterLink>
          <RouterLink
            to="/finance"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'finance' }"
          >
            财务
          </RouterLink>
          <RouterLink
            to="/finance/applications"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'finance-applications' }"
          >
            审批
          </RouterLink>
          <RouterLink
            to="/settlements"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'settlements' }"
          >
            结算
          </RouterLink>
          <RouterLink
            to="/company-settings"
            class="nav-link"
            :class="{ 'nav-link-active': route.name === 'company-settings' }"
          >
            设置
          </RouterLink>
        </nav>
      </div>
      <div class="account-tools">
        <label for="organization">当前公司</label>
        <a-select
          id="organization"
          aria-label="当前公司"
          :value="auth.currentOrganization.value?.organizationId"
          :disabled="auth.loading.value"
          @change="onOrganizationChange"
        >
          <a-select-option
            v-for="membership in auth.memberships.value"
            :key="membership.organizationId"
            :value="membership.organizationId"
          >
            {{ membership.organizationName }}
          </a-select-option>
        </a-select>
        <span>{{ auth.user.value?.email }}</span>
        <a-button :disabled="auth.loading.value" @click="logout">退出登录</a-button>
      </div>
    </a-layout-header>
    <a-alert
      v-if="auth.error.value"
      class="layout-error"
      type="error"
      :message="auth.error.value"
      show-icon
    />
    <a-layout-content class="app-content"><RouterView /></a-layout-content>
  </a-layout>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--color-canvas);
  color: var(--color-text);
  font-family: var(--font-family-ui);
}
:deep(.app-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
  padding: 0 var(--space-24);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border-subtle);
  line-height: normal;
}
.brand {
  color: var(--color-text);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-lg);
  font-weight: 600;
  text-decoration: none;
}
.header-main {
  display: flex;
  align-items: center;
  gap: var(--space-32);
}
.app-nav {
  display: flex;
  align-items: center;
  gap: var(--space-24);
}
.nav-link {
  color: var(--color-secondary-text);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-sm);
  text-decoration: none;
}
.nav-link:hover {
  color: var(--color-primary);
}
.nav-link-active {
  color: var(--color-primary);
  font-weight: 600;
}
.account-tools {
  display: flex;
  align-items: center;
  gap: var(--space-12);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-sm);
}
.layout-error {
  margin: var(--space-16) var(--space-24) 0;
}
.app-content {
  min-height: calc(100vh - 64px);
}
</style>
