<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ siteKey: string }>();
const emit = defineEmits<{ token: [value: string] }>();
const host = ref<HTMLElement | null>(null);
let widgetId: string | number | undefined;
let script: HTMLScriptElement | undefined;

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: { sitekey: string; callback(token: string): void; 'expired-callback'(): void; 'error-callback'(): void }): string | number;
      remove(id: string | number): void;
    };
  }
}

function render() {
  if (!props.siteKey || !host.value || !window.turnstile) return;
  widgetId = window.turnstile.render(host.value, {
    sitekey: props.siteKey,
    callback: (token) => emit('token', token),
    'expired-callback': () => emit('token', ''),
    'error-callback': () => emit('token', ''),
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
  script.onload = render;
  document.head.append(script);
});

watch(() => props.siteKey, () => {
  if (widgetId !== undefined) window.turnstile?.remove(widgetId);
  widgetId = undefined;
  render();
});

onBeforeUnmount(() => {
  if (widgetId !== undefined) window.turnstile?.remove(widgetId);
  script?.remove();
});
</script>

<template>
  <div v-if="siteKey" ref="host" class="auth-captcha" aria-label="机器人验证" />
</template>

<style scoped>
.auth-captcha {
  display: flex;
  justify-content: center;
  margin: 1rem 0;
}
</style>
