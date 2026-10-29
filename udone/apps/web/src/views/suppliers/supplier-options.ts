import { ref } from 'vue';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

export interface SupplierOption {
  value: string;
  label: string;
}

/** 应付行下拉与供应商页共用同一页大小上限。 */
const SUPPLIER_PAGE_SIZE = 100;

/**
 * 供应商下拉选项：供应商数量有限，一次拉一页（含停用过滤）后在本地筛选，
 * 不必为每次按键再打一次接口。
 */
export function useSupplierOptions() {
  const auth = useAuthStore();
  const options = ref<SupplierOption[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function load() {
    loading.value = true;
    error.value = '';
    try {
      const result = await auth.api.call('listSuppliers', {
        body: {
          page: 1,
          pageSize: SUPPLIER_PAGE_SIZE,
          sort: 'name',
          order: 'asc',
          activeOnly: 'true',
        },
      });
      options.value = result.items.map((item) => ({ value: item.id, label: item.name }));
    } catch (cause) {
      options.value = [];
      error.value = cause instanceof ApiClientError ? cause.message : '供应商列表加载失败';
    } finally {
      loading.value = false;
    }
  }

  /** 快捷新建成功后立刻可在下拉里选中，不需要整页重载。 */
  function add(supplier: { id: string; name: string }) {
    if (options.value.some((item) => item.value === supplier.id)) return;
    options.value = [{ value: supplier.id, label: supplier.name }, ...options.value];
  }

  return { options, loading, error, load, add };
}

/** a-select 的本地过滤：按名称不区分大小写包含匹配（label 非字符串时退回 value）。 */
export function filterSupplierOption(
  input: string,
  option?: { label?: unknown; value?: unknown },
): boolean {
  const text = typeof option?.label === 'string' ? option.label : String(option?.value ?? '');
  return text.toLowerCase().includes(input.trim().toLowerCase());
}
