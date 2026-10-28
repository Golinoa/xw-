<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import MemberManagementPanel from '../components/MemberManagementPanel.vue';
const auth = useAuthStore();
const canManageMembers = computed(() => auth.currentOrganization.value?.role === 'admin');
</script>

<template>
  <section class="home-page" aria-labelledby="welcome-title">
    <a-card>
      <a-typography-title id="welcome-title" :level="3">工作台</a-typography-title>
      <a-typography-paragraph v-if="auth.loading.value" role="status"
        >正在读取公司信息…</a-typography-paragraph
      >
      <a-typography-paragraph v-else-if="!auth.currentOrganization.value"
        >当前账号尚未加入公司，请联系管理员。</a-typography-paragraph
      >
      <template v-else>
        <a-typography-title :level="4">{{
          auth.currentOrganization.value.organizationName
        }}</a-typography-title>
        <a-typography-paragraph
          >当前角色：{{ auth.currentOrganization.value.role }}</a-typography-paragraph
        >
      </template>
    </a-card>
    <MemberManagementPanel v-if="canManageMembers" />
  </section>
</template>

<style scoped>
.home-page {
  margin: var(--space-32);
}
</style>
