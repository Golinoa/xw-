import { z } from 'zod';

/**
 * 资金账户与余额（R-BALANCE-01）。
 *
 * 余额口径只有一个真源：数据库函数 `public.account_balances()`。
 * 这里只定义形状，绝不写任何金额计算——前端拿到什么就显示什么，
 * 「期初 + 已确认收款 − 已确认付款 + 调整」这件事只在数据库里算一遍。
 */

export const FUND_METHODS = ['cash', 'bank', 'alipay', 'wechat', 'other'] as const;
export const fundMethodSchema = z.enum(FUND_METHODS);
export type FundMethod = z.infer<typeof fundMethodSchema>;

export const fundAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  method: fundMethodSchema,
  openingBalance: z.number(),
  remark: z.string().optional(),
});
export type FundAccount = z.infer<typeof fundAccountSchema>;

export const accountBalanceSchema = z.object({
  accountId: z.string().min(1),
  accountName: z.string(),
  method: fundMethodSchema,
  openingBalance: z.number(),
  confirmedIn: z.number(),
  confirmedOut: z.number(),
  adjustments: z.number(),
  balance: z.number(),
});
export type AccountBalance = z.infer<typeof accountBalanceSchema>;

export const accountBalanceListResponseSchema = z.object({
  items: z.array(accountBalanceSchema),
});
export type AccountBalanceListResponse = z.infer<typeof accountBalanceListResponseSchema>;

export const createFundAccountRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  method: fundMethodSchema,
  openingBalance: z.number().min(0).default(0),
  remark: z.string().trim().max(200).optional(),
});
export type CreateFundAccountRequest = z.infer<typeof createFundAccountRequestSchema>;

export const createFundAccountResponseSchema = z.object({
  accountId: z.string().min(1),
});
export type CreateFundAccountResponse = z.infer<typeof createFundAccountResponseSchema>;

export const adjustBalanceRequestSchema = z.object({
  accountId: z.string().min(1),
  amount: z.number().refine((value) => value !== 0, 'amount must not be zero'),
  reason: z.string().trim().min(1).max(200),
});
export type AdjustBalanceRequest = z.infer<typeof adjustBalanceRequestSchema>;

export const adjustBalanceResponseSchema = z.object({
  adjustmentId: z.string().min(1),
});
export type AdjustBalanceResponse = z.infer<typeof adjustBalanceResponseSchema>;
