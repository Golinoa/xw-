<script lang="ts" setup>
import { useRoute } from 'vue-router';

import { $t } from '#/locales';

defineOptions({ name: 'RoutePlaceholder' });

const route = useRoute();
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-3 p-8">
    <span
      class="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground"
    >
      {{ $t('shell.placeholder.tag') }}
    </span>
    <h2 class="text-lg font-medium">{{ route.meta.title }}</h2>
    <p class="max-w-md text-center text-sm text-muted-foreground">
      {{ $t('shell.placeholder.pending') }}
    </p>
  </div>
</template>
