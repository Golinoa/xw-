/**
 * 运营总览（契约 §5.9 `GET /overview`）。
 *
 * 三条口径来自契约，前端不得自行改写：
 * 1. **只读**：`statisticsAt` 是服务端统计时刻，页面所有「截至」文案都用它，
 *    不读浏览器时钟。页面上不出现「几秒前」这类本地推导（契约 §2.3）。
 * 2. **不跨币种合并**：`amounts[]` 按币种分组，前端不做汇率折算，也不把多币种
 *    加成一个总数（契约 §2.2 / U-12）。
 * 3. **金额只格式化不累加**：所有合计取服务端字段，`formatMoney()` 只做千分位。
 */
import type { OpsOverview } from './types';

import { requestClient } from '#/api/request';

import { OPS_ENDPOINTS } from './endpoints';

export interface OverviewQuery {
  /** 临期窗口天数；不传则由服务端取 `settings.overview.expiryWindowDays`。 */
  windowDays?: number;
}

/** 总览指标（需 `overview.read`）。 */
export async function fetchOverview(
  query: OverviewQuery = {},
): Promise<OpsOverview> {
  if (import.meta.env.VITE_OPS_MOCK === 'true') {
    const { stubOverview } = await import('./dev-stub');
    return stubOverview(query);
  }
  return requestClient.get<OpsOverview>(OPS_ENDPOINTS.overview, {
    params: query.windowDays ? { windowDays: query.windowDays } : {},
  });
}
