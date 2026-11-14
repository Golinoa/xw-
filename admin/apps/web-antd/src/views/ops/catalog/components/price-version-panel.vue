<script lang="ts" setup>
/**
 * 价格版本面板（只读历史 + 新增版本入口）。
 *
 * 硬约束（契约 §3.2）：`ops.package_price_versions` **仅 INSERT**，历史版本不可改、不可删；
 * 因此本组件不提供编辑/删除按钮，页面上必须能看出「这是哪个版本的价格」。
 */
import type { PackagePriceVersion } from '#/api/ops/catalog';

import { Alert, Button, Card, Table, Tag } from 'ant-design-vue';

import {
  formatDate,
  formatDateTime,
  formatMoney,
  priceVersionLabel,
} from '../format';

defineOptions({ name: 'CatalogPriceVersionPanel' });

const props = withDefaults(
  defineProps<{
    canWrite?: boolean;
    currency?: string;
    /** 当前版本单价；与历史行区分展示，避免误读「改了价」 */
    currentPrice?: null | number;
    currentVersionNo?: null | number;
    loading?: boolean;
    versions: PackagePriceVersion[];
  }>(),
  {
    canWrite: false,
    currency: 'CNY',
    currentPrice: null,
    currentVersionNo: null,
    loading: false,
  },
);

const emit = defineEmits<{ create: [] }>();

const columns = [
  { dataIndex: 'versionNo', key: 'versionNo', title: '版本', width: 120 },
  { dataIndex: 'price', key: 'price', title: '价格', width: 160 },
  {
    dataIndex: 'termMonths',
    key: 'termMonths',
    title: '期限（月）',
    width: 100,
  },
  {
    dataIndex: 'effectiveFrom',
    key: 'effectiveFrom',
    title: '生效日',
    width: 130,
  },
  { dataIndex: 'createdBy', key: 'createdBy', title: '创建人', width: 140 },
  { dataIndex: 'createdAt', key: 'createdAt', title: '创建时间', width: 170 },
];
</script>

<template>
  <Card title="价格版本">
    <template #extra>
      <Button
        v-if="props.canWrite"
        type="primary"
        size="small"
        data-testid="create-price-version"
        @click="emit('create')"
      >
        新增价格版本
      </Button>
    </template>

    <div
      class="mb-3 flex flex-wrap items-center gap-2 text-sm"
      data-testid="current-price"
    >
      <Tag color="processing">
        {{ priceVersionLabel(props.currentVersionNo) }}
      </Tag>
      <span class="font-medium">
        {{
          props.currentPrice === null
            ? '—'
            : formatMoney(props.currentPrice, props.currency)
        }}
      </span>
      <span class="text-muted-foreground">（当前生效价格，仅用于新合同）</span>
    </div>

    <Alert
      class="mb-3"
      type="info"
      show-icon
      message="价格版本只增不改"
      description="新增价格版本只影响此后签署的新合同；已生效合同保存签署时的价格与权益快照，页面不回写历史（PRD §6.3 / 契约 §3.2）。"
    />

    <Table
      size="small"
      row-key="versionNo"
      :columns="columns"
      :data-source="props.versions"
      :loading="props.loading"
      :pagination="false"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'versionNo'">
          <span class="inline-flex items-center gap-2">
            v{{ record.versionNo }}
            <Tag
              v-if="record.versionNo === props.currentVersionNo"
              color="green"
            >
              当前
            </Tag>
            <Tag v-else>历史快照</Tag>
          </span>
        </template>
        <template v-else-if="column.key === 'price'">
          {{ formatMoney(record.price, record.currency) }}
        </template>
        <template v-else-if="column.key === 'termMonths'">
          {{ record.termMonths ?? '—' }}
        </template>
        <template v-else-if="column.key === 'effectiveFrom'">
          {{ formatDate(record.effectiveFrom) }}
        </template>
        <template v-else-if="column.key === 'createdBy'">
          {{ record.createdBy ?? '—' }}
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ formatDateTime(record.createdAt) }}
        </template>
      </template>

      <template #emptyText>
        <div class="py-6 text-center text-sm text-muted-foreground">
          该套餐尚无价格版本。新建套餐时会同时写入第 1 个版本。
        </div>
      </template>
    </Table>
  </Card>
</template>
