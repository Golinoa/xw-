<script lang="ts" setup>
import type {
  CreateOrderRequest,
  OrderDetail,
  OrderType,
  TourRoute,
  UpdateOrderRequest,
  UpdatePayableLineInput,
  UpdateReceivableLineInput,
} from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import { authorizationForRole, PERMISSIONS } from '@erp/contracts';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  FormItem,
  Input,
  InputNumber,
  Modal,
  RadioGroup,
  Select,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { formatMoney } from '#/lib/format';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

import RouteFormModal from '../routes/route-form-modal.vue';
import SupplierFormModal from '../suppliers/supplier-form-modal.vue';
import { useCustomerOptions } from './customer-options';
import { ORDER_TYPE_OPTIONS } from './order-display';

const props = defineProps<{ open: boolean; order: null | OrderDetail }>();

const emit = defineEmits<{
  saved: [order: OrderDetail];
  'update:open': [value: boolean];
}>();

interface ReceivableRow {
  amount: number | undefined;
  id?: string;
  key: number;
  name: string;
  /** 已确认 + 在途金额：禁删按钮 + 提交前挡住金额改低。 */
  paidAmount?: number;
}
interface PayableRow extends ReceivableRow {
  supplierId?: string;
}

const authStore = useAuthStore();
const saving = ref(false);
const formError = ref('');
const routeModalOpen = ref(false);
const supplierModalOpen = ref(false);
const pendingSupplierRow = ref<null | PayableRow>(null);

const canCreateRoute = computed(() => {
  const role = authStore.currentOrganization?.role;
  return role ? authorizationForRole(role).permissions.includes(PERMISSIONS.ROUTE_WRITE) : false;
});

const {
  ensure: ensureCustomer,
  load: loadCustomers,
  options: customerOptions,
  search: searchCustomers,
  select: selectCustomer,
} = useCustomerOptions();

const routeOptions = ref<{ label: string; value: string }[]>([]);
const supplierOptions = ref<{ label: string; value: string }[]>([]);
const routesLoading = ref(false);
const suppliersLoading = ref(false);

async function loadRoutes() {
  routesLoading.value = true;
  try {
    const result = await authStore.api.call('listRoutes', {
      body: { order: 'asc', page: 1, pageSize: 100, sort: 'name' },
    });
    routeOptions.value = result.items.map((item) => ({ label: item.name, value: item.name }));
  } catch {
    routeOptions.value = [];
  } finally {
    routesLoading.value = false;
  }
}

async function loadSuppliers() {
  suppliersLoading.value = true;
  try {
    const result = await authStore.api.call('listSuppliers', {
      body: { order: 'asc', page: 1, pageSize: 100, sort: 'name' },
    });
    supplierOptions.value = result.items.map((item) => ({ label: item.name, value: item.id }));
  } catch {
    supplierOptions.value = [];
  } finally {
    suppliersLoading.value = false;
  }
}

const form = reactive({
  adultCount: 1 as number | undefined,
  childCount: 0 as number | undefined,
  customerId: undefined as string | undefined,
  departureDate: undefined as string | undefined,
  orderType: 'booking' as OrderType,
  remark: '',
  returnDate: undefined as string | undefined,
  routeName: undefined as string | undefined,
});

const baseReceivables = ref<ReceivableRow[]>([]);
const otherReceivables = ref<ReceivableRow[]>([]);
const basePayables = ref<PayableRow[]>([]);
const otherPayables = ref<PayableRow[]>([]);

const isEditing = computed(() => props.order !== null);
/** 人数是服务端生成列，这里只实时显示，不进提交体。 */
const personCount = computed(() => (form.adultCount ?? 0) + (form.childCount ?? 0));

const typeOptions = computed(() =>
  ORDER_TYPE_OPTIONS.map((option) => ({ label: $t(option.labelKey), value: option.value })),
);

let rowSeq = 0;
function newReceivableRow(): ReceivableRow {
  return { amount: undefined, key: ++rowSeq, name: '' };
}
function newPayableRow(): PayableRow {
  return { amount: undefined, key: ++rowSeq, name: '', supplierId: undefined };
}

/** 本地求和只用于即时反馈，保留两位小数避免 0.1+0.2 浮点尾巴。 */
function sumAmounts(rows: { amount: number | undefined }[]): number {
  return Math.round(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0) * 100) / 100;
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
     * 编辑时已有明细全归基础组，不凭空猜分组；保存时两组仍写回同一条数组。
     */
    baseReceivables.value = (order?.receivables ?? []).map((line) => ({
      id: line.id,
      key: ++rowSeq,
      name: line.name,
      amount: line.amount,
      paidAmount: line.confirmedAmount + line.pendingAmount || undefined,
    }));
    otherReceivables.value = [];
    basePayables.value = (order?.payables ?? []).map((line) => ({
      id: line.id,
      key: ++rowSeq,
      name: line.name,
      amount: line.amount,
      supplierId: line.supplierId,
      paidAmount: line.confirmedAmount + line.pendingAmount || undefined,
    }));
    otherPayables.value = [];

    void loadCustomers();
    if (order) void ensureCustomer(order.customerId, order.customerName);
    void loadSuppliers();
    // 历史订单可能存着没建档的线路名：钉住它，否则下拉空白、一保存就被清掉。
    if (order?.routeName && !routeOptions.value.some((item) => item.value === order.routeName)) {
      routeOptions.value = [
        { label: order.routeName, value: order.routeName },
        ...routeOptions.value,
      ];
    }
    void loadRoutes();
  },
  { immediate: true },
);

function buildReceivables(): null | UpdateReceivableLineInput[] {
  const lines: UpdateReceivableLineInput[] = [];
  const groups = [
    { key: 'shell.orders.baseReceivable', rows: baseReceivables.value },
    { key: 'shell.orders.otherReceivable', rows: otherReceivables.value },
  ];
  for (const group of groups) {
    for (const [index, row] of group.rows.entries()) {
      const name = row.name.trim();
      if (!name) {
        formError.value = $t('shell.orders.lineNameRequired', { group: $t(group.key), line: index + 1 });
        return null;
      }
      const amount = row.amount ?? 0;
      if (row.paidAmount && amount < row.paidAmount) {
        formError.value = $t('shell.orders.lineAmountBelowPaid', {
          group: $t(group.key),
          line: index + 1,
          paid: formatMoney(row.paidAmount),
        });
        return null;
      }
      lines.push({ ...(row.id ? { id: row.id } : {}), amount, name });
    }
  }
  return lines;
}

function buildPayables(): null | UpdatePayableLineInput[] {
  const lines: UpdatePayableLineInput[] = [];
  const groups = [
    { key: 'shell.orders.basePayable', rows: basePayables.value },
    { key: 'shell.orders.otherPayable', rows: otherPayables.value },
  ];
  for (const group of groups) {
    for (const [index, row] of group.rows.entries()) {
      const name = row.name.trim();
      if (!name) {
        formError.value = $t('shell.orders.lineNameRequired', { group: $t(group.key), line: index + 1 });
        return null;
      }
      if (!row.supplierId) {
        formError.value = $t('shell.orders.lineSupplierRequired', { group: $t(group.key), line: index + 1 });
        return null;
      }
      const amount = row.amount ?? 0;
      if (row.paidAmount && amount < row.paidAmount) {
        formError.value = $t('shell.orders.lineAmountBelowPaid', {
          group: $t(group.key),
          line: index + 1,
          paid: formatMoney(row.paidAmount),
        });
        return null;
      }
      lines.push({ ...(row.id ? { id: row.id } : {}), amount, name, supplierId: row.supplierId });
    }
  }
  return lines;
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'ORDER_STATE_CONFLICT') return $t('shell.orders.lockedCannotEdit');
    if (cause.code === 'CONFLICT') return $t('shell.orders.changedByOthers');
    return cause.message;
  }
  return $t('shell.orders.saveFailed');
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  if (!form.customerId) {
    formError.value = $t('shell.orders.customerRequired');
    return;
  }
  if (form.departureDate && form.returnDate && form.returnDate < form.departureDate) {
    formError.value = $t('shell.orders.returnBeforeDeparture');
    return;
  }
  if (form.remark.length > 2000) {
    formError.value = $t('shell.orders.remarkTooLong');
    return;
  }
  const receivables = buildReceivables();
  if (!receivables) return;
  const payables = buildPayables();
  if (!payables) return;

  const body: CreateOrderRequest = {
    adultCount: Math.max(0, Math.trunc(form.adultCount ?? 0)),
    childCount: Math.max(0, Math.trunc(form.childCount ?? 0)),
    customerId: form.customerId,
    orderType: form.orderType,
    payables,
    receivables,
    // 契约用 null = 清空；编辑时清掉线路/日期/备注必须显式传 null。
    departureDate: form.departureDate ?? null,
    remark: form.remark.trim() || null,
    returnDate: form.returnDate ?? null,
    routeName: (form.routeName ?? '').trim() || null,
  };

  saving.value = true;
  try {
    const result = props.order
      ? await authStore.api.call('updateOrder', {
          body: { ...body, version: props.order.version } satisfies UpdateOrderRequest,
          params: { orderId: props.order.id },
        })
      : await authStore.api.call('createOrder', { body });
    emit('saved', result.order);
    emit('update:open', false);
  } catch (error) {
    formError.value = describeError(error);
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

function onRouteSaved(route: TourRoute) {
  routeOptions.value = [{ label: route.name, value: route.name }, ...routeOptions.value];
  form.routeName = route.name;
  routeModalOpen.value = false;
}

function onSupplierSaved(supplier: { id: string; name: string }) {
  supplierOptions.value = [{ label: supplier.name, value: supplier.id }, ...supplierOptions.value];
  if (pendingSupplierRow.value) pendingSupplierRow.value.supplierId = supplier.id;
  pendingSupplierRow.value = null;
  supplierModalOpen.value = false;
}
</script>

<template>
  <Modal
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    :cancel-text="$t('shell.common.cancel')"
    :ok-text="$t('shell.common.save')"
    :open="open"
    :title="isEditing ? $t('shell.orders.editTitle') : $t('shell.orders.createTitle')"
    :width="900"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="formError" class="mb-4" show-icon type="error" :message="formError" role="alert" />

    <Form layout="vertical" :model="form">
      <h4 class="mb-3 mt-2 text-sm font-semibold">{{ $t('shell.orders.sectionCustomer') }}</h4>
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem class="col-span-2" html-for="order-customer" :label="$t('shell.orders.colCustomer')" required>
          <Select
            id="order-customer"
            v-model:value="form.customerId"
            :filter-option="false"
            :loading="false"
            :options="customerOptions"
            show-search
            :placeholder="$t('shell.orders.customerPlaceholder')"
            @change="selectCustomer(form.customerId)"
            @search="searchCustomers"
          />
        </FormItem>
        <FormItem html-for="order-type" :label="$t('shell.orders.colType')" required>
          <RadioGroup id="order-type" v-model:value="form.orderType" :options="typeOptions" option-type="button" />
        </FormItem>
        <FormItem :label="$t('shell.orders.colPeople')">
          <span class="font-semibold">{{ personCount }} {{ $t('shell.orders.personUnit') }}</span>
          <span class="block text-xs text-muted-foreground">{{ $t('shell.orders.personHint') }}</span>
        </FormItem>
        <FormItem html-for="order-adults" :label="$t('shell.orders.colAdults')" required>
          <InputNumber id="order-adults" v-model:value="form.adultCount" class="w-full" :max="999" :min="0" :precision="0" />
        </FormItem>
        <FormItem html-for="order-children" :label="$t('shell.orders.colChildren')" required>
          <InputNumber id="order-children" v-model:value="form.childCount" class="w-full" :max="999" :min="0" :precision="0" />
        </FormItem>
      </div>

      <h4 class="mb-3 mt-4 text-sm font-semibold">{{ $t('shell.orders.sectionRoute') }}</h4>
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem class="col-span-2" html-for="order-route" :label="$t('shell.orders.colRoute')">
          <div class="flex items-center gap-2">
            <Select
              id="order-route"
              v-model:value="form.routeName"
              allow-clear
              :filter-option="false"
              :loading="routesLoading"
              :options="routeOptions"
              class="flex-1"
              :placeholder="$t('shell.orders.routePlaceholder')"
              show-search
            />
            <Button v-if="canCreateRoute" size="small" type="link" @click="routeModalOpen = true">
              {{ $t('shell.orders.newRoute') }}
            </Button>
          </div>
          <span class="text-xs text-muted-foreground">{{ $t('shell.orders.routeSnapshotHint') }}</span>
        </FormItem>
        <FormItem html-for="order-departure" :label="$t('shell.orders.colDepartureDate')">
          <DatePicker id="order-departure" v-model:value="form.departureDate" class="w-full" value-format="YYYY-MM-DD" />
        </FormItem>
        <FormItem html-for="order-return" :label="$t('shell.orders.colReturnDate')">
          <DatePicker id="order-return" v-model:value="form.returnDate" class="w-full" value-format="YYYY-MM-DD" />
        </FormItem>
      </div>

      <h4 class="mb-3 mt-4 text-sm font-semibold">{{ $t('shell.orders.receivablesSection') }}</h4>
      <div
v-for="group in [
        { key: 'baseReceivable', rows: baseReceivables },
        { key: 'otherReceivable', rows: otherReceivables },
      ]" :key="group.key" class="mb-3">
        <div class="mb-1 flex items-center justify-between">
          <span class="text-sm font-semibold">{{ $t(`shell.orders.${group.key}`) }}</span>
          <Button size="small" type="link" @click="group.rows.push(newReceivableRow())">
            {{ $t('shell.orders.addLine', { group: $t(`shell.orders.${group.key}`) }) }}
          </Button>
        </div>
        <div v-for="(row, index) in group.rows" :key="row.key" class="mb-2 flex items-center gap-2">
          <Input v-model:value="row.name" class="flex-1" :maxlength="100" :placeholder="$t('shell.orders.lineNamePlaceholder')" />
          <InputNumber v-model:value="row.amount" class="w-36" :max="999999999999.99" :min="0" :precision="2" :placeholder="$t('shell.orders.lineAmountPlaceholder')" />
          <Button
            danger
            :disabled="Boolean(row.paidAmount)"
            size="small"
            type="text"
            :title="row.paidAmount ? $t('shell.orders.lineLockedHint') : undefined"
            @click="group.rows.splice(index, 1)"
          >
            {{ $t('shell.tourists.delete') }}
          </Button>
        </div>
      </div>

      <h4 class="mb-3 mt-4 text-sm font-semibold">{{ $t('shell.orders.payablesSection') }}</h4>
      <div
v-for="group in [
        { key: 'basePayable', rows: basePayables },
        { key: 'otherPayable', rows: otherPayables },
      ]" :key="group.key" class="mb-3">
        <div class="mb-1 flex items-center justify-between">
          <span class="text-sm font-semibold">{{ $t(`shell.orders.${group.key}`) }}</span>
          <Button size="small" type="link" @click="group.rows.push(newPayableRow())">
            {{ $t('shell.orders.addLine', { group: $t(`shell.orders.${group.key}`) }) }}
          </Button>
        </div>
        <div v-for="(row, index) in group.rows" :key="row.key" class="mb-2 flex items-center gap-2">
          <Select
            v-model:value="row.supplierId"
            class="w-44"
            :loading="suppliersLoading"
            :options="supplierOptions"
            :placeholder="$t('shell.orders.supplierPlaceholder')"
            show-search
          />
          <Input v-model:value="row.name" class="flex-1" :maxlength="100" :placeholder="$t('shell.orders.lineNamePlaceholder')" />
          <InputNumber v-model:value="row.amount" class="w-32" :max="999999999999.99" :min="0" :precision="2" />
          <Button size="small" type="link" @click="openSupplierModal(row)">{{ $t('shell.orders.newSupplier') }}</Button>
          <Button
            danger
            :disabled="Boolean(row.paidAmount)"
            size="small"
            type="text"
            @click="group.rows.splice(index, 1)"
          >
            {{ $t('shell.tourists.delete') }}
          </Button>
        </div>
      </div>

      <div class="mb-3 flex flex-wrap gap-6 rounded bg-muted p-3">
        <div>
          <span class="block text-xs text-muted-foreground">{{ $t('shell.orders.colReceivableTotal') }}</span>
          <span class="font-semibold">{{ formatMoney(receivableTotal) }}</span>
        </div>
        <div>
          <span class="block text-xs text-muted-foreground">{{ $t('shell.orders.colPayableTotal') }}</span>
          <span class="font-semibold">{{ formatMoney(payableTotal) }}</span>
        </div>
        <div>
          <span class="block text-xs text-muted-foreground">{{ $t('shell.orders.colProfit') }}</span>
          <span :class="profit < 0 ? 'text-red-600' : 'text-green-600'" class="font-semibold">{{ formatMoney(profit) }}</span>
        </div>
      </div>
      <p class="mb-3 text-xs text-muted-foreground">{{ $t('shell.orders.amountEstimateHint') }}</p>

      <FormItem html-for="order-remark" :label="$t('shell.orders.colRemark')">
        <Textarea id="order-remark" v-model:value="form.remark" :maxlength="2000" :rows="3" show-count />
      </FormItem>
    </Form>
  </Modal>

  <SupplierFormModal v-model:open="supplierModalOpen" @saved="onSupplierSaved" />
  <RouteFormModal v-model:open="routeModalOpen" @saved="onRouteSaved" />
</template>
