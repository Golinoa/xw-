<script lang="ts" setup>
import { Fallback } from '@vben/common-ui';

import { $t } from '#/locales';

defineOptions({ name: 'FallbackNotFound' });

/**
 * 统一 404 页。
 *
 * 无权限路由不会注册，直接输入 URL 会落到这里；文案必须同时覆盖
 * 「不存在」与「无权访问」两种可能，避免泄露资源是否存在。
 */
</script>

<template>
  <Fallback
    status="404"
    :description="$t('ops-shell.fallback.notFoundDescription')"
    home-path="/"
    :title="$t('ops-shell.fallback.notFoundTitle')"
  />
</template>
