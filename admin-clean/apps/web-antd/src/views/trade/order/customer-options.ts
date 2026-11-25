import { computed, ref } from 'vue';

import { ApiClientError } from '#/lib/api-client';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

export interface LookupOption {
  value: string;
  label: string;
}

/** 契约允许的最大每页条数：客户没有拉全量的入口，只能靠关键字缩小范围。 */
const SEARCH_PAGE_SIZE = 100;

/**
 * 客户下拉：服务端关键字检索 + 选中项钉住。
 * 选中项必须在重新检索后仍可见，否则用户会以为选择丢了。
 */
export function useCustomerOptions() {
  const authStore = useAuthStore();
  const results = ref<LookupOption[]>([]);
  const selected = ref<LookupOption | null>(null);
  const loading = ref(false);
  const error = ref('');
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const options = computed<LookupOption[]>(() => {
    const pinned = selected.value;
    if (pinned && !results.value.some((item) => item.value === pinned.value)) {
      return [pinned, ...results.value];
    }
    return results.value;
  });

  async function load(keyword = '') {
    const current = ++seq;
    loading.value = true;
    error.value = '';
    try {
      const result = await authStore.api.call('listCustomers', {
        body: {
          order: 'asc',
          page: 1,
          pageSize: SEARCH_PAGE_SIZE,
          sort: 'name',
          ...(keyword ? { keyword } : {}),
        },
      });
      if (current !== seq) return;
      results.value = result.items.map((item) => ({ label: item.name, value: item.id }));
    } catch (error_) {
      if (current !== seq) return;
      results.value = [];
      error.value = error_ instanceof ApiClientError ? error_.message : $t('shell.orders.customerLoadFailed');
    } finally {
      if (current === seq) loading.value = false;
    }
  }

  /** 输入停顿后再查，避免每敲一个字都打一次接口。 */
  function search(keyword: string) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(keyword.trim()), 300);
  }

  /** 编辑订单/URL 还原筛选只有 id，补出人名；详情失败退化为占位文案，不显示裸 id。 */
  async function ensure(id: string, label?: string) {
    if (!id) return;
    if (label) {
      selected.value = { label, value: id };
      return;
    }
    if (selected.value?.value === id) return;
    try {
      const result = await authStore.api.call('getCustomer', { params: { customerId: id } });
      selected.value = { label: result.customer.name, value: result.customer.id };
    } catch {
      selected.value = { label: $t('shell.orders.customerFallback'), value: id };
    }
  }

  function select(value: string | undefined) {
    if (!value) {
      selected.value = null;
      return;
    }
    const option = options.value.find((item) => item.value === value);
    selected.value = option ?? { label: $t('shell.orders.customerFallback'), value };
  }

  return { ensure, error, load, loading, options, search, select };
}
