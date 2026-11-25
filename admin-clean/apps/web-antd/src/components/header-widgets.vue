<script lang="ts" setup>
/**
 * 顶栏业务控件：公司切换 + 未读通知角标。
 *
 * 这两件事在旧前端的 `AppLayout` 里，迁移到 Vben 后必须有个落点：
 * - 公司切换：多组织账号没有它就只能看到默认那一家；
 * - 未读角标：通知页没有入口提示，等于藏起来。
 *
 * 切换公司后整页重载：组织上下文是全局的，页面上任何已加载的列表都属于上一家公司，
 * 局部刷新很容易漏掉某个组件，重载是唯一不会给出「混租户数据」的方案。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { createIconifyIcon } from '@vben/icons';

import { Badge, Button, Select, SelectOption, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'HeaderWidgets' });

const BellIcon = createIconifyIcon('lucide:bell');

const authStore = useAuthStore();
const router = useRouter();

const unreadCount = ref(0);
const switching = ref(false);

const organizationId = computed(() => authStore.currentOrganization?.organizationId);
const multipleOrganizations = computed(() => authStore.memberships.length > 1);

async function loadUnread() {
  if (!organizationId.value) {
    unreadCount.value = 0;
    return;
  }
  try {
    const result = await authStore.api.call('notificationUnreadCount');
    unreadCount.value = result.count;
  } catch {
    // 角标失败不该影响任何主流程：静默归零即可。
    unreadCount.value = 0;
  }
}

async function changeOrganization(value: unknown) {
  const next = String(value ?? '');
  if (!next || next === organizationId.value) return;
  switching.value = true;
  const switched = await authStore.switchOrganization(next);
  switching.value = false;
  if (switched) {
    window.location.reload();
  }
}

function openNotifications() {
  void router.push({ name: 'OpsNotifications' });
}

onMounted(loadUnread);
watch(organizationId, loadUnread);
</script>

<template>
  <div class="flex items-center gap-2">
    <Select
      v-if="multipleOrganizations"
      :disabled="switching"
      :loading="switching"
      :value="organizationId"
      aria-label="organization-switcher"
      class="min-w-[10rem]"
      size="small"
      @change="changeOrganization"
    >
      <SelectOption
        v-for="item in authStore.memberships"
        :key="item.organizationId"
        :value="item.organizationId"
      >
        {{ item.organizationName }}
      </SelectOption>
    </Select>

    <Tooltip :title="$t('shell.menu.notifications')">
      <Button aria-label="notifications" size="small" type="text" @click="openNotifications">
        <Badge :count="unreadCount" :offset="[2, -2]" size="small">
          <BellIcon class="size-4" />
        </Badge>
      </Button>
    </Tooltip>
  </div>
</template>
