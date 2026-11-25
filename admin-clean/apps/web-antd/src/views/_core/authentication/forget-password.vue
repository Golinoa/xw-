<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';

import { Alert, Button, Form, FormItem, Input } from 'ant-design-vue';

import AuthCaptcha from '#/components/auth-captcha.vue';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'ForgetPassword' });

const authStore = useAuthStore();
const router = useRouter();

const email = ref('');
const captchaToken = ref('');
const errorText = ref('');
const captchaSiteKey = import.meta.env.VITE_SUPABASE_CAPTCHA_SITE_KEY ?? '';

/** 上一页留下的提示（例如改密成功）不该出现在这里。 */
onMounted(() => {
  authStore.notice = '';
});

const canSubmit = computed(
  () => !captchaSiteKey || Boolean(captchaToken.value),
);

async function submit() {
  errorText.value = '';
  if (!email.value.trim()) {
    errorText.value = $t('shell.login.emailRequired');
    return;
  }
  if (!canSubmit.value) {
    errorText.value = $t('shell.login.captchaRequired');
    return;
  }
  /**
   * 无论邮箱是否注册都走同一条成功路径：文案由 store 统一成
   * 「如果该邮箱已注册，我们会发送密码重置邮件」，避免被用来枚举账号。
   */
  await authStore.resetPassword(email.value, captchaToken.value || undefined);
}
</script>

<template>
  <div>
    <h2 class="mb-1 text-2xl font-semibold">{{ $t('shell.login.forgetTitle') }}</h2>
    <p class="mb-6 text-sm text-muted-foreground">{{ $t('shell.login.forgetSubtitle') }}</p>

    <Alert v-if="errorText" class="mb-4" :message="errorText" show-icon type="error" />
    <Alert v-if="authStore.notice" class="mb-4" :message="authStore.notice" show-icon type="success" />

    <Form layout="vertical" @submit.prevent="submit">
      <FormItem :label="$t('shell.login.email')">
        <Input
          v-model:value.trim="email"
          aria-label="email"
          autocomplete="email"
          :placeholder="$t('shell.login.emailPlaceholder')"
          type="email"
        />
      </FormItem>
      <AuthCaptcha v-model="captchaToken" :site-key="captchaSiteKey" />
      <Button
        aria-label="send-reset-mail"
        block
        class="mt-4"
        :disabled="!canSubmit"
        :loading="authStore.loginLoading"
        type="primary"
        @click="submit"
      >
        {{ $t('shell.login.sendResetMail') }}
      </Button>
      <Button class="mt-2" block type="link" @click="router.replace(LOGIN_PATH)">
        {{ $t('shell.login.backToLogin') }}
      </Button>
    </Form>
  </div>
</template>
