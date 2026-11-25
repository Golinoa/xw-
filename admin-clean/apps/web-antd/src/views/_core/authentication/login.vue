<script lang="ts" setup>
import type { VbenFormSchema } from '@vben/common-ui';
import type { Recordable } from '@vben/types';

import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { AuthenticationLogin, z } from '@vben/common-ui';
import { preferences } from '@vben/preferences';

import { Alert, Button, Form, FormItem, InputPassword } from 'ant-design-vue';

import AuthCaptcha from '#/components/auth-captcha.vue';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { classifyLoginError, loginErrorMessageKey } from './login-error';

defineOptions({ name: 'Login' });

const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();

type LoginErrorKind = ReturnType<typeof classifyLoginError>;

const errorKind = ref<LoginErrorKind | null>(null);
const invitationError = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const recoveryError = ref('');

const captchaSiteKey = import.meta.env.VITE_SUPABASE_CAPTCHA_SITE_KEY ?? '';

const errorMessage = computed(() =>
  errorKind.value ? $t(loginErrorMessageKey(errorKind.value)) : '',
);

/** 登录成功后的落点。守卫会再按 `redirect` 校正一次，这里只是提交后的即时去处。 */
function redirectTarget() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
  return redirect.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : preferences.app.defaultHomePath;
}

function readInvitationId() {
  return typeof route.query.invitationId === 'string' ? route.query.invitationId : '';
}

/**
 * 员工登录：邮箱 + 密码（Supabase Auth）。
 *
 * 不提供公开注册、验证码登录、二维码登录入口：账号由公司管理员邀请后创建。
 */
const formSchema = computed((): VbenFormSchema[] => {
  const fields: VbenFormSchema[] = [
    {
      component: 'VbenInput',
      componentProps: {
        autocomplete: 'email',
        placeholder: $t('shell.login.emailPlaceholder'),
      },
      fieldName: 'email',
      label: $t('shell.login.email'),
      rules: z.string().min(1, { message: $t('shell.login.emailPlaceholder') }),
    },
    {
      component: 'VbenInputPassword',
      componentProps: {
        autocomplete: 'current-password',
        placeholder: $t('shell.login.passwordPlaceholder'),
      },
      fieldName: 'password',
      label: $t('shell.login.password'),
      rules: z.string().min(1, { message: $t('shell.login.passwordPlaceholder') }),
    },
  ];

  /**
   * CAPTCHA 只在部署配置了 site key 时出现。字段值直接进 `values.captchaToken`，
   * store 会原样传给 Supabase——没有这一步，开了 CAPTCHA 的项目无法登录。
   */
  if (captchaSiteKey) {
    fields.push({
      component: AuthCaptcha,
      componentProps: { siteKey: captchaSiteKey },
      fieldName: 'captchaToken',
      label: $t('shell.login.captcha'),
      rules: z.string().min(1, { message: $t('shell.login.captchaRequired') }),
    });
  }

  return fields;
});

async function handleSubmit(values: Recordable<any>) {
  errorKind.value = null;
  invitationError.value = '';
  const invitationId = readInvitationId();

  try {
    await authStore.authLogin(values, async () => {
      if (invitationId) {
        const accepted = await authStore.acceptInvitation(invitationId);
        if (!accepted) {
          // 邀请失效时停在登录页并给出原因：此时账号已登录但没有任何公司，
          // 放进去只会看到一屏「尚未加入公司」。
          invitationError.value = $t('shell.login.invitationInvalid');
          return;
        }
      }
      await router.replace(redirectTarget());
    });
  } catch (error) {
    // 错误在页面内联呈现，不用全局 toast，避免遮挡表单与丢失输入。
    errorKind.value = classifyLoginError(error);
  }
}

async function submitNewPassword() {
  recoveryError.value = '';
  if (newPassword.value !== confirmPassword.value) {
    recoveryError.value = $t('shell.login.passwordMismatch');
    return;
  }
  if (newPassword.value.length < 6) {
    recoveryError.value = $t('shell.login.passwordTooShort');
    return;
  }
  if (await authStore.updatePassword(newPassword.value)) {
    newPassword.value = '';
    confirmPassword.value = '';
  } else {
    recoveryError.value = authStore.notice;
  }
}

onMounted(async () => {
  const invitationId = readInvitationId();
  if (!invitationId || !authStore.isAuthenticated || authStore.recoveryMode) {
    return;
  }
  if (await authStore.acceptInvitation(invitationId)) {
    await router.replace(redirectTarget());
  } else {
    invitationError.value = $t('shell.login.invitationInvalid');
  }
});
</script>

<template>
  <div>
    <!-- 重置邮件回跳：必须先设置新密码，此时 store 里没有任何访问令牌。 -->
    <template v-if="authStore.recoveryMode">
      <h2 class="mb-1 text-2xl font-semibold">{{ $t('shell.login.recoveryTitle') }}</h2>
      <p class="mb-6 text-sm text-muted-foreground">
        {{ $t('shell.login.recoverySubtitle') }}
      </p>
      <Alert v-if="recoveryError" class="mb-4" :message="recoveryError" show-icon type="error" />
      <Form layout="vertical" @submit.prevent="submitNewPassword">
        <FormItem :label="$t('shell.login.newPassword')">
          <InputPassword
            v-model:value="newPassword"
            aria-label="new-password"
            autocomplete="new-password"
            :placeholder="$t('shell.login.newPassword')"
          />
        </FormItem>
        <FormItem :label="$t('shell.login.confirmPassword')">
          <InputPassword
            v-model:value="confirmPassword"
            aria-label="confirm-password"
            autocomplete="new-password"
            :placeholder="$t('shell.login.confirmPassword')"
          />
        </FormItem>
        <Button
          aria-label="update-password"
          block
          :loading="authStore.loginLoading"
          type="primary"
          @click="submitNewPassword"
        >
          {{ $t('shell.login.updatePassword') }}
        </Button>
      </Form>
    </template>

    <template v-else>
      <Alert
        v-if="authStore.notice"
        class="mb-4"
        :message="authStore.notice"
        show-icon
        type="success"
      />
      <Alert
        v-if="errorKind"
        class="mb-4"
        data-testid="login-error"
        :message="errorMessage"
        show-icon
        type="error"
      />
      <Alert
        v-if="invitationError"
        class="mb-4"
        data-testid="invitation-error"
        :message="invitationError"
        show-icon
        type="error"
      />

      <AuthenticationLogin
        :form-schema="formSchema"
        forget-password-path="/auth/forget-password"
        :loading="authStore.loginLoading"
        :show-code-login="false"
        :show-forget-password="true"
        :show-qrcode-login="false"
        :show-register="false"
        :show-remember-me="false"
        :show-third-party-login="false"
        :sub-title="$t('shell.login.subtitle')"
        :submit-button-text="$t('shell.login.submit')"
        :title="$t('shell.login.formTitle')"
        @submit="handleSubmit"
      />

      <p class="mt-4 text-center text-xs text-muted-foreground">
        {{ $t('shell.login.noRegisterHint') }}
      </p>
    </template>
  </div>
</template>
