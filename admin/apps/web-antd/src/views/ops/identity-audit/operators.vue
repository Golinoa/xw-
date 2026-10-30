<script lang="ts" setup>
/**
 * 账号与角色（identity-audit 域）。
 *
 * 覆盖状态：loading / empty / error / permission-denied / validation / conflict /
 * state-conflict / 高风险确认（弹窗本身即确认步骤）。
 *
 * 页面职责边界：
 * - 成员与角色是同一个权限模型的两半（成员持角色、角色含动作码），放在一页便于对照；
 * - 所有写操作都要填 `reason`、写审计、带幂等键（`operator.manage` / `role.manage`
 *   都是高风险动作，契约 §4）；
 * - 409 分两种：**版本冲突**（刷新后重试通常能成）与**规则拒绝**
 *   （`LAST_ROLE` / `LAST_ADMIN`，重试仍会被拒）。提示必须区分，
 *   否则运营会反复点同一个被规则挡住的按钮。
 */
import type {
  CreateRolePayload,
  IdentityErrorView,
  InviteOperatorPayload,
  OpsOperatorListItem,
  OpsPermissionItem,
  OpsRoleDetail,
  UpdateOperatorPayload,
  UpdateRolePayload,
} from '#/api/ops/identity';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  Alert,
  Button,
  Card,
  Input,
  message,
  Select,
  Space,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  createIdempotencyKey,
  createRole,
  describeIdentityError,
  fetchOperators,
  fetchOpsPermissions,
  fetchRoles,
  formatDateTime,
  inviteOperator,
  operatorStatusView,
  updateOperator,
  updateRole,
} from '#/api/ops/identity';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import OperatorEditModal from './components/operator-edit-modal.vue';
import OperatorInviteModal from './components/operator-invite-modal.vue';
import RoleFormModal from './components/role-form-modal.vue';
import { diffPermissions, operatorEditGuard } from './governance';

defineOptions({ name: 'GovernanceOperators' });

const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.OPERATOR_READ));
const canManageOperator = computed(() =>
  hasPermission(OPS_PERMISSION.OPERATOR_MANAGE),
);
const canManageRole = computed(() => hasPermission(OPS_PERMISSION.ROLE_MANAGE));

/* ---------------------------- 成员列表 ---------------------------- */

const memberFilters = reactive<{
  keyword: string;
  roleCode: string | undefined;
  status: 'active' | 'disabled' | 'invited' | undefined;
}>({ keyword: '', roleCode: undefined, status: undefined });

const members = ref<OpsOperatorListItem[]>([]);
const membersLoading = ref(false);
const membersError = ref<IdentityErrorView | null>(null);

const memberStatusOptions = [
  { label: '启用', value: 'active' },
  { label: '待接受邀请', value: 'invited' },
  { label: '已停用', value: 'disabled' },
];

const memberColumns = [
  { dataIndex: 'displayName', key: 'displayName', title: '成员', width: 240 },
  { dataIndex: 'email', key: 'email', title: '邮箱', width: 240 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 130 },
  { dataIndex: 'roles', key: 'roles', title: '角色', width: 240 },
  {
    dataIndex: 'lastLoginAt',
    key: 'lastLoginAt',
    title: '最近登录',
    width: 170,
  },
  { key: 'version', title: '版本', width: 90 },
  { key: 'actions', title: '操作', width: 100 },
];

async function loadMembers() {
  if (!canRead.value) {
    return;
  }
  membersLoading.value = true;
  membersError.value = null;
  try {
    const result = await fetchOperators({
      keyword: memberFilters.keyword.trim() || undefined,
      roleCode: memberFilters.roleCode,
      status: memberFilters.status,
    });
    members.value = result.items;
  } catch (error_) {
    membersError.value = describeIdentityError(error_);
    members.value = [];
  } finally {
    membersLoading.value = false;
  }
}

function resetMemberFilters() {
  memberFilters.keyword = '';
  memberFilters.roleCode = undefined;
  memberFilters.status = undefined;
  void loadMembers();
}

/* ---------------------------- 角色列表 ---------------------------- */

const roles = ref<OpsRoleDetail[]>([]);
const rolesLoading = ref(false);
const rolesError = ref<IdentityErrorView | null>(null);
const catalog = ref<OpsPermissionItem[]>([]);

const roleColumns = [
  { dataIndex: 'name', key: 'name', title: '角色', width: 320 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 100 },
  { key: 'isSystem', title: '类型', width: 110 },
  { key: 'permissions', title: '权限数', width: 100 },
  { key: 'actions', title: '操作', width: 100 },
];

async function loadRoles() {
  if (!canRead.value) {
    return;
  }
  rolesLoading.value = true;
  rolesError.value = null;
  try {
    const [rolePage, permissionCatalog] = await Promise.all([
      fetchRoles(),
      // 目录失败不该让整个角色列表空白：单独降级，选择器会自己给出说明。
      fetchOpsPermissions().catch(() => ({ items: [] as OpsPermissionItem[] })),
    ]);
    roles.value = rolePage.items;
    catalog.value = permissionCatalog.items;
  } catch (error_) {
    rolesError.value = describeIdentityError(error_);
    roles.value = [];
  } finally {
    rolesLoading.value = false;
  }
}

const roleOptions = computed(() =>
  roles.value.map((role) => ({ label: role.name, value: role.code })),
);

/* ---------------------------- 邀请成员 ---------------------------- */

const inviteState = reactive<{
  error: IdentityErrorView | null;
  open: boolean;
  submitting: boolean;
}>({ error: null, open: false, submitting: false });

/** 幂等键在**打开弹窗时**生成一次并持有到提交结束：连点两次不会变成两条记录。 */
let inviteKey = '';

function openInvite() {
  inviteKey = createIdempotencyKey();
  inviteState.error = null;
  inviteState.open = true;
}

async function submitInvite(payload: InviteOperatorPayload) {
  inviteState.submitting = true;
  inviteState.error = null;
  try {
    const result = await inviteOperator(payload, inviteKey);
    inviteState.open = false;
    // 说「邀请已发出」而不是「已开通」：对方还要自己完成注册。
    message.success(
      `邀请已发出（成员 ${result.operator.id.slice(0, 8)}…），对方需完成注册后才能登录`,
    );
    await loadMembers();
  } catch (error_) {
    inviteState.error = describeIdentityError(error_);
  } finally {
    inviteState.submitting = false;
  }
}

/* ---------------------------- 编辑成员 ---------------------------- */

const editState = reactive<{
  error: IdentityErrorView | null;
  open: boolean;
  operator: null | OpsOperatorListItem;
  submitting: boolean;
}>({ error: null, open: false, operator: null, submitting: false });

let editKey = '';

function openEdit(row: OpsOperatorListItem) {
  editKey = createIdempotencyKey();
  editState.operator = row;
  editState.error = null;
  editState.open = true;
}

async function submitEdit(payload: UpdateOperatorPayload) {
  const target = editState.operator;
  if (!target) {
    return;
  }
  editState.submitting = true;
  editState.error = null;
  try {
    const result = await updateOperator(target.id, payload, editKey);
    editState.open = false;
    editState.operator = null;
    const changed = result.permissionsChanged;
    message.success(
      changed.added.length + changed.removed.length > 0
        ? `已保存：新增 ${changed.added.length} 项权限、移除 ${changed.removed.length} 项`
        : '已保存成员变更',
    );
    await loadMembers();
  } catch (error_) {
    const view = describeIdentityError(error_);
    editState.error = view;
    // 版本冲突：立刻刷新列表，让「刷新」真的刷新了；不自动重提。
    if (view.shouldRefresh) {
      await loadMembers();
    }
  } finally {
    editState.submitting = false;
  }
}

/** 冲突后点「立即刷新」：重取列表并把最新一行回填进弹窗，同时换新幂等键。 */
async function refreshAfterConflict() {
  await loadMembers();
  const latest = members.value.find(
    (item) => item.id === editState.operator?.id,
  );
  if (latest) {
    editState.operator = latest;
    editKey = createIdempotencyKey();
    editState.error = null;
    message.info('已刷新到最新数据，请重新确认后提交');
  }
}

/* ---------------------------- 角色编辑 ---------------------------- */

const roleState = reactive<{
  error: IdentityErrorView | null;
  mode: 'create' | 'edit';
  open: boolean;
  role: null | OpsRoleDetail;
  submitting: boolean;
}>({ error: null, mode: 'create', open: false, role: null, submitting: false });

let roleKey = '';

function openCreateRole() {
  roleKey = createIdempotencyKey();
  roleState.mode = 'create';
  roleState.role = null;
  roleState.error = null;
  roleState.open = true;
}

function openEditRole(role: OpsRoleDetail) {
  roleKey = createIdempotencyKey();
  roleState.mode = 'edit';
  roleState.role = role;
  roleState.error = null;
  roleState.open = true;
}

async function submitRole(payload: {
  code?: string;
  description?: string;
  name: string;
  permissionCodes: string[];
  reason: string;
  status?: 'active' | 'disabled';
}) {
  roleState.submitting = true;
  roleState.error = null;
  try {
    if (roleState.mode === 'create') {
      const createPayload: CreateRolePayload = {
        code: payload.code ?? '',
        name: payload.name,
        permissionCodes: payload.permissionCodes,
      };
      if (payload.description) {
        createPayload.description = payload.description;
      }
      await createRole(createPayload, roleKey);
      message.success('角色已创建');
    } else if (roleState.role) {
      const updatePayload: UpdateRolePayload = {
        name: payload.name,
        permissionCodes: payload.permissionCodes,
        reason: payload.reason,
      };
      if (payload.description !== undefined) {
        updatePayload.description = payload.description;
      }
      if (payload.status) {
        updatePayload.status = payload.status;
      }
      const result = await updateRole(
        roleState.role.id,
        updatePayload,
        roleKey,
      );
      const diff = diffPermissions(
        result.beforePermissions,
        result.afterPermissions,
      );
      message.success(
        diff.added.length + diff.removed.length > 0
          ? `已保存：新增 ${diff.added.length} 项、移除 ${diff.removed.length} 项权限`
          : '已保存角色信息（权限未变更）',
      );
    }
    roleState.open = false;
    // 角色权限变了，成员的「权限预览」也会变，两个列表一起刷新。
    await Promise.all([loadRoles(), loadMembers()]);
  } catch (error_) {
    roleState.error = describeIdentityError(error_);
  } finally {
    roleState.submitting = false;
  }
}

/* ---------------------------- 展示辅助 ---------------------------- */

function asOperator(record: Record<string, unknown>): OpsOperatorListItem {
  return record as unknown as OpsOperatorListItem;
}

function asRole(record: Record<string, unknown>): OpsRoleDetail {
  return record as unknown as OpsRoleDetail;
}

function editBlockedReason(row: OpsOperatorListItem): null | string {
  const guard = operatorEditGuard(row);
  return guard.editable ? null : (guard.hint ?? null);
}

const blockedCount = computed(
  () => members.value.filter((row) => !operatorEditGuard(row).editable).length,
);

onMounted(() => {
  void loadMembers();
  void loadRoles();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.OPERATOR_READ]"
      title="账号与角色"
    />

    <template v-else>
      <Card title="运营成员">
        <template #extra>
          <Space>
            <span class="text-xs text-muted-foreground">
              邀请发到邮箱，对方需自行注册
            </span>
            <Button v-if="canManageOperator" type="primary" @click="openInvite">
              邀请成员
            </Button>
          </Space>
        </template>

        <div class="mb-4 flex flex-wrap items-end gap-3">
          <Input
            v-model:value="memberFilters.keyword"
            allow-clear
            class="w-56"
            placeholder="搜索姓名或邮箱"
            @press-enter="loadMembers"
          />
          <Select
            v-model:value="memberFilters.status"
            allow-clear
            class="w-40"
            :options="memberStatusOptions"
            placeholder="状态"
            @change="loadMembers"
          />
          <Select
            v-model:value="memberFilters.roleCode"
            allow-clear
            class="w-48"
            :options="roleOptions"
            placeholder="按角色筛选"
            @change="loadMembers"
          />
          <Button @click="loadMembers">查询</Button>
          <Button type="text" @click="resetMemberFilters">重置</Button>
        </div>

        <Alert
          v-if="blockedCount > 0"
          class="mb-3"
          :message="`有 ${blockedCount} 个成员缺少乐观锁版本（version），暂不可修改`"
          description="PATCH /operators/{operatorId} 要求 version 必填，但列表项未返回该字段。为防止用旧数据覆盖他人改动，这些成员的编辑入口已禁用。"
          show-icon
          type="warning"
        />

        <OpsErrorAlert
          v-if="membersError"
          :message="membersError.description"
          :request-id="membersError.requestId"
          @retry="loadMembers"
        />

        <Table
          row-key="id"
          size="middle"
          :columns="memberColumns"
          :data-source="members"
          :loading="membersLoading"
          :pagination="false"
          :scroll="{ x: 1280 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'displayName'">
              <div class="font-medium">{{ record.displayName }}</div>
              <div class="font-mono text-xs text-muted-foreground">
                {{ record.id }}
              </div>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="operatorStatusView(record.status).color">
                {{ operatorStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'roles'">
              <Tag
                v-for="role in record.roles"
                :key="role.code"
                class="mb-1"
                color="blue"
              >
                {{ role.name }}
              </Tag>
              <span
                v-if="!record.roles || record.roles.length === 0"
                class="text-xs text-muted-foreground"
              >
                无角色（异常数据）
              </span>
            </template>
            <template v-else-if="column.key === 'lastLoginAt'">
              {{
                record.lastLoginAt
                  ? formatDateTime(record.lastLoginAt)
                  : '从未登录'
              }}
            </template>
            <template v-else-if="column.key === 'version'">
              <span
                v-if="typeof record.version === 'number'"
                class="font-mono text-xs"
              >
                {{ record.version }}
              </span>
              <Tag v-else color="red">未返回</Tag>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                v-if="canManageOperator"
                size="small"
                type="link"
                :disabled="Boolean(editBlockedReason(asOperator(record)))"
                :title="editBlockedReason(asOperator(record)) ?? ''"
                @click="openEdit(asOperator(record))"
              >
                编辑
              </Button>
              <span v-else class="text-xs text-muted-foreground">只读</span>
            </template>
          </template>

          <template #emptyText>
            <div class="py-8 text-center">
              <p class="text-sm text-muted-foreground">
                没有符合条件的运营成员。
              </p>
              <p class="mt-1 text-xs text-muted-foreground">
                运营账号不能自助注册，只能由具备 operator.manage 的成员邀请。
              </p>
            </div>
          </template>
        </Table>
      </Card>

      <Card class="mt-4" title="角色与权限">
        <template #extra>
          <Space>
            <span class="text-xs text-muted-foreground">
              多角色按动作码并集生效
            </span>
            <Button v-if="canManageRole" @click="openCreateRole">
              新建角色
            </Button>
          </Space>
        </template>

        <OpsErrorAlert
          v-if="rolesError"
          :message="rolesError.description"
          :request-id="rolesError.requestId"
          @retry="loadRoles"
        />

        <Alert
          v-if="catalog.length === 0 && !rolesError"
          class="mb-3"
          message="未能加载权限目录（GET /permissions 需要 operator.read），角色权限暂不可编辑"
          show-icon
          type="info"
        />

        <Table
          row-key="id"
          size="middle"
          :columns="roleColumns"
          :data-source="roles"
          :loading="rolesLoading"
          :pagination="false"
          :scroll="{ x: 900 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div class="font-medium">{{ record.name }}</div>
              <div class="font-mono text-xs text-muted-foreground">
                {{ record.code }}
              </div>
              <div
                v-if="record.description"
                class="mt-1 max-w-96 text-xs text-muted-foreground"
              >
                {{ record.description }}
              </div>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="record.status === 'active' ? 'green' : 'default'">
                {{ record.status === 'active' ? '启用' : '停用' }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'isSystem'">
              <Tag v-if="record.isSystem" color="purple">系统角色</Tag>
              <Tag v-else>自定义</Tag>
            </template>
            <template v-else-if="column.key === 'permissions'">
              {{ record.permissions.length }} 项
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                v-if="canManageRole"
                size="small"
                type="link"
                @click="openEditRole(asRole(record))"
              >
                编辑
              </Button>
              <span v-else class="text-xs text-muted-foreground">只读</span>
            </template>
          </template>
        </Table>

        <p class="mt-3 text-xs text-muted-foreground">
          系统角色不可修改
          code、不可删除（服务端拒绝）；停用角色后，持有该角色的成员
          立即失去对应动作码——权限在每个请求上重新判定，不缓存在 token 里。
        </p>
      </Card>

      <OperatorInviteModal
        :error="inviteState.error"
        :open="inviteState.open"
        :roles="roles"
        :submitting="inviteState.submitting"
        @cancel="inviteState.open = false"
        @submit="submitInvite"
      />

      <OperatorEditModal
        :error="editState.error"
        :open="editState.open"
        :operator="editState.operator"
        :roles="roles"
        :submitting="editState.submitting"
        @cancel="editState.open = false"
        @refresh="refreshAfterConflict"
        @submit="submitEdit"
      />

      <RoleFormModal
        :catalog="catalog"
        :error="roleState.error"
        :mode="roleState.mode"
        :open="roleState.open"
        :role="roleState.role"
        :submitting="roleState.submitting"
        @cancel="roleState.open = false"
        @submit="submitRole"
      />
    </template>
  </div>
</template>
