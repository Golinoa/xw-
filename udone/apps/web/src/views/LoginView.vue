<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import AuthCaptcha from '../components/AuthCaptcha.vue';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const resetMode = ref(false);
const invitationError = ref('');
const captchaToken = ref('');
const captchaSiteKey = import.meta.env.VITE_SUPABASE_CAPTCHA_SITE_KEY ?? '';

function redirectTarget() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  return redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/';
}

async function submit() {
  const token = captchaToken.value;
  captchaToken.value = '';
  if (await auth.signIn(email.value, password.value, token || undefined)) {
    const invitationId = typeof route.query.invitationId === 'string' ? route.query.invitationId : '';
    if (invitationId && !(await auth.acceptInvitation(invitationId))) return;
    await router.replace(redirectTarget());
  }
}

async function submitPasswordRecovery() {
  const token = captchaToken.value;
  captchaToken.value = '';
  await auth.resetPassword(email.value, token || undefined);
}

async function submitNewPassword() {
  if (newPassword.value !== confirmPassword.value) {
    invitationError.value = '两次输入的密码不一致';
    return;
  }
  invitationError.value = '';
  if (await auth.updatePassword(newPassword.value)) {
    newPassword.value = '';
    confirmPassword.value = '';
    resetMode.value = false;
  }
}

onMounted(async () => {
  const invitationId = typeof route.query.invitationId === 'string' ? route.query.invitationId : '';
  if (invitationId && auth.isAuthenticated.value && !auth.recoveryMode.value) {
    if (await auth.acceptInvitation(invitationId)) await router.replace(redirectTarget());
    else invitationError.value = '邀请暂不可用，请联系组织管理员';
  }
});
</script>

<template>
  <main class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <a-typography-title class="login-title" :level="2">
        {{ auth.recoveryMode.value ? '设置新密码' : resetMode ? '重置密码' : '登录' }}
      </a-typography-title>
      <template v-if="auth.recoveryMode.value">
        <a-form-item>
          <label for="new-password">新密码</label>
          <a-input-password id="new-password" v-model:value="newPassword" aria-label="新密码" autocomplete="new-password" required />
        </a-form-item>
        <a-form-item>
          <label for="confirm-password">确认新密码</label>
          <a-input-password id="confirm-password" v-model:value="confirmPassword" aria-label="确认新密码" autocomplete="new-password" required />
        </a-form-item>
        <a-alert v-if="invitationError" type="error" :message="invitationError" show-icon />
        <a-button type="primary" :loading="auth.loading.value" block @click="submitNewPassword">
          更新密码
        </a-button>
      </template>
      <template v-else-if="resetMode">
        <a-form-item>
          <label for="recovery-email">邮箱</label>
          <a-input id="recovery-email" v-model:value.trim="email" aria-label="邮箱" type="email" autocomplete="email" required />
        </a-form-item>
        <AuthCaptcha :site-key="captchaSiteKey" @token="captchaToken = $event" />
        <a-alert v-if="auth.recoveryMessage.value" type="success" :message="auth.recoveryMessage.value" show-icon />
        <a-alert v-if="auth.error.value" type="error" :message="auth.error.value" show-icon />
        <a-button type="primary" :loading="auth.loading.value" :disabled="Boolean(captchaSiteKey && !captchaToken)" block @click="submitPasswordRecovery">
          发送重置邮件
        </a-button>
        <a-button type="link" block @click="resetMode = false">返回登录</a-button>
      </template>
      <template v-else>
      <a-form-item>
        <label for="email">邮箱</label>
        <a-input
          id="email"
          aria-label="邮箱"
          v-model:value.trim="email"
          type="email"
          autocomplete="username"
          required
        />
      </a-form-item>
      <a-form-item>
        <label for="password">密码</label>
        <a-input-password
          id="password"
          aria-label="密码"
          v-model:value="password"
          autocomplete="current-password"
          required
        />
      </a-form-item>
      <AuthCaptcha :site-key="captchaSiteKey" @token="captchaToken = $event" />
      <a-alert v-if="auth.error.value" type="error" :message="auth.error.value" show-icon />
      <a-alert v-if="invitationError" type="error" :message="invitationError" show-icon />
      <a-button html-type="submit" type="primary" :loading="auth.loading.value" :disabled="Boolean(captchaSiteKey && !captchaToken)" block>
        {{ auth.loading.value ? '正在登录…' : '登录' }}
      </a-button>
      <a-button type="link" block @click="resetMode = true">忘记密码？</a-button>
      </template>
    </form>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: var(--space-16);
  background: var(--color-canvas);
  color: var(--color-text);
  font-family: var(--font-family-ui);
}
.login-card {
  width: min(24rem, 100%);
  padding: var(--space-32);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-default);
}
.login-card :deep(.login-title) {
  margin: 0 0 var(--space-24);
  color: var(--color-heading);
  font-size: var(--font-size-3xl);
  line-height: var(--line-height-3xl);
  font-weight: 600;
}
.login-card :deep(.ant-form-item) {
  margin-bottom: var(--space-16);
}
.login-card :deep(.ant-alert) {
  margin-bottom: var(--space-16);
}
</style>
