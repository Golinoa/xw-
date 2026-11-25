<script lang="ts" setup>
/**
 * 成员与邀请（从旧前端 `MemberManagementPanel.vue` 原样迁移）。
 *
 * 口径保持：管理员可发邀请、可调整成员角色与启停；成员用 **用户 ID** 定位，
 * 因为契约 `PATCH /api/organizations/:id/members/:userId` 就是这个形状。
 * 改成「按成员列表点选」需要新的产品口径（是否允许改自己、列表口径等），不在本批自决。
 */
import { computed, ref } from 'vue';

import { Button, Card, Input, message, Select, SelectOption } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'MemberManagementPanel' });

type MemberRole = 'admin' | 'finance' | 'operator';

const authStore = useAuthStore();

const email = ref('');
const inviteRole = ref<MemberRole>('operator');
const memberId = ref('');
const memberRole = ref<MemberRole>('operator');
const memberStatus = ref<'active' | 'disabled'>('active');
const invitationStatus = ref('');
const invitationExpiresAt = ref('');
const actionError = ref('');

const roleOptions = computed(() => [
  { label: $t('shell.role.admin'), value: 'admin' },
  { label: $t('shell.role.operator'), value: 'operator' },
  { label: $t('shell.role.finance'), value: 'finance' },
]);

const statusOptions = computed(() => [
  { label: $t('shell.workbench.memberActive'), value: 'active' },
  { label: $t('shell.workbench.memberDisabled'), value: 'disabled' },
]);

async function invite() {
  actionError.value = '';
  const result = await authStore.createInvitation(email.value, inviteRole.value);
  if (!result) {
    actionError.value = authStore.lastSessionError?.message ?? $t('shell.workbench.inviteFailed');
    return;
  }
  invitationStatus.value = result.status;
  invitationExpiresAt.value = result.expiresAt;
  email.value = '';
}

async function saveMember() {
  actionError.value = '';
  const saved = await authStore.updateMember(
    memberId.value.trim(),
    memberRole.value,
    memberStatus.value,
  );
  if (!saved) {
    actionError.value = authStore.lastSessionError?.message ?? $t('shell.workbench.memberUpdateFailed');
    return;
  }
  message.success($t('shell.workbench.memberUpdated'));
}
</script>

<template>
  <Card :title="$t('shell.workbench.membersTitle')">
    <p class="mb-4 text-sm text-muted-foreground">{{ $t('shell.workbench.membersHint') }}</p>

    <form class="grid max-w-xl gap-3" @submit.prevent="invite">
      <label class="text-sm" for="invite-email">{{ $t('shell.workbench.inviteEmail') }}</label>
      <Input
        id="invite-email"
        v-model:value.trim="email"
        aria-label="invite-email"
        :placeholder="$t('shell.workbench.inviteEmail')"
        type="email"
      />
      <label class="text-sm" for="invite-role">{{ $t('shell.workbench.inviteRole') }}</label>
      <Select id="invite-role" v-model:value="inviteRole" aria-label="invite-role">
        <SelectOption v-for="item in roleOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </SelectOption>
      </Select>
      <Button
        aria-label="send-invitation"
        :disabled="!email"
        html-type="submit"
        :loading="authStore.loginLoading"
        type="primary"
      >
        {{ $t('shell.workbench.sendInvitation') }}
      </Button>
    </form>

    <p v-if="invitationStatus" class="mt-3 text-sm" data-testid="invitation-status" role="status">
      {{ $t('shell.workbench.invitationSent') }}：{{ invitationStatus }} ·
      {{ invitationExpiresAt }}
    </p>

    <form class="mt-6 grid max-w-xl gap-3" @submit.prevent="saveMember">
      <label class="text-sm" for="member-id">{{ $t('shell.workbench.memberId') }}</label>
      <Input
        id="member-id"
        v-model:value.trim="memberId"
        aria-label="member-id"
        :placeholder="$t('shell.workbench.memberIdPlaceholder')"
      />
      <label class="text-sm" for="member-role">{{ $t('shell.workbench.memberRole') }}</label>
      <Select id="member-role" v-model:value="memberRole" aria-label="member-role">
        <SelectOption v-for="item in roleOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </SelectOption>
      </Select>
      <label class="text-sm" for="member-status">{{ $t('shell.workbench.memberStatus') }}</label>
      <Select id="member-status" v-model:value="memberStatus" aria-label="member-status">
        <SelectOption v-for="item in statusOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </SelectOption>
      </Select>
      <Button aria-label="update-member" :disabled="!memberId" html-type="submit">
        {{ $t('shell.workbench.updateMember') }}
      </Button>
    </form>

    <p v-if="actionError" class="mt-3 text-sm text-red-600" role="alert">{{ actionError }}</p>
  </Card>
</template>
