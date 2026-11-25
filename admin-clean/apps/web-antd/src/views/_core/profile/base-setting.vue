<script setup lang="ts">
import type { BasicOption } from '@vben/types';

import type { VbenFormSchema } from '#/adapter/form';

import { computed, onMounted, ref } from 'vue';

import { ProfileBaseSetting } from '@vben/common-ui';
import { useUserStore } from '@vben/stores';

const profileBaseSettingRef = ref();
const userStore = useUserStore();

const ROLE_LABELS: Record<string, string> = {
  owner: '公司负责人',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};

const roleOptions = computed((): BasicOption[] =>
  (userStore.userInfo?.roles ?? []).map((role) => ({
    label: ROLE_LABELS[role] ?? role,
    value: role,
  })),
);

const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'Input',
      fieldName: 'realName',
      label: '姓名',
    },
    {
      component: 'Input',
      fieldName: 'username',
      label: '登录邮箱',
      componentProps: { disabled: true },
    },
    {
      component: 'Select',
      componentProps: {
        disabled: true,
        mode: 'tags',
        options: roleOptions.value,
      },
      fieldName: 'roles',
      label: '角色',
    },
  ];
});

onMounted(() => {
  const info = userStore.userInfo;
  profileBaseSettingRef.value?.getFormApi().setValues({
    realName: info?.realName ?? '',
    username: info?.username ?? '',
    roles: info?.roles ?? [],
  });
});
</script>
<template>
  <ProfileBaseSetting ref="profileBaseSettingRef" :form-schema="formSchema" />
</template>
