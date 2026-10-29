<script lang="ts" setup>
import { computed } from 'vue';

import { Alert, Tag } from 'ant-design-vue';

import { deploymentMaintenanceNotice } from '#/api/ops/deployment';

defineOptions({ name: 'DeploymentMaintenanceBanner' });

/**
 * 维护期横幅（**「永久授权 ≠ 永久更新」的界面落点**）。
 *
 * 规则来源：PRD §6.6「私有化授权保存……维护期限；永久授权不得推导为永久软件更新服务」，
 * 契约 §3.7 `maintenance_until` 是独立列。
 *
 * 三件事必须同时成立：
 * 1. 维护期状态单独、显式提示（未到期 / 30 天内到期 / 已到期），与授权方式无关；
 * 2. 关联了永久授权时，追加「永久授权只表示软件使用无到期日」的说明，**不**据此放宽升级；
 * 3. 判定用的「今天」必须来自服务端（`referenceDate`），拿不到时显示「无法判定」。
 */
const props = withDefaults(
  defineProps<{
    maintenanceUntil?: null | string;
    /** 关联的永久授权号（为空表示没有永久授权，不显示该段说明）。 */
    perpetualLicenseNos?: string[];
    /** 服务端业务日期 `YYYY-MM-DD`，来自 `useServerToday()`；`null` 表示无法判定。 */
    referenceDate?: null | string;
  }>(),
  {
    maintenanceUntil: null,
    perpetualLicenseNos: () => [],
    referenceDate: null,
  },
);

const notice = computed(() =>
  deploymentMaintenanceNotice({
    maintenanceUntil: props.maintenanceUntil,
    perpetualLicenseNos: props.perpetualLicenseNos,
    referenceDate: props.referenceDate,
  }),
);

const alertType = computed(() => {
  switch (notice.value.view.state) {
    case 'expired': {
      return 'error' as const;
    }
    case 'expiring': {
      return 'warning' as const;
    }
    case 'unknown': {
      return 'warning' as const;
    }
    default: {
      return 'info' as const;
    }
  }
});
</script>

<template>
  <div data-testid="deployment-maintenance-banner">
    <Alert
      :data-testid="`deployment-maintenance-${notice.view.state}`"
      :message="notice.view.label"
      show-icon
      :type="alertType"
    >
      <template #description>
        <p>{{ notice.view.summary }}</p>
        <p class="mt-1 text-xs">
          维护期只决定「是否包含版本升级与技术支持」，与授权是否永久无关。
        </p>
      </template>
    </Alert>

    <Alert
      v-if="notice.permanentNote"
      class="mt-2"
      data-testid="deployment-perpetual-note"
      :message="notice.permanentNote"
      show-icon
      type="info"
    >
      <template #description>
        <div class="flex flex-wrap items-center gap-2">
          <Tag v-for="no in perpetualLicenseNos" :key="no" color="blue">
            {{ no }}
          </Tag>
          <span>升级前请确认维护期是否仍在服务期内。</span>
        </div>
      </template>
    </Alert>
  </div>
</template>
