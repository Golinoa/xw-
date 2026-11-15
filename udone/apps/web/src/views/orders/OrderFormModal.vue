<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  PERMISSIONS,
  authorizationForRole,
  type CreateOrderRequest,
  type OrderDetail,
  type OrderType,
  type Permission,
  type UpdateOrderRequest,
  type UpdatePayableLineInput,
  type UpdateReceivableLineInput,
} from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { formatMoney } from '../../lib/format';
import { useAuthStore } from '../../stores/auth';
import { type TourRoute } from '@erp/contracts';
import SupplierFormModal from '../suppliers/SupplierFormModal.vue';
import { filterSupplierOption, useSupplierOptions } from '../suppliers/supplier-options';
import RouteFormModal from '../routes/RouteFormModal.vue';
import { useRouteOptions } from '../routes/route-options';
import { useCustomerOptions } from './customer-options';
import { ORDER_TYPE_OPTIONS } from './order-display';

const props = defineProps<{
  open: boolean;
  /** 传入详情表示编辑；为空表示新建。编辑必须回传详情里的 version。 */
  order: OrderDetail | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [order: OrderDetail];
}>();

interface ReceivableRow {
  key: number;
  /** 已有明细行的服务端 id；为空表示这次保存是新增行。 */
  id?: string;
  name: string;
  amount: number | null;
  /**
   * 已确认 + 在途金额。既用于禁掉删除按钮，也用于提交前挡住「金额改到低于已收款」，
   * 免得用户填完才被服务端 409 打回来。
   */
  paidAmount?: number;
}

interface PayableRow extends ReceivableRow {
  supplierId?: string;
}

const auth = useAuthStore();

const permissions = computed<readonly Permission[]>(() => {
  const role = auth.currentOrganization.value?.role;
  return role ? authorizationForRole(role).permissions : [];
});
/** 隐藏入口只影响体验：服务端仍按 route.write 独立校验。 */
const canCreateRoute = computed(() => permissions.value.includes(PERMISSIONS.ROUTE_WRITE));

/** 展开成具名 ref，模板里就不必写 `.value`。 */
const {
  options: customerOptions,
  loading: customersLoading,
  error: customersError,
  load: loadCustomers,
  search: searchCustomers,
  ensure: ensureCustomer,
  select: selectCustomer,
} = useCustomerOptions();
const {
  options: supplierOptions,
  loading: suppliersLoading,
  error: suppliersError,
  load: loadSuppliers,
  add: addSupplier,
} = useSupplierOptions();
const {
  options: routeOptions,
  loading: routesLoading,
  error: routesError,
  load: loadRoutes,
  search: searchRoutes,
  ensure: ensureRoute,
  add: addRoute,
} = useRouteOptions();

const saving = ref(false);
const formError = ref('');
const supplierModalOpen = ref(false);
const routeModalOpen = ref(false);
/** 快捷新建供应商后要回填到哪一行的下标；同一时刻只可能有一行在操作。 */
const pendingSupplierRow = ref<PayableRow | null>(null);

const form = reactive({
  customerId: undefined as string | undefined,
  orderType: 'booking' as OrderType,
  adultCount: 1 as number | null,
  childCount: 0 as number | null,
  routeName: undefined as string | undefined,
  departureDate: undefined as string | undefined,
  returnDate: undefined as string | undefined,
  remark: '',
});

const baseReceivables = ref<ReceivableRow[]>([]);
const otherReceivables = ref<ReceivableRow[]>([]);
const basePayables = ref<PayableRow[]>([]);
const otherPayables = ref<PayableRow[]>([]);

const isEditing = computed(() => props.order !== null);

/** 人数是服务端生成列（adult + child），这里只随输入实时显示，不进入提交体。 */
const personCount = computed(() => (form.adultCount ?? 0) + (form.childCount ?? 0));

let rowSeq = 0;

function newReceivableRow(): ReceivableRow {
  return { key: ++rowSeq, name: '', amount: null };
}

function newPayableRow(): PayableRow {
  return { key: ++rowSeq, name: '', amount: null, supplierId: undefined };
}

/** 本地求和只用于即时反馈，保留两位小数以免出现 0.1 + 0.2 的浮点尾巴。 */
function sumAmounts(rows: { amount: number | null }[]): number {
  const total = rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  return Math.round(total * 100) / 100;
}

const receivableTotal = computed(() =>
  sumAmounts([...baseReceivables.value, ...otherReceivables.value]),
);
const payableTotal = computed(() => sumAmounts([...basePayables.value, ...otherPayables.value]));
const profit = computed(() => Math.round((receivableTotal.value - payableTotal.value) * 100) / 100);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    formError.value = '';
    const order = props.order;
    form.customerId = order?.customerId;
    form.orderType = order?.orderType ?? 'booking';
    form.adultCount = order?.adultCount ?? 1;
    form.childCount = order?.childCount ?? 0;
    form.routeName = order?.routeName;
    form.departureDate = order?.departureDate;
    form.returnDate = order?.returnDate;
    form.remark = order?.remark ?? '';
    /**
     * 契约只有一条平铺的 receivables/payables 数组，没有「基础/其他」标记。
     * 编辑时把已有明细全部归入基础组，避免凭空猜分组；保存时两组仍写回同一条数组。
     */
    baseReceivables.value = (order?.receivables ?? []).map((line) => ({
      key: ++rowSeq,
      id: line.id,
      name: line.name,
      amount: line.amount,
      paidAmount: line.confirmedAmount + line.pendingAmount || undefined,
    }));
    otherReceivables.value = [];
    basePayables.value = (order?.payables ?? []).map((line) => ({
      key: ++rowSeq,
      id: line.id,
      name: line.name,
      amount: line.amount,
      supplierId: line.supplierId,
      paidAmount: line.confirmedAmount + line.pendingAmount || undefined,
    }));
    otherPayables.value = [];

    void loadCustomers();
    if (order) void ensureCustomer(order.customerId, order.customerName);
    void loadSuppliers();
    // 历史订单可能存着一个没建档的线路名：钉住它，否则下拉空白、一保存就被清掉。
    ensureRoute(order?.routeName ?? '');
    void loadRoutes();
  },
  { immediate: true },
);

function buildReceivables(): UpdateReceivableLineInput[] | null {
  const lines: UpdateReceivableLineInput[] = [];
  const groups = [
    { label: '基础应收', rows: baseReceivables.value },
    { label: '其他应收', rows: otherReceivables.value },
  ];
  for (const group of groups) {
    for (const [index, row] of group.rows.entries()) {
      const name = row.name.trim();
      if (!name) {
        formError.value = `${group.label}第 ${index + 1} 行需要填写名称`;
        return null;
      }
      const amount = row.amount ?? 0;
      // 服务端也会拒绝，这里提前拦是为了让用户在还看着这张表的时候就知道原因。
      if (row.paidAmount && amount < row.paidAmount) {
        formError.value = `${group.label}第 ${index + 1} 行金额不能低于已收付的 ${formatMoney(row.paidAmount)}`;
        return null;
      }
      // id 只在编辑已有行时存在：缺了它，服务端会把这一行当成新增，
      // 原行的已确认金额也就跟丢了。
      lines.push({ ...(row.id ? { id: row.id } : {}), name, amount });
    }
  }
  return lines;
}

function buildPayables(): UpdatePayableLineInput[] | null {
  const lines: UpdatePayableLineInput[] = [];
  const groups = [
    { label: '基础应付', rows: basePayables.value },
    { label: '其他应付', rows: otherPayables.value },
  ];
  for (const group of groups) {
    for (const [index, row] of group.rows.entries()) {
      const name = row.name.trim();
      if (!name) {
        formError.value = `${group.label}第 ${index + 1} 行需要填写名称`;
        return null;
      }
      if (!row.supplierId) {
        formError.value = `${group.label}第 ${index + 1} 行需要选择供应商`;
        return null;
      }
      const amount = row.amount ?? 0;
      if (row.paidAmount && amount < row.paidAmount) {
        formError.value = `${group.label}第 ${index + 1} 行金额不能低于已收付的 ${formatMoney(row.paidAmount)}`;
        return null;
      }
      lines.push({ ...(row.id ? { id: row.id } : {}), name, amount, supplierId: row.supplierId });
    }
  }
  return lines;
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'ORDER_STATE_CONFLICT') return '该订单已锁团或已取消，不能编辑';
    if (cause.code === 'CONFLICT') return '数据已被他人修改，请刷新后重试';
    return cause.message;
  }
  return '保存失败，请稍后重试';
}

async function submit() {
  if (saving.value) return;
  formError.value = '';

  if (!form.customerId) {
    formError.value = '请选择客户';
    return;
  }
  // 服务端也会拒绝倒序日期，前端提前拦截只是为了少一次往返。
  if (form.departureDate && form.returnDate && form.returnDate < form.departureDate) {
    formError.value = '回团日期不能早于出团日期';
    return;
  }
  if (form.remark.length > 2000) {
    formError.value = '备注最多 2000 字';
    return;
  }

  const receivables = buildReceivables();
  if (!receivables) return;
  const payables = buildPayables();
  if (!payables) return;

  const body: CreateOrderRequest = {
    customerId: form.customerId,
    orderType: form.orderType,
    adultCount: Math.max(0, Math.trunc(form.adultCount ?? 0)),
    childCount: Math.max(0, Math.trunc(form.childCount ?? 0)),
    receivables,
    payables,
    // 合同用「null = 清空」，编辑时清掉线路/日期/备注必须显式传 null。
    routeName: (form.routeName ?? '').trim() || null,
    departureDate: form.departureDate ?? null,
    returnDate: form.returnDate ?? null,
    remark: form.remark.trim() || null,
  };

  saving.value = true;
  try {
    if (props.order) {
      const updateBody: UpdateOrderRequest = { ...body, version: props.order.version };
      const result = await auth.api.call('updateOrder', {
        params: { orderId: props.order.id },
        body: updateBody,
      });
      emit('saved', result.order);
    } else {
      const result = await auth.api.call('createOrder', { body });
      emit('saved', result.order);
    }
    emit('update:open', false);
  } catch (cause) {
    formError.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}

function close() {
  if (saving.value) return;
  emit('update:open', false);
}

function openSupplierModal(row: PayableRow) {
  pendingSupplierRow.value = row;
  supplierModalOpen.value = true;
}

/** 选中后固定住这一项，后续再搜索不会把已选客户的名称从下拉里挤掉。 */
function onCustomerSelected(value: unknown) {
  selectCustomer(typeof value === 'string' && value ? value : undefined);
}

/** 展开下拉时若还没有选项（初次加载失败等）再补一次。 */
function ensureSupplierOptions() {
  if (supplierOptions.value.length === 0) void loadSuppliers();
}

function onRouteSaved(route: TourRoute) {
  addRoute(route);
  form.routeName = route.name;
  message.success(`已新建线路「${route.name}」并选中`);
}

function onSupplierSaved(supplier: { id: string; name: string }) {
  addSupplier(supplier);
  const row = pendingSupplierRow.value;
  if (row) row.supplierId = supplier.id;
  pendingSupplierRow.value = null;
  message.success(`已新建供应商「${supplier.name}」并选中`);
}
</script>

<template>
  <a-modal
    :open="open"
    :title="isEditing ? '编辑订单' : '新建订单'"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    ok-text="保存"
    cancel-text="取消"
    width="880px"
    @ok="submit"
    @cancel="close"
  >
    <a-alert
      v-if="formError"
      class="form-error"
      type="error"
      show-icon
      :message="formError"
      role="alert"
    />

    <a-form layout="vertical" :model="form">
      <h4 class="section-title">客户与人数</h4>
      <div class="form-grid">
        <a-form-item label="客户" name="customerId" required class="span-2">
          <a-select
            v-model:value="form.customerId"
            show-search
            :filter-option="false"
            :loading="customersLoading"
            :options="customerOptions"
            placeholder="输入客户姓名搜索"
            @search="searchCustomers"
            @change="onCustomerSelected"
          />
          <p v-if="customersError" class="field-error">
            客户下拉加载失败：{{ customersError }}
            <a-button type="link" size="small" @click="loadCustomers()">重试</a-button>
          </p>
        </a-form-item>
        <a-form-item label="订单类型" name="orderType" required>
          <a-radio-group
            v-model:value="form.orderType"
            :options="ORDER_TYPE_OPTIONS"
            option-type="button"
          />
        </a-form-item>
        <a-form-item label="总人数">
          <span class="person-count">{{ personCount }} 人</span>
          <span class="field-hint">成人 + 儿童，由服务端生成，不单独提交</span>
        </a-form-item>
        <a-form-item label="成人数" name="adultCount" required>
          <a-input-number
            v-model:value="form.adultCount"
            class="number-input"
            :min="0"
            :max="999"
            :precision="0"
          />
        </a-form-item>
        <a-form-item label="儿童数" name="childCount" required>
          <a-input-number
            v-model:value="form.childCount"
            class="number-input"
            :min="0"
            :max="999"
            :precision="0"
          />
        </a-form-item>
      </div>

      <h4 class="section-title">线路与团期</h4>
      <div class="form-grid">
        <a-form-item label="线路" name="routeName" class="span-2">
          <div class="route-picker">
            <a-select
              v-model:value="form.routeName"
              class="route-select"
              show-search
              allow-clear
              :filter-option="false"
              :loading="routesLoading"
              :options="routeOptions"
              placeholder="搜索或选择线路"
              @search="searchRoutes"
            />
            <a-button v-if="canCreateRoute" type="link" size="small" @click="routeModalOpen = true"
              >新建线路</a-button
            >
          </div>
          <span class="field-hint">订单保存的是名称快照：线路以后改名，历史订单不变。</span>
          <p v-if="routesError" class="field-error">
            线路下拉加载失败：{{ routesError }}
            <a-button type="link" size="small" @click="loadRoutes()">重试</a-button>
          </p>
        </a-form-item>
        <a-form-item label="出团日期" name="departureDate">
          <a-date-picker
            v-model:value="form.departureDate"
            value-format="YYYY-MM-DD"
            placeholder="选择出团日期"
            style="width: 100%"
          />
        </a-form-item>
        <a-form-item label="回团日期" name="returnDate">
          <a-date-picker
            v-model:value="form.returnDate"
            value-format="YYYY-MM-DD"
            placeholder="不得早于出团日期"
            style="width: 100%"
          />
        </a-form-item>
      </div>

      <h4 class="section-title">应收明细</h4>
      <div class="line-group">
        <div class="line-header">
          <span class="line-title">基础应收</span>
          <a-button type="link" size="small" @click="baseReceivables.push(newReceivableRow())"
            >添加基础应收</a-button
          >
        </div>
        <p v-if="baseReceivables.length === 0" class="line-empty">
          暂无基础应收，团费等主要收入请加在这里。
        </p>
        <div v-for="(row, index) in baseReceivables" :key="row.key" class="line-row">
          <a-input
            v-model:value="row.name"
            class="line-name"
            :maxlength="100"
            placeholder="项目名称，如团费"
          />
          <a-input-number
            v-model:value="row.amount"
            class="line-amount"
            :min="0"
            :max="999999999999.99"
            :precision="2"
            placeholder="金额"
          />
          <a-button
            type="text"
            danger
            :disabled="Boolean(row.paidAmount)"
            :title="row.paidAmount ? '这一行已有确认或在途金额，不能删除' : undefined"
            @click="baseReceivables.splice(index, 1)"
            >删除</a-button
          >
        </div>
      </div>

      <div class="line-group">
        <div class="line-header">
          <span class="line-title">其他应收</span>
          <a-button type="link" size="small" @click="otherReceivables.push(newReceivableRow())"
            >添加其他应收</a-button
          >
        </div>
        <p v-if="otherReceivables.length === 0" class="line-empty">
          暂无其他应收，可选项目（如单房差、自费项目）加在这里。
        </p>
        <div v-for="(row, index) in otherReceivables" :key="row.key" class="line-row">
          <a-input
            v-model:value="row.name"
            class="line-name"
            :maxlength="100"
            placeholder="项目名称"
          />
          <a-input-number
            v-model:value="row.amount"
            class="line-amount"
            :min="0"
            :max="999999999999.99"
            :precision="2"
            placeholder="金额"
          />
          <a-button
            type="text"
            danger
            :disabled="Boolean(row.paidAmount)"
            :title="row.paidAmount ? '这一行已有确认或在途金额，不能删除' : undefined"
            @click="otherReceivables.splice(index, 1)"
            >删除</a-button
          >
        </div>
      </div>

      <h4 class="section-title">应付明细</h4>
      <div class="line-group">
        <div class="line-header">
          <span class="line-title">基础应付</span>
          <a-button type="link" size="small" @click="basePayables.push(newPayableRow())"
            >添加基础应付</a-button
          >
        </div>
        <p v-if="basePayables.length === 0" class="line-empty">
          暂无基础应付，必须选择供应商，否则无法进入结算。
        </p>
        <div v-for="(row, index) in basePayables" :key="row.key" class="line-row payable-row">
          <a-select
            v-model:value="row.supplierId"
            class="line-supplier"
            show-search
            :filter-option="filterSupplierOption"
            :loading="suppliersLoading"
            :options="supplierOptions"
            placeholder="选择供应商"
            @dropdown-visible-change="ensureSupplierOptions"
          />
          <a-input
            v-model:value="row.name"
            class="line-name"
            :maxlength="100"
            placeholder="项目名称，如房费"
          />
          <a-input-number
            v-model:value="row.amount"
            class="line-amount"
            :min="0"
            :max="999999999999.99"
            :precision="2"
            placeholder="金额"
          />
          <a-button type="link" size="small" @click="openSupplierModal(row)">新建</a-button>
          <a-button
            type="text"
            danger
            :disabled="Boolean(row.paidAmount)"
            :title="row.paidAmount ? '这一行已有确认或在途金额，不能删除' : undefined"
            @click="basePayables.splice(index, 1)"
            >删除</a-button
          >
        </div>
      </div>

      <div class="line-group">
        <div class="line-header">
          <span class="line-title">其他应付</span>
          <a-button type="link" size="small" @click="otherPayables.push(newPayableRow())"
            >添加其他应付</a-button
          >
        </div>
        <p v-if="otherPayables.length === 0" class="line-empty">
          暂无其他应付，地接、门票等附加成本加在这里。
        </p>
        <div v-for="(row, index) in otherPayables" :key="row.key" class="line-row payable-row">
          <a-select
            v-model:value="row.supplierId"
            class="line-supplier"
            show-search
            :filter-option="filterSupplierOption"
            :loading="suppliersLoading"
            :options="supplierOptions"
            placeholder="选择供应商"
            @dropdown-visible-change="ensureSupplierOptions"
          />
          <a-input
            v-model:value="row.name"
            class="line-name"
            :maxlength="100"
            placeholder="项目名称"
          />
          <a-input-number
            v-model:value="row.amount"
            class="line-amount"
            :min="0"
            :max="999999999999.99"
            :precision="2"
            placeholder="金额"
          />
          <a-button type="link" size="small" @click="openSupplierModal(row)">新建</a-button>
          <a-button
            type="text"
            danger
            :disabled="Boolean(row.paidAmount)"
            :title="row.paidAmount ? '这一行已有确认或在途金额，不能删除' : undefined"
            @click="otherPayables.splice(index, 1)"
            >删除</a-button
          >
        </div>
      </div>
      <p v-if="suppliersError" class="field-error">
        供应商下拉加载失败：{{ suppliersError }}
        <a-button type="link" size="small" @click="loadSuppliers()">重试</a-button>
      </p>

      <h4 class="section-title">金额摘要</h4>
      <div class="summary">
        <div class="summary-item">
          <span class="summary-label">应收合计</span>
          <span class="summary-value">{{ formatMoney(receivableTotal) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">应付合计</span>
          <span class="summary-value">{{ formatMoney(payableTotal) }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">利润</span>
          <span class="summary-value" :class="profit < 0 ? 'profit-neg' : 'profit-pos'">{{
            formatMoney(profit)
          }}</span>
        </div>
      </div>
      <p class="summary-note">以上为前端预估，保存后以服务端重算的金额为准。</p>

      <h4 class="section-title">备注</h4>
      <a-form-item name="remark">
        <a-textarea
          v-model:value="form.remark"
          :maxlength="2000"
          :rows="3"
          show-count
          placeholder="补充说明，最多 2000 字"
        />
      </a-form-item>
    </a-form>
  </a-modal>

  <SupplierFormModal v-model:open="supplierModalOpen" @saved="onSupplierSaved" />
  <RouteFormModal v-model:open="routeModalOpen" @saved="onRouteSaved" />
</template>

<style scoped>
.form-error {
  margin-bottom: var(--space-16);
}

.section-title {
  margin: var(--space-8) 0 var(--space-12);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-heading);
  font-size: var(--font-size-md);
  font-weight: 600;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--space-16);
}

.span-2 {
  grid-column: span 2;
}

.number-input {
  width: 100%;
}

.person-count {
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-weight: 600;
}

.field-hint {
  display: block;
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
}

.field-error {
  margin: var(--space-4) 0 0;
  color: var(--color-error-text);
  font-size: var(--font-size-sm);
}

.line-group {
  margin-bottom: var(--space-12);
}

.line-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-8);
}

.line-title {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.line-empty {
  margin: var(--space-4) 0 0;
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
}

.line-row {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  margin-top: var(--space-8);
}

.line-name {
  flex: 1 1 auto;
}

.line-amount {
  flex: 0 0 140px;
  width: 140px;
}

.line-supplier {
  flex: 0 0 180px;
  width: 180px;
}

.route-picker {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}

.route-select {
  flex: 1 1 auto;
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-24);
  padding: var(--space-12) var(--space-16);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-default);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.summary-label {
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
}

.summary-value {
  color: var(--color-heading);
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.profit-pos {
  color: var(--color-success-text);
}

.profit-neg {
  color: var(--color-error-text);
}

.summary-note {
  margin: var(--space-8) 0 var(--space-16);
  color: var(--color-secondary-text);
  font-size: var(--font-size-xs);
}

@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .span-2 {
    grid-column: span 1;
  }

  .line-row {
    flex-wrap: wrap;
  }

  .line-supplier,
  .line-amount {
    flex: 1 1 140px;
  }
}
</style>
