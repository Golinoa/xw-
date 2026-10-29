<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const email = ref('');
const inviteRole = ref<'admin' | 'operator' | 'finance'>('operator');
const memberId = ref('');
const memberRole = ref<'admin' | 'operator' | 'finance'>('operator');
const memberStatus = ref<'active' | 'disabled'>('active');
const invitationStatus = ref('');
const invitationExpiresAt = ref('');
const actionError = ref('');

async function invite() {
  actionError.value = '';
  const result = await auth.createInvitation(email.value, inviteRole.value);
  if (!result) {
    actionError.value = auth.error.value;
    return;
  }
  invitationStatus.value = result.status;
  invitationExpiresAt.value = result.expiresAt;
  email.value = '';
}

async function saveMember() {
  actionError.value = '';
  const saved = await auth.updateMember(
    memberId.value.trim(),
    memberRole.value,
    memberStatus.value,
  );
  if (!saved) actionError.value = auth.error.value;
  else actionError.value = '成员权限已更新';
}
</script>

<template>
  <section aria-labelledby="member-management-title" class="member-management">
    <h3 id="member-management-title">成员与邀请</h3>
    <form @submit.prevent="invite">
      <label for="invite-email">邀请邮箱</label>
      <input id="invite-email" v-model.trim="email" type="email" required />
      <label for="invite-role">分配角色</label>
      <select id="invite-role" v-model="inviteRole" aria-label="分配角色">
        <option value="admin">管理员</option>
        <option value="operator">业务操作员</option>
        <option value="finance">财务</option>
      </select>
      <button type="submit" :disabled="auth.loading.value">发送邀请</button>
    </form>
    <p v-if="invitationStatus" role="status">
      邀请状态：{{ invitationStatus }}，有效期至
      {{ new Date(invitationExpiresAt).toLocaleString() }}
    </p>
    <form class="member-update" @submit.prevent="saveMember">
      <label for="member-id">成员用户 ID</label>
      <input id="member-id" v-model.trim="memberId" required />
      <label for="member-role">成员角色</label>
      <select id="member-role" v-model="memberRole" aria-label="成员角色">
        <option value="admin">管理员</option>
        <option value="operator">业务操作员</option>
        <option value="finance">财务</option>
      </select>
      <label for="member-status">成员状态</label>
      <select id="member-status" v-model="memberStatus" aria-label="成员状态">
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <button type="submit">更新成员</button>
    </form>
    <p v-if="actionError" :role="actionError.includes('已更新') ? 'status' : 'alert'">
      {{ actionError }}
    </p>
  </section>
</template>

<style scoped>
.member-management form {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.member-update {
  margin-top: 1.5rem;
}
</style>
