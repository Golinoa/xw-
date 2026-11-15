import { computed, ref } from 'vue';
import type { TourRoute } from '@erp/contracts';
import { ApiClientError } from '../../lib/api-client';
import { useAuthStore } from '../../stores/auth';

export interface RouteOption {
  value: string;
  label: string;
}

/** 契约允许的最大每页条数：线路总量没有上限，只能靠关键字缩小范围。 */
const SEARCH_PAGE_SIZE = 100;

/**
 * 线路下拉选项。
 *
 * **选项的 value 是线路名，不是 id。** 订单保存的就是名称快照，
 * 用 id 反而要多一层「id → 名称」的映射，还得在回填历史订单时造一个
 * 假 id 去撑住下拉显示。名称在组织内唯一（`routes_name_key`），足以做键。
 */
export function useRouteOptions() {
  const auth = useAuthStore();
  const results = ref<RouteOption[]>([]);
  const selected = ref<RouteOption | null>(null);
  const loading = ref(false);
  const error = ref('');
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const options = computed<RouteOption[]>(() => {
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
      const result = await auth.api.call('listRoutes', {
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
      results.value = result.items.map((item) => ({ value: item.name, label: item.name }));
    } catch (cause) {
      if (current !== seq) return;
      results.value = [];
      error.value = cause instanceof ApiClientError ? cause.message : '线路下拉加载失败';
    } finally {
      if (current === seq) loading.value = false;
    }
  }

  function search(keyword: string) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void load(keyword.trim()), 300);
  }

  /**
   * 让一个「只有名称」的值在下拉里可见。
   *
   * 编辑历史订单时会遇到两种名字：线路表里的，和当年手打、后来没建档的。
   * 后者若不钉住，`a-select` 会显示空白，用户一保存就把它清成了 null ——
   * 那是悄悄改数据，不是编辑。
   */
  function ensure(name: string) {
    if (!name) {
      selected.value = null;
      return;
    }
    selected.value = { value: name, label: name };
  }

  /** 快捷新建成功后立刻可选，不必整页重载。 */
  function add(route: TourRoute) {
    ensure(route.name);
  }

  return { options, loading, error, load, search, ensure, add };
}
