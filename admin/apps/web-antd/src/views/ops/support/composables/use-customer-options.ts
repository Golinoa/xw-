/**
 * 客户选择项（工单页的客户筛选与建单客户选择共用）。
 *
 * 为什么在这里重新取客户：工单只存 `customerId`（契约 §3.8），页面需要把 id 显示成
 * 名称，并且按客户筛选工单。`GET /customers` 需要 `customer.read`，预置的售后支持角色
 * 有该动作码，因此这是允许的只读跨域调用（不写客户数据，也不缓存全量列表）。
 *
 * 一律走服务端关键字搜索（`pageSize` 取 20），不做「先拉全量再前端过滤」。
 */
import { ref } from 'vue';

import { toOpsApiError } from '#/api/adapter/errors';
import { fetchCustomers } from '#/api/ops/customer';

export interface CustomerOption {
  label: string;
  value: string;
}

export function useCustomerOptions() {
  const options = ref<CustomerOption[]>([]);
  const loading = ref(false);
  const error = ref<null | string>(null);

  async function search(keyword = ''): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await fetchCustomers({
        keyword: keyword.trim() === '' ? undefined : keyword.trim(),
        order: 'asc',
        page: 1,
        pageSize: 20,
        sort: 'name',
      });
      options.value = result.items.map((item) => ({
        label: `${item.name}（${item.customerNo}）`,
        value: item.id,
      }));
    } catch (error_) {
      error.value = toOpsApiError(error_).displayMessage;
      options.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 首次展开时加载一批，之后由用户输入触发服务端搜索。 */
  async function ensureLoaded(): Promise<void> {
    if (options.value.length === 0 && !loading.value) {
      await search();
    }
  }

  return { ensureLoaded, error, loading, options, search };
}
