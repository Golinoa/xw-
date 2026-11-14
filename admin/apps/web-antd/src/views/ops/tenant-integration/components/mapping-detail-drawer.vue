<script lang="ts" setup>
import type { TenantErrorView } from '#/api/ops/tenant/errors';
import type {
  TenantCommand,
  TenantCommandType,
  TenantMapping,
  TenantMappingDetail,
} from '#/api/ops/tenant/types';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  canEditMappingExternalId,
  commandPermission,
  commandStatusView,
  commandTypeLabel,
  createCommand,
  createCommandIdempotencyKey,
  describeTenantError,
  errorCategoryView,
  fetchMapping,
  formatDateTime,
  mappingStatusView,
  updateMapping,
} from '#/api/ops/tenant';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';

import { describeAcceptedCommand } from '../command-feedback';
import { useCommandSubmission } from '../composables/use-command-submission';
import CommandDetailDrawer from './command-detail-drawer.vue';
import CommandFormModal from './command-form-modal.vue';

defineOptions({ name: 'TenantMappingDetailDrawer' });

/**
 * 映射详情抽屉：基本信息 + 当前 `sync_version` + 最近命令 + 命令下发入口。
 *
 * `sync_version` 是命令下发的前置条件，必须**显示出来**并原样带给后端；
 * 版本冲突（409 `SYNC_VERSION_CONFLICT`）后强制重新拉取，禁止本地覆盖。
 */
const props = defineProps<{
  mappingId: null | string;
  open: boolean;
}>();

const emit = defineEmits<{
  changed: [];
  'update:open': [boolean];
}>();

const { hasPermission } = useOpsPermission();

const detail = ref<null | TenantMappingDetail>(null);
const loading = ref(false);
const error = ref<null | TenantErrorView>(null);
/** 202 受理提示：只表示已受理。 */
const acceptedNotice = ref<null | string>(null);
/** 冲突后「已刷新、请基于最新版本重来」的提示（不是错误残留）。 */
const refreshNotice = ref<null | string>(null);

const mapping = computed<null | TenantMapping>(
  () => detail.value?.mapping ?? null,
);
const commands = computed<TenantCommand[]>(() => detail.value?.commands ?? []);

async function load() {
  if (!props.mappingId) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    detail.value = await fetchMapping(props.mappingId);
  } catch (error_: unknown) {
    detail.value = null;
    error.value = describeTenantError(error_);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.mappingId] as const,
  ([open]) => {
    if (open) {
      acceptedNotice.value = null;
      refreshNotice.value = null;
      void load();
    }
  },
  { immediate: true },
);

// ------------------------------------------------------------------ 命令入口

/** 命令类型与展示名（契约 §3.6 八种）。 */
const COMMAND_ACTIONS: { label: string; type: TenantCommandType }[] = [
  { label: '开通', type: 'provision' },
  { label: '绑定', type: 'bind' },
  { label: '激活', type: 'activate' },
  { label: '暂停', type: 'suspend' },
  { label: '恢复', type: 'resume' },
  { label: '同步权益', type: 'sync_entitlement' },
  { label: '延期', type: 'extend' },
  { label: '撤销', type: 'revoke' },
];

/** 按动作码显隐（无权限的入口不出现，避免「点了才报 403」）。 */
const visibleActions = computed(() =>
  COMMAND_ACTIONS.filter((action) =>
    hasPermission(commandPermission(action.type)),
  ),
);

const terminated = computed(
  () => mapping.value?.mappingStatus === 'terminated',
);

const submission = useCommandSubmission({
  create: ({ input, idempotencyKey, mappingId }) =>
    createCommand(mappingId, input, idempotencyKey),
});

function requestCommand(type: TenantCommandType, label: string) {
  const current = mapping.value;
  if (!current || terminated.value) {
    message.warning('映射已终止，不能再下发命令');
    return;
  }
  submission.openForm({
    commandType: type,
    expectedSyncVersion: current.syncVersion,
    label: `${label}租户`,
    mappingId: current.id,
    mappingNo: current.mappingNo,
  });
}

async function onCommandSubmit() {
  const result = await submission.submit();
  if (!result) {
    const view = submission.error.value;
    if (view?.shouldRefresh) {
      // 版本/唯一约束冲突：以服务端最新状态为准，重新拉详情，绝不本地改 syncVersion。
      await load();
      emit('changed');
      if (view.kind === 'conflict' || view.kind === 'validation') {
        // 本次命令未下发，继续用旧版本重试必然再冲突：关闭表单，让用户基于新版本重新发起。
        refreshNotice.value = `${view.title}：${view.description}`;
        submission.close();
      }
    }
    return;
  }
  acceptedNotice.value = describeAcceptedCommand(result);
  refreshNotice.value = null;
  message.info('已受理，结果待确认');
  await load();
  emit('changed');
}

// ------------------------------------------------------------------ 修改映射

const editOpen = ref(false);
const editOrgId = ref('');
const editExternalRef = ref('');
const editSubmitting = ref(false);
const editError = ref<null | TenantErrorView>(null);
const editIdempotencyKey = ref<null | string>(null);

const editDecision = computed(() =>
  canEditMappingExternalId({
    hasPermission: hasPermission(OPS_PERMISSION.TENANT_PROVISION),
    status: mapping.value?.mappingStatus ?? 'pending',
  }),
);

function requestEdit() {
  const current = mapping.value;
  if (!current) {
    return;
  }
  if (!editDecision.value.allowed) {
    message.warning(editDecision.value.message ?? '当前不可修改映射');
    return;
  }
  editOrgId.value = current.udoneOrganizationId;
  editExternalRef.value = current.externalRef ?? '';
  editError.value = null;
  editIdempotencyKey.value = createCommandIdempotencyKey();
  editOpen.value = true;
}

async function submitEdit() {
  const current = mapping.value;
  const key = editIdempotencyKey.value;
  if (!current || !key || editSubmitting.value) {
    return;
  }
  if (current.version === undefined) {
    editError.value = {
      accepted: false,
      canRetry: false,
      description:
        '映射缺少乐观锁版本（version），无法安全修改，请刷新后重试。',
      kind: 'validation',
      shouldRefresh: true,
      title: '缺少版本号',
    };
    return;
  }
  editSubmitting.value = true;
  editError.value = null;
  try {
    await updateMapping(
      current.id,
      {
        externalRef: editExternalRef.value.trim(),
        udoneOrganizationId: editOrgId.value.trim(),
        version: current.version,
      },
      key,
    );
    editOpen.value = false;
    message.success('映射已更新');
    await load();
    emit('changed');
  } catch (error_: unknown) {
    const view = describeTenantError(error_);
    editError.value = view;
    if (view.shouldRefresh) {
      await load();
    }
  } finally {
    editSubmitting.value = false;
  }
}

// ------------------------------------------------------------------ 命令详情

const commandOpen = ref(false);
const activeCommandId = ref<null | string>(null);

function openCommand(row: TenantCommand) {
  activeCommandId.value = row.id;
  commandOpen.value = true;
}

async function onCommandChanged() {
  await load();
  emit('changed');
}

const commandColumns = [
  { dataIndex: 'commandNo', key: 'commandNo', title: '命令编号', width: 170 },
  { dataIndex: 'commandType', key: 'commandType', title: '类型', width: 120 },
  { dataIndex: 'status', key: 'status', title: '状态', width: 120 },
  {
    dataIndex: 'attemptCount',
    key: 'attemptCount',
    title: '尝试次数',
    width: 96,
  },
  {
    dataIndex: 'lastErrorCategory',
    key: 'lastErrorCategory',
    title: '错误类别',
    width: 120,
  },
  { dataIndex: 'createdAt', key: 'createdAt', title: '创建时间', width: 150 },
  { key: 'actions', title: '操作', width: 100 },
];

function closeDrawer() {
  emit('update:open', false);
}
</script>

<template>
  <Drawer :open="open" :width="980" title="租户映射详情" @close="closeDrawer">
    <Spin :spinning="loading">
      <Alert
        v-if="error"
        data-testid="tenant-mapping-error"
        :message="error.title"
        show-icon
        type="error"
      >
        <template #description>
          <div class="space-y-1">
            <p>{{ error.description }}</p>
            <p v-if="error.requestId" class="text-xs">
              请求 ID：<span class="font-mono">{{ error.requestId }}</span>
            </p>
            <Button size="small" @click="load">重试</Button>
          </div>
        </template>
      </Alert>

      <Alert
        v-if="acceptedNotice"
        class="mb-3"
        data-testid="tenant-mapping-accepted-notice"
        :message="acceptedNotice"
        show-icon
        type="info"
      />

      <Alert
        v-if="refreshNotice"
        class="mb-3"
        closable
        data-testid="tenant-mapping-refresh-notice"
        :message="refreshNotice"
        show-icon
        type="warning"
        @close="refreshNotice = null"
      />

      <template v-if="mapping">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Tag :color="mappingStatusView(mapping.mappingStatus).color">
            {{ mappingStatusView(mapping.mappingStatus).label }}
          </Tag>
          <Tag color="blue">同步版本 v{{ mapping.syncVersion }}</Tag>
          <span class="text-sm text-muted-foreground">
            最近同步：{{ formatDateTime(mapping.lastSyncedAt) }}
          </span>
        </div>

        <Descriptions bordered :column="2" title="映射信息">
          <Descriptions.Item label="映射编号">
            {{ mapping.mappingNo }}
          </Descriptions.Item>
          <Descriptions.Item label="客户">
            {{ mapping.customer.name }}
          </Descriptions.Item>
          <Descriptions.Item label="产品 ID">
            {{ mapping.productId }}
          </Descriptions.Item>
          <Descriptions.Item label="外部租户 ID">
            <span class="font-mono text-xs">
              {{ mapping.udoneOrganizationId }}
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="客户环境标识">
            {{ mapping.externalRef ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="已知状态">
            {{ mapping.lastKnownState ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="同步版本">
            v{{ mapping.syncVersion }}
          </Descriptions.Item>
          <Descriptions.Item label="乐观锁版本">
            {{ mapping.version ?? '—' }}
          </Descriptions.Item>
          <Descriptions.Item label="最近同步时间">
            {{ formatDateTime(mapping.lastSyncedAt) }}
          </Descriptions.Item>
          <Descriptions.Item label="映射状态">
            {{ mappingStatusView(mapping.mappingStatus).label }}
          </Descriptions.Item>
        </Descriptions>

        <div class="mt-4">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium">下发命令</span>
            <span class="text-xs text-muted-foreground">
              异步执行，受理后请查看命令状态的尝试记录
            </span>
            <Button
              v-if="hasPermission(OPS_PERMISSION.TENANT_PROVISION)"
              class="ml-auto"
              size="small"
              @click="requestEdit"
            >
              修改外部租户 ID
            </Button>
          </div>

          <Alert
            v-if="terminated"
            message="映射已终止，不能再下发命令"
            show-icon
            type="warning"
          />
          <Alert
            v-else-if="visibleActions.length === 0"
            data-testid="tenant-command-permission-denied"
            message="无下发权限"
            show-icon
            type="warning"
          >
            <template #description>
              当前账号不具备 tenant.provision / tenant.suspend / tenant.restore
              / entitlement.execute 中任一下发动作码，只能查看映射与命令。
            </template>
          </Alert>
          <div v-else class="flex flex-wrap gap-2">
            <Button
              v-for="action in visibleActions"
              :key="action.type"
              :disabled="terminated"
              :data-testid="`tenant-command-${action.type}`"
              @click="requestCommand(action.type, action.label)"
            >
              {{ action.label }}
            </Button>
          </div>
        </div>

        <div class="mt-6">
          <h4 class="mb-2 font-medium">最近命令（最多 20 条）</h4>
          <Table
            :columns="commandColumns"
            :data-source="commands"
            :pagination="false"
            :row-key="(row: TenantCommand) => row.id"
            data-testid="tenant-mapping-commands"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'commandType'">
                {{ commandTypeLabel(record.commandType) }}
              </template>
              <template v-else-if="column.key === 'status'">
                <Tag :color="commandStatusView(record.status).color">
                  {{ commandStatusView(record.status).label }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'lastErrorCategory'">
                {{
                  record.lastErrorCategory
                    ? errorCategoryView(record.lastErrorCategory).label
                    : '—'
                }}
              </template>
              <template v-else-if="column.key === 'createdAt'">
                {{ formatDateTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'actions'">
                <Button
                  size="small"
                  type="link"
                  @click="openCommand(record as TenantCommand)"
                >
                  详情
                </Button>
              </template>
            </template>
            <template #emptyText>
              <Empty description="该映射还没有下发过命令" />
            </template>
          </Table>
        </div>
      </template>
      <Empty v-else-if="!loading && !error" description="未找到映射" />
    </Spin>

    <CommandFormModal
      :acknowledged="submission.acknowledged.value"
      :acknowledged-error="submission.acknowledgedError.value"
      :command-type="submission.context.value?.commandType ?? 'provision'"
      :error="submission.error.value"
      :expected-sync-version="submission.context.value?.expectedSyncVersion"
      :high-risk="submission.highRisk.value"
      :idempotency-key="submission.idempotencyKey.value"
      :label="submission.context.value?.label ?? '下发命令'"
      :mapping-no="submission.context.value?.mappingNo"
      :open="submission.open.value"
      :reason="submission.reason.value"
      :reason-error="submission.reasonError.value"
      :submitting="submission.submitting.value"
      @confirm="onCommandSubmit"
      @update:acknowledged="submission.setAcknowledged($event)"
      @update:open="submission.open.value = $event"
      @update:reason="submission.setReason($event)"
    />

    <CommandDetailDrawer
      v-model:open="commandOpen"
      :command-id="activeCommandId"
      @changed="onCommandChanged"
    />

    <Modal
      v-model:open="editOpen"
      :confirm-loading="editSubmitting"
      :mask-closable="false"
      ok-text="保存修改"
      title="修改映射外部标识"
      @ok="submitEdit"
    >
      <div class="space-y-3">
        <Alert
          message="只有「待开通」的映射允许改外部租户 ID；已开通后改动会与 udone 侧数据错位。"
          show-icon
          type="info"
        />
        <div>
          <div class="mb-1 text-xs text-muted-foreground">外部租户 ID</div>
          <Input v-model:value="editOrgId" placeholder="udone 组织 UUID" />
        </div>
        <div>
          <div class="mb-1 text-xs text-muted-foreground">客户环境标识</div>
          <Input
            v-model:value="editExternalRef"
            placeholder="如 example-prod"
          />
        </div>
        <Alert
          v-if="editError"
          :message="editError.title"
          show-icon
          type="error"
        >
          <template #description>
            <p>{{ editError.description }}</p>
          </template>
        </Alert>
      </div>
    </Modal>
  </Drawer>
</template>
