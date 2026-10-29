import { computed, ref } from 'vue';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

export interface LookupOption {
  value: string;
  label: string;
}

/** 契约允许的最大每页条数：客户总量没有上限，只能靠关键字缩小范围后再分页。 */
const SEARCH_PAGE_SIZE = 100;

/**
 * 客户下拉选项。
 *
 * 两个约束决定了实现方式：
 * 1. 客户列表是分页接口，没有「拉全量」的入口，所以下拉走服务端关键字检索；
 * 2. 选中项必须在重新检索后仍然可见，否则用户会以为选择丢了。
 */
export function useCustomerOptions() {
  const auth = useAuthStore();
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
      const result = await auth.api.call('listCustomers', {
        body: {
          page: 1,
          pageSize: SEARCH_PAGE_SIZE,
          sort: 'name',
          order: 'asc',
          ...(keyword ? { keyword } : {}),
        },
      });
      // 快速输入时丢弃过期响应，避免旧关键字的结果覆盖新结果。
      if (current !== seq) return;
      results.value = result.items.map((item) => ({ value: item.id, label: item.name }));
    } catch (cause) {
      if (current !== seq) return;
      results.value = [];
      error.value = cause instanceof ApiClientError ? cause.message : '客户下拉加载失败';
    } finally {
      if (current === seq) loading.value = false;
    }
  }

  /** 输入停顿后再查，避免每敲一个字都打一次接口。 */
  function search(keyword: string) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(keyword.trim()), 300);
  }

  /**
   * 保证某个客户 id 能显示成人名：编辑订单、URL 还原筛选条件都只有 id。
   * 详情读取失败不影响按 id 过滤，退化成占位文案而不是把裸 id 显示给用户。
   */
  async function ensure(id: string, label?: string) {
    if (!id) return;
    if (label) {
      selected.value = { value: id, label };
      return;
    }
    if (selected.value?.value === id) return;
    try {
      const result = await auth.api.call('getCustomer', { params: { customerId: id } });
      selected.value = { value: result.customer.id, label: result.customer.name };
    } catch {
      selected.value = { value: id, label: '已选客户' };
    }
  }

  /** 记录当前选中的客户名，供下次还原筛选条件时直接复用。 */
  function select(value: string | undefined) {
    if (!value) {
      selected.value = null;
      return;
    }
    const option = options.value.find((item) => item.value === value);
    selected.value = option ?? { value, label: '已选客户' };
  }

  return { options, loading, error, load, search, ensure, select };
}
