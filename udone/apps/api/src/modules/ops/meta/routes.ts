import { Hono } from 'hono';
import {
  OPS_CONTRACT_VERSION,
  OPS_SALES_MODES,
  OPS_SUPPORTED_CURRENCIES,
  OPS_ROUTES,
  OPS_TIMEZONE,
} from '@erp/contracts';
import { respond } from '../../../lib/contract';
import type { ApiEnvironment } from '../../../middleware/auth';
import { requireOpsAuth } from '../../../middleware/ops-auth';

export const opsMetaRoutes = new Hono<ApiEnvironment>();

/**
 * `GET /api/v1/ops/meta` —— 端点自述。
 *
 * 五个字段全部来自契约包里的常量，handler 里不出现任何字面量。这不是洁癖：
 * `supportedCurrencies` 一旦在 handler 里写死一份，放开币种时就会有人只改
 * `/meta` 而漏掉端点校验，于是出现「/meta 说只支持 CNY、接口却收了 USD」
 * 的两套口径（U-23 定的就是这件事）。
 *
 * `serverTime` 每次现算，不缓存：它的用途是让前端校正本地时钟偏差，
 * 一个缓存过的值恰好会让偏差算错。
 */
opsMetaRoutes.get(OPS_ROUTES.getOpsMeta.path, requireOpsAuth(), (context) =>
  respond(context, 'getOpsMeta', {
    contractVersion: OPS_CONTRACT_VERSION,
    serverTime: new Date().toISOString(),
    timezone: OPS_TIMEZONE,
    supportedSalesModes: [...OPS_SALES_MODES],
    supportedCurrencies: [...OPS_SUPPORTED_CURRENCIES],
  }),
);
