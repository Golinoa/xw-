<script lang="ts" setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { Card, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'OpsPlaceholderPage' });

const route = useRoute();

const title = computed(() => (route.meta?.title as string) ?? '');
/**
 * `meta.title` 在路由模块加载时求值，而路由是 `import.meta.glob({ eager: true })`
 * 静态引入的，早于 `bootstrap.ts` 里的 `setupI18n()`，因此拿到的是 i18n key
 * 而非译文（如 `ops-shell.nav.overview`）。这里显式翻译一次。
 *
 * 若将来加载顺序变化、`meta.title` 已是译文，`$t()` 找不到对应 key 会原样返回，
 * 因此本写法在两种情况下都成立。
 */
const displayTitle = computed(() => (title.value ? $t(title.value) : ''));
const authority = computed<string[]>(
  () => (route.meta?.authority as string[]) ?? [],
);
</script>

<template>
  <div class="p-5">
    <Card>
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-medium text-foreground">{{ displayTitle }}</h2>
        <Tag color="warning">{{ $t('ops-shell.placeholder.tag') }}</Tag>
      </div>

      <p class="mt-4 text-sm text-muted-foreground">
        {{ $t('ops-shell.placeholder.pending') }}
      </p>

      <div v-if="authority.length > 0" class="mt-6">
        <p class="text-sm text-muted-foreground">
          {{ $t('ops-shell.placeholder.requiredPermissions') }}
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <Tag v-for="code in authority" :key="code" color="processing">
            {{ code }}
          </Tag>
        </div>
      </div>

      <p class="mt-6 text-xs text-muted-foreground">
        {{ $t('ops-shell.placeholder.authorityNote') }}
      </p>
    </Card>
  </div>
</template>
