/**
 * 服务端业务日期（`Asia/Shanghai`）的取用封装。
 *
 * 为什么不用 `new Date()`：契约 §2.3 规定「今天」按运营端业务时区计算，且源码参考门
 * §5.4 明确禁止前端用本地时钟判断逾期/超时（客户端时钟与时区不可信，会产生假告警）。
 *
 * 因此维护期判定所需的「今天」一律来自 `GET /meta` 的 `serverTime`（契约 §5.1），
 * 按服务端返回的 `timezone` 折算为 `YYYY-MM-DD`；取不到时保持 `null`，
 * 页面显示「无法判定」，不退回本地时钟。
 */
import { ref } from 'vue';

import { businessDateOf } from '#/api/ops/deployment';
import { fetchOpsMeta } from '#/api/ops/identity';

export function useServerToday() {
  const today = ref<null | string>(null);
  const failed = ref(false);

  /** 拉取服务端时间；失败只影响「维护期高亮」，不影响列表本身。 */
  async function load(): Promise<void> {
    try {
      const meta = await fetchOpsMeta();
      today.value = businessDateOf(
        meta.serverTime,
        meta.timezone || 'Asia/Shanghai',
      );
      failed.value = today.value === null;
    } catch {
      today.value = null;
      failed.value = true;
    }
  }

  return { failed, load, today };
}
