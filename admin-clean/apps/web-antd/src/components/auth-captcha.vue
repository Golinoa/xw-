<script lang="ts" setup>
/**
 * Cloudflare Turnstile 人机校验（从 `udone/apps/web` 移植）。
 *
 * 只有配置了 `VITE_SUPABASE_CAPTCHA_SITE_KEY` 才渲染：未启用 CAPTCHA 的部署里
 * 这块是空白，不阻塞登录。校验令牌通过 `v-model` 交给表单，再由 store 传给 Supabase。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ siteKey: string }>();

const modelValue = defineModel<string>({ default: '' });

const host = ref<HTMLElement | null>(null);
let widgetId: number | string | undefined;
let script: HTMLScriptElement | undefined;

declare global {
  interface Window {
    turnstile?: {
      remove(id: number | string): void;
      render(
        element: HTMLElement,
        options: {
          'error-callback'(): void;
          'expired-callback'(): void;
          callback(token: string): void;
          sitekey: string;
        },
      ): number | string;
    };
  }
}

function setToken(token: string) {
  modelValue.value = token;
}

function render() {
  if (!props.siteKey || !host.value || !window.turnstile) return;
  widgetId = window.turnstile.render(host.value, {
    sitekey: props.siteKey,
    callback: (token) => setToken(token),
    'expired-callback': () => setToken(''),
    'error-callback': () => setToken(''),
  });
}

onMounted(() => {
  if (!props.siteKey) return;
  if (window.turnstile) {
    render();
    return;
  }
  script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.addEventListener('load', render);
  document.head.append(script);
});

watch(
  () => props.siteKey,
  () => {
    if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    widgetId = undefined;
    setToken('');
    render();
  },
);

onBeforeUnmount(() => {
  if (widgetId !== undefined) window.turnstile?.remove(widgetId);
  script?.remove();
});
</script>

<template>
  <div v-if="siteKey" ref="host" class="flex justify-center" aria-label="机器人验证"></div>
</template>
