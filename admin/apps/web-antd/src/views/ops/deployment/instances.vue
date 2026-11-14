<script lang="ts" setup>
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';

import type {
  DeploymentErrorView,
  DeploymentInstance,
  DeploymentInstanceStatus,
  DeploymentListQuery,
  DeploymentType,
} from '#/api/ops/deployment';

import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  Select,
  Table,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  actorName,
  createDeployment,
  DEPLOYMENT_TYPE_OPTIONS,
  deploymentTypeLabel,
  describeDeploymentError,
  fetchDeployments,
  formatDateTime,
  INSTANCE_STATUS_OPTIONS,
  instanceStatusView,
  maintenanceStateView,
  versionText,
} from '#/api/ops/deployment';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import DevDataNotice from '#/views/ops/billing/components/dev-data-notice.vue';

import CreateInstanceModal from './components/create-instance-modal.vue';
import { useServerToday } from './composables/use-server-today';

defineOptions({ name: 'DeploymentInstances' });

/**
 * 私有化部署实例列表（PRD §6.8 / 契约 §3.7、§5.8）。
 *
 * - 分页与筛选全部走服务端（`customerId` / `status[]` / `currentVersion` /
 *   `maintenanceUntilBefore` / `deploymentType` / `productId`），不在浏览器全量过滤；
 * - 状态列只读：状态推进只能进详情走 `transition`（契约 §3.7 状态机）；
 * - 无 `deployment.read` 时不渲染任何实例数据（含版本、维护期、负责人）。
 */
const router = useRouter();
const { hasPermission } = useOpsPermission();

const canRead = computed(() => hasPermission(OPS_PERMISSION.DEPLOYMENT_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.DEPLOYMENT_WRITE));

const rows = ref<DeploymentInstance[]>([]);
const loading = ref(false);
const loadError = shallowRef<DeploymentErrorView | null>(null);
const pagination = reactive({ page: 1, pageSize: 15, total: 0 });
const filters = reactive({
  currentVersion: '',
  customerId: '',
  deploymentType: undefined as DeploymentType | undefined,
  productId: '',
  status: [] as DeploymentInstanceStatus[],
});
const maintenanceBefore = ref<Dayjs | undefined>();

/** 维护期判定的「今天」来自服务端（`/meta.serverTime`），不读浏览器时钟。 */
const {
  failed: serverTodayFailed,
  load: loadServerToday,
  today,
} = useServerToday();

const columns: TableColumnsType = [
  { dataIndex: 'instanceNo', key: 'instanceNo', title: '实例编号', width: 160 },
  { dataIndex: 'name', key: 'name', title: '实例名称', width: 230 },
  { dataIndex: 'customer', key: 'customer', title: '客户', width: 200 },
  {
    dataIndex: 'deploymentType',
    key: 'deploymentType',
    title: '环境类型',
    width: 130,
  },
  {
    dataIndex: 'currentVersion',
    key: 'currentVersion',
    title: '当前版本',
    width: 120,
  },
  { dataIndex: 'status', key: 'status', title: '状态', width: 100 },
  { dataIndex: 'maintenance', key: 'maintenance', title: '维护期', width: 190 },
  {
    dataIndex: 'lastVersionRecordAt',
    key: 'lastVersionRecordAt',
    title: '最后上报时间',
    width: 160,
  },
  { dataIndex: 'owner', key: 'owner', title: '负责人', width: 150 },
  { key: 'actions', title: '操作', width: 90 },
];

function buildQuery(): DeploymentListQuery {
  return {
    currentVersion: filters.currentVersion.trim() || undefined,
    customerId: filters.customerId.trim() || undefined,
    deploymentType: filters.deploymentType,
    maintenanceUntilBefore: maintenanceBefore.value?.format('YYYY-MM-DD'),
    order: 'desc',
    page: pagination.page,
    pageSize: pagination.pageSize,
    productId: filters.productId.trim() || undefined,
    sort: 'createdAt',
    status: filters.status.length > 0 ? filters.status : undefined,
  };
}

async function load(): Promise<void> {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchDeployments(buildQuery());
    rows.value = result.items;
    pagination.total = result.total;
  } catch (error: unknown) {
    rows.value = [];
    pagination.total = 0;
    loadError.value = describeDeploymentError(error);
  } finally {
    loading.value = false;
  }
}

function onSearch(): void {
  pagination.page = 1;
  void load();
}

function onReset(): void {
  filters.currentVersion = '';
  filters.customerId = '';
  filters.deploymentType = undefined;
  filters.productId = '';
  filters.status = [];
  maintenanceBefore.value = undefined;
  pagination.page = 1;
  void load();
}

function onTableChange(next: TablePaginationConfig): void {
  pagination.page = next.current ?? 1;
  pagination.pageSize = next.pageSize ?? 15;
  void load();
}

function maintenanceView(row: DeploymentInstance) {
  return maintenanceStateView({
    maintenanceUntil: row.maintenanceUntil,
    referenceDate: today.value,
  });
}

function openDetail(row: DeploymentInstance): void {
  void router.push({
    name: 'DeploymentInstanceDetail',
    params: { deploymentId: row.id },
  });
}

// ------------------------------------------------------------------ 新建

const createOpen = ref(false);
const creating = ref(false);
const createError = shallowRef<DeploymentErrorView | null>(null);

async function onCreate(input: Parameters<typeof createDeployment>[0]) {
  creating.value = true;
  createError.value = null;
  try {
    await createDeployment(input);
    createOpen.value = false;
    await load();
  } catch (error: unknown) {
    // 409（同客户同名）/ 400 由错误视图接管；关闭弹窗后需刷新列表再看最新数据
    createError.value = describeDeploymentError(error);
    if (createError.value.shouldRefresh) {
      await load();
    }
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  void loadServerToday();
  void load();
});
</script>

<template>
  <div class="p-5">
    <DevDataNotice />

    <Alert
      v-if="!canRead"
      data-testid="deployment-permission-denied"
      description="当前账号缺少 deployment.read 动作码。按最小可见原则，本页不展示任何实例、版本、维护期或负责人信息。如需开通请联系运营管理员。"
      message="无查看部署台账权限"
      show-icon
      type="error"
    />

    <template v-else>
      <Card class="mb-3">
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-xs text-muted-foreground">客户 ID</div>
            <Input
              v-model:value="filters.customerId"
              allow-clear
              placeholder="按客户 ID 精确筛选"
              style="width: 180px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">环境类型</div>
            <Select
              v-model:value="filters.deploymentType"
              :options="DEPLOYMENT_TYPE_OPTIONS"
              allow-clear
              placeholder="全部类型"
              style="width: 150px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">状态</div>
            <Select
              v-model:value="filters.status"
              :options="INSTANCE_STATUS_OPTIONS"
              mode="multiple"
              placeholder="全部状态"
              style="width: 210px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">当前版本</div>
            <Input
              v-model:value="filters.currentVersion"
              allow-clear
              placeholder="如 v1.2.3（精确匹配）"
              style="width: 160px"
            />
          </div>
          <div>
            <div class="mb-1 text-xs text-muted-foreground">维护期到期日 ≤</div>
            <DatePicker v-model:value="maintenanceBefore" />
          </div>
          <div>
            <div
              class="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
            >
              <span>产品 ID</span>
              <Tooltip
                title="契约 §5.8 未列该筛选项：按实例关联授权推导，需服务端支持；后端未支持时该条件不生效，请以客户+版本筛选为准"
              >
                <span class="cursor-help">（契约推导）</span>
              </Tooltip>
            </div>
            <Input
              v-model:value="filters.productId"
              allow-clear
              placeholder="按授权所属产品筛选"
              style="width: 180px"
            />
          </div>
          <Button type="primary" @click="onSearch">查询</Button>
          <Button @click="onReset">重置</Button>
          <div class="ml-auto">
            <Tooltip
              v-if="!canWrite"
              title="缺少 deployment.write，不能创建实例"
            >
              <span>
                <Button disabled>新建实例</Button>
              </span>
            </Tooltip>
            <Button v-else ghost type="primary" @click="createOpen = true">
              新建实例
            </Button>
          </div>
        </div>
      </Card>

      <Alert
        v-if="serverTodayFailed"
        class="mb-3"
        data-testid="deployment-server-date-missing"
        message="未取到服务端业务日期，维护期状态暂不判定（不会用本机时钟推断到期，避免误报）。列表数据本身不受影响。"
        show-icon
        type="warning"
      />

      <Card>
        <Alert
          v-if="loadError"
          class="mb-3"
          data-testid="deployment-list-error"
          :message="loadError.title"
          show-icon
          type="error"
        >
          <template #description>
            <div class="space-y-1">
              <p>{{ loadError.description }}</p>
              <p v-if="loadError.requestId" class="text-xs">
                请求 ID：<span class="font-mono">{{
                  loadError.requestId
                }}</span>
              </p>
              <Button size="small" @click="load">重试</Button>
            </div>
          </template>
        </Alert>

        <Table
          :columns="columns"
          :data-source="rows"
          :loading="loading"
          :pagination="{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            showSizeChanger: true,
            showTotal: (total: number) => `共 ${total} 条`,
          }"
          :row-key="(row: DeploymentInstance) => row.id"
          :scroll="{ x: 1500 }"
          size="middle"
          @change="onTableChange"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <span class="font-medium">{{ record.name }}</span>
            </template>
            <template v-else-if="column.key === 'customer'">
              {{ record.customer?.name ?? '—' }}
            </template>
            <template v-else-if="column.key === 'deploymentType'">
              {{ deploymentTypeLabel(record.deploymentType) }}
            </template>
            <template v-else-if="column.key === 'currentVersion'">
              <span class="font-mono text-xs">
                {{ versionText(record.currentVersion) }}
              </span>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag :color="instanceStatusView(record.status).color">
                {{ instanceStatusView(record.status).label }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'maintenance'">
              <div class="space-y-1">
                <Tag
                  :color="maintenanceView(record as DeploymentInstance).color"
                >
                  {{ maintenanceView(record as DeploymentInstance).label }}
                </Tag>
                <div class="text-xs text-muted-foreground">
                  <span
                    v-if="
                      maintenanceView(record as DeploymentInstance)
                        .daysRemaining !== null
                    "
                  >
                    {{
                      (maintenanceView(record as DeploymentInstance)
                        .daysRemaining ?? 0) >= 0
                        ? `剩余 ${maintenanceView(record as DeploymentInstance).daysRemaining} 天`
                        : `已逾期 ${Math.abs(maintenanceView(record as DeploymentInstance).daysRemaining ?? 0)} 天`
                    }}
                    ·
                  </span>
                  {{ record.maintenanceUntil || '维护期未登记' }}
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'lastVersionRecordAt'">
              <Tooltip
                title="契约 §3.7 无独立心跳/上报列：此处为最近一条版本升级记录的登记时间（契约推导）。为空表示尚未登记过升级。"
              >
                {{ formatDateTime(record.lastVersionRecordAt) }}
              </Tooltip>
            </template>
            <template v-else-if="column.key === 'owner'">
              {{ actorName(record.owner ?? null) }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as DeploymentInstance)"
              >
                详情
              </Button>
            </template>
          </template>
          <template #emptyText>
            <Empty description="当前筛选条件下没有部署实例" />
          </template>
        </Table>

        <p class="mt-2 text-xs text-muted-foreground">
          维护期决定「是否包含版本升级与技术支持」：永久授权只表示软件使用无到期日，
          不等于永久更新（PRD
          §6.6）。维护期判定使用服务端业务日期（Asia/Shanghai）。
        </p>
      </Card>
    </template>

    <CreateInstanceModal
      v-model:open="createOpen"
      :error="createError"
      :submitting="creating"
      @submit="onCreate"
    />
  </div>
</template>
