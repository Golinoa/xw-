<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import AuthCaptcha from './AuthCaptcha.vue';

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
    const invitationId =
      typeof route.query.invitationId === 'string' ? route.query.invitationId : '';
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
      <h1>{{ auth.recoveryMode.value ? '设置新密码' : resetMode ? '重置密码' : '登录' }}</h1>
      <template v-if="auth.recoveryMode.value">
        <label for="new-password">新密码</label>
        <input
          id="new-password"
          v-model="newPassword"
          aria-label="新密码"
          type="password"
          autocomplete="new-password"
          required
        />
        <label for="confirm-password">确认新密码</label>
        <input
          id="confirm-password"
          v-model="confirmPassword"
          aria-label="确认新密码"
          type="password"
          autocomplete="new-password"
          required
        />
        <p v-if="invitationError" role="alert">{{ invitationError }}</p>
        <button type="button" :disabled="auth.loading.value" @click="submitNewPassword">
          更新密码
        </button>
      </template>
      <template v-else-if="resetMode">
        <label for="recovery-email">邮箱</label>
        <input
          id="recovery-email"
          v-model.trim="email"
          aria-label="邮箱"
          type="email"
          autocomplete="email"
          required
        />
        <AuthCaptcha :site-key="captchaSiteKey" @token="captchaToken = $event" />
        <p v-if="auth.recoveryMessage.value" role="status">{{ auth.recoveryMessage.value }}</p>
        <p v-if="auth.error.value" role="alert">{{ auth.error.value }}</p>
        <button
          type="button"
          :disabled="auth.loading.value || Boolean(captchaSiteKey && !captchaToken)"
          @click="submitPasswordRecovery"
        >
          发送重置邮件
        </button>
        <button type="button" @click="resetMode = false">返回登录</button>
      </template>
      <template v-else>
        <label for="email">邮箱</label>
        <input id="email" v-model.trim="email" type="email" autocomplete="username" required />
        <label for="password">密码</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
        <AuthCaptcha :site-key="captchaSiteKey" @token="captchaToken = $event" />
        <p v-if="auth.error.value" role="alert">{{ auth.error.value }}</p>
        <p v-if="invitationError" role="alert">{{ invitationError }}</p>
        <button
          type="submit"
          :disabled="auth.loading.value || Boolean(captchaSiteKey && !captchaToken)"
        >
          {{ auth.loading.value ? '正在登录…' : '登录' }}
        </button>
        <button type="button" @click="resetMode = true">忘记密码？</button>
      </template>
    </form>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 1rem;
  background: var(--color-canvas);
}
.login-card {
  display: grid;
  width: min(24rem, 100%);
  gap: 0.8rem;
  padding: 2rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 0.6rem;
}
.login-card h1 {
  margin: 0 0 0.5rem;
}
.login-card input,
.login-card button {
  box-sizing: border-box;
  min-height: 2.6rem;
  padding: 0.5rem 0.7rem;
}
</style>
