<script lang="ts" setup>
import { Fallback } from '@vben/common-ui';

import { $t } from '#/locales';

defineOptions({ name: 'FallbackForbidden' });

/**
 * 统一 403 页。
 *
 * 两种入口：
 * 1. `/error/403` 直接访问（core 路由，`ignoreAccess`）；
 * 2. 路由声明 `meta.menuVisibleWithForbidden: true` 时由 `forbiddenComponent` 复用。
 *
 * 默认口径仍为「菜单不可见 + 直达落 404」，本页仅用于需要明示
 * 「功能存在但无权限」的模块。
 */
</script>

<template>
  <Fallback
    status="403"
    :description="$t('ops-shell.fallback.forbiddenDescription')"
    home-path="/"
    :title="$t('ops-shell.fallback.forbiddenTitle')"
  />
</template>
