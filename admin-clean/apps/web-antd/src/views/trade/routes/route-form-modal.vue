<script lang="ts" setup>
import type { CreateTourRouteRequest, TourRoute } from '@erp/contracts';

import { computed, reactive, ref, watch } from 'vue';

import {
  Alert,
  Checkbox,
  Form,
  FormItem,
  Input,
  InputNumber,
  Modal,
  Textarea,
} from 'ant-design-vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

/**
 * `route` 有值就是编辑，没值就是新建。
 *
 * 编辑走 `updateRoute`（空值发 `null` 表示清空），新建走 `createRoute`（空值省略）；
 * 两者语义不同，不能合并成一次「把表单原样发过去」。
 */
const props = defineProps<{ open: boolean; route?: null | TourRoute }>();

const emit = defineEmits<{
  saved: [route: TourRoute];
  'update:open': [value: boolean];
}>();

const authStore = useAuthStore();
const saving = ref(false);
const formError = ref('');

const isEdit = computed(() => Boolean(props.route));

const form = reactive({
  days: undefined as number | undefined,
  departureCity: '',
  isSelfGroup: false,
  name: '',
  region: '',
  remark: '',
  routeType: '',
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
    form.days = current?.days;
    form.isSelfGroup = current?.isSelfGroup ?? false;
    form.remark = current?.remark ?? '';
  },
);

function describeError(cause: unknown): string {
  if (cause instanceof ApiClientError) {
    if (cause.code === 'CONFLICT') return $t('shell.tourRoutes.nameConflict');
    return cause.message;
  }
  return $t('shell.tourRoutes.saveFailed');
}

async function submit() {
  if (saving.value) return;
  formError.value = '';
  const name = form.name.trim();
  if (!name) {
    formError.value = $t('shell.tourRoutes.nameRequired');
    return;
  }

  saving.value = true;
  try {
    if (props.route) {
      const result = await authStore.api.call('updateRoute', {
        body: {
          days: form.days ?? null,
          departureCity: form.departureCity.trim() || null,
          isSelfGroup: form.isSelfGroup,
          name,
          region: form.region.trim() || null,
          remark: form.remark.trim() || null,
          routeType: form.routeType.trim() || null,
        },
        params: { routeId: props.route.id },
      });
      emit('saved', result.route);
      emit('update:open', false);
      return;
    }

    const body: CreateTourRouteRequest = {
      isSelfGroup: form.isSelfGroup,
      name,
      ...(form.routeType.trim() ? { routeType: form.routeType.trim() } : {}),
      ...(form.region.trim() ? { region: form.region.trim() } : {}),
      ...(form.departureCity.trim() ? { departureCity: form.departureCity.trim() } : {}),
      ...(form.days ? { days: form.days } : {}),
      ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
    };
    const result = await authStore.api.call('createRoute', { body });
    emit('saved', result.route);
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
</script>

<template>
  <Modal
    :cancel-text="$t('shell.tourRoutes.cancel')"
    :closable="!saving"
    :confirm-loading="saving"
    :mask-closable="!saving"
    :ok-text="$t('shell.tourRoutes.save')"
    :open="open"
    :title="isEdit ? $t('shell.tourRoutes.editTitle') : $t('shell.tourRoutes.createTitle')"
    @cancel="close"
    @ok="submit"
  >
    <Alert v-if="formError" class="mb-4" :message="formError" role="alert" show-icon type="error" />
    <Form layout="vertical" :model="form">
      <div class="grid grid-cols-2 gap-x-4">
        <FormItem class="col-span-2" html-for="route-name" :label="$t('shell.tourRoutes.formName')" required>
          <Input id="route-name" v-model:value="form.name" :maxlength="100" />
        </FormItem>
        <FormItem html-for="route-type" :label="$t('shell.tourRoutes.formRouteType')">
          <Input id="route-type" v-model:value="form.routeType" :maxlength="30" />
          <span class="text-xs text-muted-foreground">{{ $t('shell.tourRoutes.freeTextHint') }}</span>
        </FormItem>
        <FormItem html-for="route-region" :label="$t('shell.tourRoutes.formRegion')">
          <Input id="route-region" v-model:value="form.region" :maxlength="50" />
        </FormItem>
        <FormItem html-for="route-departure" :label="$t('shell.tourRoutes.formDepartureCity')">
          <Input id="route-departure" v-model:value="form.departureCity" :maxlength="50" />
        </FormItem>
        <FormItem html-for="route-days" :label="$t('shell.tourRoutes.formDays')">
          <InputNumber
            id="route-days"
            v-model:value="form.days"
            class="w-full"
            :max="365"
            :min="1"
            :precision="0"
          />
        </FormItem>
        <FormItem html-for="route-self-group" :label="$t('shell.tourRoutes.formSelfGroup')">
          <Checkbox id="route-self-group" v-model:checked="form.isSelfGroup">
            {{ $t('shell.tourRoutes.formSelfGroupHint') }}
          </Checkbox>
        </FormItem>
      </div>
      <FormItem html-for="route-remark" :label="$t('shell.tourRoutes.formRemark')">
        <Textarea id="route-remark" v-model:value="form.remark" :maxlength="2000" :rows="2" />
      </FormItem>
    </Form>
  </Modal>
</template>
