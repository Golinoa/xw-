<script lang="ts" setup>
import type { VbenFormSchema } from '@vben/common-ui';
import type { Recordable } from '@vben/types';

import { computed, ref } from 'vue';

import { AuthenticationLogin, z } from '@vben/common-ui';

import { Alert } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import { classifyLoginError, loginErrorMessageKey } from './login-error';

defineOptions({ name: 'Login' });

const authStore = useAuthStore();

type LoginErrorKind = ReturnType<typeof classifyLoginError>;

const errorKind = ref<LoginErrorKind | null>(null);

const errorMessage = computed(() =>
  errorKind.value ? $t(loginErrorMessageKey(errorKind.value)) : '',
);

/**
 * 运营登录：账号 + 密码。
 *
 * 不提供公开注册、验证码登录、二维码登录与找回密码入口（PRD §4.1），
 * 账号由运营管理员在「运营配置」中分配。
 */
const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'VbenInput',
      componentProps: {
        autocomplete: 'username',
        placeholder: $t('ops-shell.login.usernamePlaceholder'),
      },
      fieldName: 'username',
      label: $t('ops-shell.login.username'),
      rules: z
        .string()
        .min(1, { message: $t('ops-shell.login.usernamePlaceholder') }),
    },
    {
      component: 'VbenInputPassword',
      componentProps: {
        autocomplete: 'current-password',
        placeholder: $t('ops-shell.login.passwordPlaceholder'),
      },
      fieldName: 'password',
      label: $t('ops-shell.login.password'),
      rules: z
        .string()
        .min(1, { message: $t('ops-shell.login.passwordPlaceholder') }),
    },
  ];
});

async function handleSubmit(values: Recordable<any>) {
  errorKind.value = null;
  try {
    await authStore.authLogin(values);
  } catch (error) {
    // 错误在页面内联呈现，不用全局 toast，避免遮挡表单与丢失输入。
    errorKind.value = classifyLoginError(error);
  }
}
</script>

<template>
  <div>
    <Alert
      v-if="errorKind"
      class="mb-4"
      data-testid="login-error"
      :message="errorMessage"
      show-icon
      type="error"
    />

    <AuthenticationLogin
      :form-schema="formSchema"
      :loading="authStore.loginLoading"
      :show-code-login="false"
      :show-forget-password="false"
      :show-qrcode-login="false"
      :show-register="false"
      :show-third-party-login="false"
      :sub-title="$t('ops-shell.login.subtitle')"
      :submit-button-text="$t('ops-shell.login.submit')"
      :title="$t('ops-shell.login.title')"
      @submit="handleSubmit"
    />

    <p class="mt-4 text-center text-xs text-muted-foreground">
      {{ $t('ops-shell.login.noRegisterHint') }}
    </p>
  </div>
</template>
