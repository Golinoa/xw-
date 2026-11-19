<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { type CreateTourRouteRequest, type TourRoute } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

/**
 * `route` 有值就是编辑，没值就是新建。
 *
 * 编辑走 `updateRoute`（空值发 null 表示清空），新建走 `createRoute`
 * （空值省略）。两者语义不同，不能合并成一次「把表单原样发过去」。
 */
const props = defineProps<{ open: boolean; route?: TourRoute | null }>();
const isEdit = computed(() => Boolean(props.route));

const emit = defineEmits<{
  'update:open': [value: boolean];
  saved: [route: TourRoute];
}>();

const auth = useAuthStore();
const saving = ref(false);
const formError = ref('');

const form = reactive({
  name: '',
  routeType: '',
  region: '',
  departureCity: '',
  days: null as number | null,
  isSelfGroup: false,
  remark: '',
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    formError.value = '';
    const current = props.route;
    form.name = current?.name ?? '';
    form.routeType = current?.routeType ?? '';
    form.region = current?.region ?? '';
    form.departureCity = current?.departureCity ?? '';
    form.days = current?.days ?? null;
    form.isSelfGroup = current?.isSelfGroup ?? false;
    form.remark = current?.remark ?? '';
  },
);

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'CONFLICT') return '线路名称已存在，请换一个名称';
    return cause.message;
  }
  return '保存失败，请稍后重试';
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  const name = form.name.trim();
  if (!name) {
    formError.value = '请填写线路名称';
    return;
  }

  saving.value = true;
  try {
    if (props.route) {
      const result = await auth.api.call('updateRoute', {
        params: { routeId: props.route.id },
        body: {
          name,
          routeType: form.routeType.trim() || null,
          region: form.region.trim() || null,
          departureCity: form.departureCity.trim() || null,
          days: form.days ?? null,
          isSelfGroup: form.isSelfGroup,
          remark: form.remark.trim() || null,
        },
      });
      emit('saved', result.route);
      emit('update:open', false);
      return;
    }

    const body: CreateTourRouteRequest = {
      name,
      ...(form.routeType.trim() ? { routeType: form.routeType.trim() } : {}),
      ...(form.region.trim() ? { region: form.region.trim() } : {}),
      ...(form.departureCity.trim() ? { departureCity: form.departureCity.trim() } : {}),
      ...(form.days ? { days: form.days } : {}),
      isSelfGroup: form.isSelfGroup,
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
    };
    const result = await auth.api.call('createRoute', { body });
    emit('saved', result.route);
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
</script>

<template>
  <a-modal
    :open="open"
    :title="isEdit ? '编辑线路' : '新建线路'"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :closable="!saving"
    :ok-text="isEdit ? '保存' : '保存并选中'"
    cancel-text="取消"
    width="620px"
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
      <div class="form-grid">
        <a-form-item label="线路名称" required class="span-2">
          <a-input v-model:value="form.name" :maxlength="100" placeholder="如：云南六日游" />
        </a-form-item>
        <a-form-item label="线路类型">
          <a-input v-model:value="form.routeType" :maxlength="30" placeholder="如：境内跟团" />
          <span class="field-hint">公司字典落地前为自由填写</span>
        </a-form-item>
        <a-form-item label="地区">
          <a-input v-model:value="form.region" :maxlength="50" placeholder="如：云南" />
        </a-form-item>
        <a-form-item label="出发城市">
          <a-input v-model:value="form.departureCity" :maxlength="50" placeholder="如：杭州" />
        </a-form-item>
        <a-form-item label="天数">
          <a-input-number
            v-model:value="form.days"
            class="number-input"
            :min="1"
            :max="365"
            :precision="0"
          />
        </a-form-item>
        <a-form-item label="自组团">
          <a-checkbox v-model:checked="form.isSelfGroup">本公司独立成团</a-checkbox>
        </a-form-item>
      </div>
      <a-form-item label="备注">
        <a-textarea v-model:value="form.remark" :maxlength="2000" :rows="2" placeholder="可选" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.form-error {
  margin-bottom: var(--space-16);
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

.field-hint {
  display: block;
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
}
</style>
