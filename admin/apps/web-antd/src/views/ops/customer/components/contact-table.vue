<script lang="ts" setup>
/**
 * 联系人列表（含联系方式掩码分支）。
 *
 * 安全口径 [PRD §6.2] [PRD §10.2] [契约 §5.2]：
 * - 默认只展示后端下发的 `phoneMasked`/`emailMasked`；
 * - 仅当账号具备 `customer.sensitive.read` 且后端下发了原值时展示原值；
 * - 前端**不**自行脱敏、也不反推原值（脱敏是后端的责任，前端不能成为唯一防线）。
 */
import type { CustomerContact } from '#/api/ops/customer';

import { Button, Space, Table, Tag } from 'ant-design-vue';

import { displayText } from '../format';

defineOptions({ name: 'CustomerContactTable' });

const props = withDefaults(
  defineProps<{
    canReadSensitive?: boolean;
    canWrite?: boolean;
    contacts: CustomerContact[];
    loading?: boolean;
  }>(),
  { canReadSensitive: false, canWrite: false, loading: false },
);

const emit = defineEmits<{
  add: [];
  delete: [contact: CustomerContact];
  edit: [contact: CustomerContact];
}>();

const columns = [
  { dataIndex: 'name', key: 'name', title: '姓名', width: 180 },
  { dataIndex: 'jobTitle', key: 'jobTitle', title: '职务', width: 140 },
  { dataIndex: 'phone', key: 'phone', title: '手机', width: 160 },
  { dataIndex: 'email', key: 'email', title: '邮箱', width: 220 },
  { dataIndex: 'usageScene', key: 'usageScene', title: '使用场景', width: 140 },
  { key: 'actions', title: '操作', width: 150 },
];

/** 展示手机号：有敏感权限且拿到原值才显示原值，否则显示掩码。 */
function phoneText(contact: CustomerContact): string {
  if (props.canReadSensitive && contact.phone) {
    return contact.phone;
  }
  return displayText(contact.phoneMasked);
}

function emailText(contact: CustomerContact): string {
  if (props.canReadSensitive && contact.email) {
    return contact.email;
  }
  return displayText(contact.emailMasked);
}

/**
 * antd 的 `#bodyCell` 插槽把 `record` 声明为 `Record<string, any>`（第三方边界），
 * 这里收敛为行类型，避免在模板里散落断言。数据来源是组件自己的 `contacts` prop。
 */
function asContact(record: Record<string, unknown>): CustomerContact {
  return record as unknown as CustomerContact;
}
</script>

<template>
  <div>
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-xs text-muted-foreground">
        <template v-if="props.canReadSensitive">
          当前账号具备 customer.sensitive.read，联系方式显示后端下发的原值。
        </template>
        <template v-else>
          联系方式按最小必要原则掩码显示；需查看原值请申请
          customer.sensitive.read 权限。
        </template>
      </p>
      <Button
        v-if="props.canWrite"
        type="primary"
        size="small"
        @click="emit('add')"
      >
        新增联系人
      </Button>
    </div>

    <Table
      size="small"
      row-key="id"
      :columns="columns"
      :data-source="props.contacts"
      :loading="props.loading"
      :pagination="false"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <Space>
            <span>{{ record.name }}</span>
            <Tag v-if="record.isPrimary" color="blue">主要</Tag>
          </Space>
        </template>
        <template v-else-if="column.key === 'jobTitle'">
          {{ displayText(record.jobTitle) }}
        </template>
        <template v-else-if="column.key === 'phone'">
          {{ phoneText(asContact(record)) }}
        </template>
        <template v-else-if="column.key === 'email'">
          {{ emailText(asContact(record)) }}
        </template>
        <template v-else-if="column.key === 'usageScene'">
          {{ displayText(record.usageScene) }}
        </template>
        <template v-else-if="column.key === 'actions'">
          <Space v-if="props.canWrite">
            <Button
              type="link"
              size="small"
              @click="emit('edit', asContact(record))"
            >
              编辑
            </Button>
            <Button
              type="link"
              size="small"
              danger
              @click="emit('delete', asContact(record))"
            >
              删除
            </Button>
          </Space>
          <span v-else class="text-xs text-muted-foreground">只读</span>
        </template>
      </template>

      <template #emptyText>
        <div class="py-6 text-center text-sm text-muted-foreground">
          该客户暂无联系人。客户进入交付前必须至少有一条联系人（契约 §3.1）。
        </div>
      </template>
    </Table>
  </div>
</template>
