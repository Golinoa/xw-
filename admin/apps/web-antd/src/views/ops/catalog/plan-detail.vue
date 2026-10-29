<script lang="ts" setup>
import type { OpsApiError } from '#/api/adapter/errors';
/**
 * 套餐详情：套餐头、权益（功能键）、价格版本历史与启停。
 *
 * 价格版本只读 + 追加（契约 §3.2 仅 INSERT）：页面不提供改价/删版入口，
 * 改价必须新增版本，且只影响新合同。
 */
import type { PackageDetail, PackagePriceVersion } from '#/api/ops/catalog';

import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  Button,
  Card,
  DatePicker,
  Form,
  FormItem,
  Input,
  InputNumber,
  message,
  Modal,
  Result,
  Space,
  Spin,
  Table,
  Tag,
} from 'ant-design-vue';

import { toOpsApiError } from '#/api/adapter/errors';
import {
  createPackagePriceVersion,
  fetchPackage,
  fetchPackagePriceVersions,
  transitionPackage,
} from '#/api/ops/catalog';
import { OPS_PERMISSION } from '#/constants/permissions';
import { useOpsPermission } from '#/views/ops/_shared/use-ops-permission';
import OpsDevDataNotice from '#/views/ops/customer/components/ops-dev-data-notice.vue';
import OpsErrorAlert from '#/views/ops/customer/components/ops-error-alert.vue';
import OpsPermissionDenied from '#/views/ops/customer/components/ops-permission-denied.vue';

import PriceVersionPanel from './components/price-version-panel.vue';
import {
  AMOUNT_MAX,
  BILLING_TYPE_LABEL,
  enumLabel,
  FEATURE_APPLIES_TO_LABEL,
  formatDate,
  formatMoney,
  PACKAGE_STATUS_COLOR,
  PACKAGE_STATUS_LABEL,
  priceVersionLabel,
  SALES_MODE_LABEL,
} from './format';

defineOptions({ name: 'CatalogPlanDetail' });

const route = useRoute();
const router = useRouter();
const { hasPermission } = useOpsPermission();

const packageId = computed(() => String(route.params.packageId ?? ''));
const canRead = computed(() => hasPermission(OPS_PERMISSION.CATALOG_READ));
const canWrite = computed(() => hasPermission(OPS_PERMISSION.CATALOG_WRITE));

const detail = ref<null | PackageDetail>(null);
const versions = ref<PackagePriceVersion[]>([]);
const loading = ref(false);
const error = ref<null | OpsApiError>(null);
const versionsLoading = ref(false);

async function load() {
  if (!canRead.value) {
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const [packageDetail, versionList] = await Promise.all([
      fetchPackage(packageId.value),
      fetchPackagePriceVersions(packageId.value),
    ]);
    detail.value = packageDetail;
    versions.value = versionList.items;
  } catch (error_) {
    error.value = toOpsApiError(error_);
    detail.value = null;
    versions.value = [];
  } finally {
    loading.value = false;
  }
}

async function reloadVersions() {
  versionsLoading.value = true;
  try {
    const result = await fetchPackagePriceVersions(packageId.value);
    versions.value = result.items;
  } catch (error_) {
    message.error(toOpsApiError(error_).displayMessage);
  } finally {
    versionsLoading.value = false;
  }
}

/* ---------------- 新增价格版本 ---------------- */

const priceModal = reactive<{
  currency: string;
  effectiveFrom: string;
  open: boolean;
  price: number | undefined;
  serverMessage: null | string;
  submitting: boolean;
  termMonths: number | undefined;
}>({
  currency: 'CNY',
  effectiveFrom: '',
  open: false,
  price: undefined,
  serverMessage: null,
  submitting: false,
  termMonths: undefined,
});

const priceErrors = reactive<{ effectiveFrom: string; price: string }>({
  effectiveFrom: '',
  price: '',
});

function openPriceModal() {
  priceModal.open = true;
  priceModal.price = undefined;
  priceModal.currency = detail.value?.package.currency ?? 'CNY';
  priceModal.termMonths = detail.value?.package.defaultTermMonths ?? undefined;
  priceModal.effectiveFrom = '';
  priceModal.serverMessage = null;
  priceErrors.price = '';
  priceErrors.effectiveFrom = '';
}

async function submitPriceVersion() {
  priceErrors.price = '';
  priceErrors.effectiveFrom = '';
  if (priceModal.price === undefined || !Number.isFinite(priceModal.price)) {
    priceErrors.price = '请输入新价格';
    return;
  }
  if (priceModal.price < 0 || priceModal.price > AMOUNT_MAX) {
    priceErrors.price = `价格必须在 0 到 ${AMOUNT_MAX.toLocaleString('zh-CN')} 之间`;
    return;
  }
  if (priceModal.effectiveFrom === '') {
    priceErrors.effectiveFrom = '请选择生效日';
    return;
  }
  priceModal.submitting = true;
  priceModal.serverMessage = null;
  try {
    const result = await createPackagePriceVersion(packageId.value, {
      currency: priceModal.currency.trim().toUpperCase(),
      effectiveFrom: priceModal.effectiveFrom,
      price: priceModal.price,
      termMonths: priceModal.termMonths,
    });
    priceModal.open = false;
    message.success(
      `已新增${priceVersionLabel(result.priceVersion.versionNo)}（历史版本不变）`,
    );
    await Promise.all([load(), reloadVersions()]);
  } catch (error_) {
    // 409/400 保留输入
    priceModal.serverMessage = toOpsApiError(error_).displayMessage;
  } finally {
    priceModal.submitting = false;
  }
}

/* ---------------- 启停 ---------------- */

const transition = reactive<{
  action: 'activate' | 'retire';
  errorMessage: null | string;
  open: boolean;
  reason: string;
  submitting: boolean;
}>({
  action: 'retire',
  errorMessage: null,
  open: false,
  reason: '',
  submitting: false,
});

function openTransition(action: 'activate' | 'retire') {
  transition.open = true;
  transition.action = action;
  transition.reason = '';
  transition.errorMessage = null;
}

async function submitTransition() {
  if (transition.reason.trim() === '') {
    transition.errorMessage = '必须填写原因';
    return;
  }
  transition.submitting = true;
  transition.errorMessage = null;
  try {
    await transitionPackage(packageId.value, {
      action: transition.action,
      reason: transition.reason.trim(),
    });
    transition.open = false;
    message.success(
      transition.action === 'activate' ? '套餐已启用' : '套餐已停售',
    );
    await load();
  } catch (error_) {
    // 409 OBJECT_REFERENCED（草拟合同引用）等保留输入
    transition.errorMessage = toOpsApiError(error_).displayMessage;
  } finally {
    transition.submitting = false;
  }
}

const featureColumns = [
  { dataIndex: 'featureKey', key: 'featureKey', title: '功能键', width: 200 },
  {
    dataIndex: 'displayName',
    key: 'displayName',
    title: '显示名称',
    width: 180,
  },
  { dataIndex: 'enabled', key: 'enabled', title: '启用', width: 80 },
  { dataIndex: 'quota', key: 'quota', title: '额度', width: 120 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 100,
  },
  { dataIndex: 'appliesTo', key: 'appliesTo', title: '适用范围', width: 150 },
];

const statusLabel = computed(() =>
  detail.value
    ? enumLabel(PACKAGE_STATUS_LABEL, detail.value.package.status)
    : '',
);

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="p-5">
    <OpsDevDataNotice />

    <OpsPermissionDenied
      v-if="!canRead"
      :permissions="[OPS_PERMISSION.CATALOG_READ]"
      title="套餐详情"
    />

    <template v-else>
      <div class="mb-3 flex items-center justify-between">
        <Space>
          <Button @click="router.push({ name: 'CatalogPlans' })">
            返回套餐列表
          </Button>
          <span class="text-lg font-medium">套餐详情</span>
        </Space>
        <Space v-if="canWrite && detail">
          <Button
            v-if="detail.package.status !== 'active'"
            @click="openTransition('activate')"
          >
            启用套餐
          </Button>
          <Button
            v-if="detail.package.status === 'active'"
            danger
            @click="openTransition('retire')"
          >
            停售套餐
          </Button>
        </Space>
      </div>

      <Card v-if="loading" class="mb-4">
        <div class="flex justify-center py-10"><Spin /></div>
      </Card>

      <OpsErrorAlert
        v-else-if="error"
        :message="error.displayMessage"
        :request-id="error.requestId"
        @retry="load"
      />

      <Result
        v-else-if="!detail"
        status="404"
        title="套餐不存在或已被移除"
        sub-title="请确认链接，或返回套餐列表重新选择。"
      />

      <template v-else>
        <Card class="mb-4" :title="detail.package.internalName">
          <template #extra>
            <Tag
              :color="
                PACKAGE_STATUS_COLOR[
                  detail.package.status as keyof typeof PACKAGE_STATUS_COLOR
                ]
              "
            >
              {{ statusLabel }}
            </Tag>
          </template>

          <div
            class="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 xl:grid-cols-3"
          >
            <div>
              <span class="text-muted-foreground">客户可见名称：</span>
              {{ detail.package.customerName }}
            </div>
            <div>
              <span class="text-muted-foreground">销售方式：</span>
              {{ enumLabel(SALES_MODE_LABEL, detail.package.salesMode) }}
            </div>
            <div>
              <span class="text-muted-foreground">计费类型：</span>
              {{ enumLabel(BILLING_TYPE_LABEL, detail.package.billingType) }}
            </div>
            <div>
              <span class="text-muted-foreground">默认期限：</span>
              {{ detail.package.defaultTermMonths ?? '—' }} 个月
            </div>
            <div>
              <span class="text-muted-foreground">生效区间：</span>
              {{ formatDate(detail.package.effectiveFrom) }} ~
              {{
                detail.package.effectiveTo
                  ? formatDate(detail.package.effectiveTo)
                  : '未设置'
              }}
            </div>
            <div>
              <span class="text-muted-foreground">当前价格版本：</span>
              {{
                priceVersionLabel(detail.currentPriceVersion?.versionNo ?? null)
              }}
              <span v-if="detail.currentPriceVersion" class="ml-1">
                {{
                  formatMoney(
                    detail.currentPriceVersion.price,
                    detail.currentPriceVersion.currency,
                  )
                }}
              </span>
            </div>
          </div>
          <p class="mt-3 text-xs text-muted-foreground">
            套餐编辑不会回写既有合同、已生效订阅与授权快照（PRD §6.3）。
          </p>
        </Card>

        <PriceVersionPanel
          class="mb-4"
          :versions="versions"
          :current-version-no="detail.currentPriceVersion?.versionNo ?? null"
          :current-price="detail.currentPriceVersion?.price ?? null"
          :currency="detail.package.currency"
          :can-write="canWrite"
          :loading="versionsLoading"
          @create="openPriceModal"
        />

        <Card title="套餐权益（功能键）">
          <Table
            size="small"
            row-key="featureKey"
            :columns="featureColumns"
            :data-source="detail.features"
            :pagination="false"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'enabled'">
                <Tag :color="record.enabled ? 'green' : 'default'">
                  {{ record.enabled ? '启用' : '关闭' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'quota'">
                {{ record.quota ?? '—' }}
              </template>
              <template v-else-if="column.key === 'termMonths'">
                {{ record.termMonths ?? '—' }}
              </template>
              <template v-else-if="column.key === 'appliesTo'">
                {{ enumLabel(FEATURE_APPLIES_TO_LABEL, record.appliesTo) }}
              </template>
            </template>

            <template #emptyText>
              <div class="py-6 text-center text-sm text-muted-foreground">
                该套餐尚未配置权益。权益按稳定功能键定义，支持启停、额度、期限与适用范围。
              </div>
            </template>
          </Table>
        </Card>
      </template>
    </template>

    <Modal
      v-model:open="priceModal.open"
      title="新增价格版本（历史版本保持不变）"
      ok-text="新增版本"
      cancel-text="取消"
      :confirm-loading="priceModal.submitting"
      @ok="submitPriceVersion"
    >
      <OpsErrorAlert
        v-if="priceModal.serverMessage"
        :message="priceModal.serverMessage"
        :retryable="false"
      />

      <Form layout="vertical">
        <FormItem
          label="新价格"
          required
          :validate-status="priceErrors.price ? 'error' : undefined"
          :help="priceErrors.price || undefined"
        >
          <InputNumber
            v-model:value="priceModal.price"
            class="w-full"
            :max="AMOUNT_MAX"
            :min="0"
            :precision="2"
            placeholder="0.00"
          />
        </FormItem>
        <FormItem label="币种" required>
          <Input v-model:value="priceModal.currency" :maxlength="3" />
        </FormItem>
        <FormItem label="期限（月）">
          <InputNumber
            v-model:value="priceModal.termMonths"
            class="w-full"
            :min="1"
            :max="120"
            :precision="0"
            placeholder="一次性授权可留空"
          />
        </FormItem>
        <FormItem
          label="生效日"
          required
          :validate-status="priceErrors.effectiveFrom ? 'error' : undefined"
          :help="priceErrors.effectiveFrom || undefined"
        >
          <DatePicker
            v-model:value="priceModal.effectiveFrom"
            class="w-full"
            value-format="YYYY-MM-DD"
          />
        </FormItem>
      </Form>
      <p class="text-xs text-muted-foreground">
        新增版本只影响此后签署的新合同；已生效合同保存签署时的价格快照。
      </p>
    </Modal>

    <Modal
      v-model:open="transition.open"
      :title="transition.action === 'retire' ? '停售套餐' : '启用套餐'"
      :ok-button-props="transition.action === 'retire' ? { danger: true } : {}"
      :ok-text="transition.action === 'retire' ? '确认停售' : '确认启用'"
      cancel-text="取消"
      :confirm-loading="transition.submitting"
      @ok="submitTransition"
    >
      <p class="mb-2 text-sm">
        停售前服务端会检查草拟/审核中的合同引用；仍被引用时返回 409
        OBJECT_REFERENCED，已有生效合同仍可查看（PRD §6.3）。
      </p>
      <OpsErrorAlert
        v-if="transition.errorMessage"
        :message="transition.errorMessage"
        :retryable="false"
      />
      <label class="mb-1 block text-sm" for="package-transition-reason"
        >原因（必填）</label
      >
      <Input.TextArea
        id="package-transition-reason"
        v-model:value="transition.reason"
        :maxlength="200"
        :rows="3"
        placeholder="将写入审计事件"
      />
    </Modal>
  </div>
</template>
