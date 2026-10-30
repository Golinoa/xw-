import { z } from 'zod';

/**
 * 运营后端的端点自述（契约 §5.1 `GET /meta`）。
 *
 * 为什么这个端点值得单独一个文件：它是前端唯一能在「还没登录」时也判断
 * 「对端是不是它以为的那个后端」的地方。契约版本不匹配时，前端必须快速失败
 * 并停在拒绝页，而不是退回 mock 继续跑——退回 mock 的后果是前端全绿、
 * 后端一行没通，而这个状态可以持续几周不被发现（本轮就这么发生过一次）。
 *
 * 两个能力数组是**白名单**，不是能力枚举：`supportedCurrencies` 在 v1 只报
 * `['CNY']`，端点侧也必须只接受 `CNY`（U-23）。放开币种时两处同一次变更，
 * 否则会出现「/meta 说只支持 CNY、接口却收了 USD」的两套口径——这种不一致
 * 最难查，因为两边都「没错」。
 */

/**
 * 契约版本。semver，无 `v` 前缀、无日期后缀。
 *
 * 不用日期串：前端的判定规则是 `MAJOR.MINOR.PATCH` 比较，日期串会被判成
 * MALFORMED，表现为「版本门失败 → 全站停在拒绝页」。带上 `v` 前缀同理。
 */
export const OPS_CONTRACT_VERSION = '1.0.0';

/**
 * 运营后台的业务时区。
 *
 * 固定值而不是读服务器本地时区：`isOverdue`、到期提醒、跨日统计都以它为基准，
 * 而 Worker 跑在 UTC 上，读本地时区会让同一个工单在两台机器上算出不同的逾期状态。
 */
export const OPS_TIMEZONE = 'Asia/Shanghai';

/**
 * 支持的销售模式，取自契约 §3.2 `ops.product_sales_modes.sales_mode` 的全部取值。
 *
 * 这段注释是唯一出处：T-01 验收要求「seed 与常量不得各写一份」，所以路由侧
 * 直接返回这个数组，不再在 handler 里硬编码字面量。
 */
export const OPS_SALES_MODES = ['saas', 'private'] as const;
export type OpsSalesMode = (typeof OPS_SALES_MODES)[number];

/** v1 只开放人民币。与 U-23 的白名单收窄一致，端点侧必须复用同一数组。 */
export const OPS_SUPPORTED_CURRENCIES = ['CNY'] as const;
export type OpsSupportedCurrency = (typeof OPS_SUPPORTED_CURRENCIES)[number];

export const opsSalesModeSchema = z.enum(OPS_SALES_MODES);
export const opsSupportedCurrencySchema = z.enum(OPS_SUPPORTED_CURRENCIES);

export const opsMetaResponseSchema = z.object({
  contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'contractVersion must be semver'),
  /**
   * RFC3339 UTC，必须带 `Z`。`z.iso.datetime()` 默认就要求 `Z`（不传 `offset`），
   * 所以前端拿到的字符串不需要再猜时区。
   */
  serverTime: z.iso.datetime(),
  timezone: z.literal(OPS_TIMEZONE),
  supportedSalesModes: z.array(opsSalesModeSchema).min(1),
  supportedCurrencies: z.array(opsSupportedCurrencySchema).min(1),
});

export type OpsMetaResponse = z.infer<typeof opsMetaResponseSchema>;
