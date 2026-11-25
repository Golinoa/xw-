<script lang="ts" setup>
import { computed } from 'vue';

import { Page } from '@vben/common-ui';

import { Card } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import MemberManagementPanel from './member-management-panel.vue';

defineOptions({ name: 'Workbench' });

const authStore = useAuthStore();

const organization = computed(() => authStore.currentOrganization);
const isAdmin = computed(() => organization.value?.role === 'admin');
</script>

<template>
  <Page :description="$t('shell.workbench.description')" :title="$t('shell.workbench.title')">
    <Card>
      <p v-if="!authStore.initialized" class="text-muted-foreground" role="status">
        {{ $t('shell.workbench.loading') }}
      </p>
      <p v-else-if="!organization" data-testid="no-membership">
        {{ $t('shell.workbench.noMembership') }}
      </p>
      <template v-else>
        <h3 class="text-lg font-semibold">{{ organization.organizationName }}</h3>
        <dl class="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-muted-foreground">{{ $t('shell.workbench.role') }}</dt>
            <dd data-testid="workbench-role">
              {{ $t(`shell.role.${organization.role}`) }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{{ $t('shell.workbench.account') }}</dt>
            <dd data-testid="workbench-account">{{ authStore.session?.user.email }}</dd>
          </div>
        </dl>
      </template>
    </Card>

    <MemberManagementPanel v-if="isAdmin" class="mt-4" />
  </Page>
</template>
