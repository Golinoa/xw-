# C7 账户余额（R-BALANCE-01）

日期：2026-11-19 · 卡片：P2-C7（L）· 出口：资金账户 + 实时余额口径 + 调整流水

## 结果

| 门禁 | 结果 |
|---|---|
| pgTAP | 47 文件全绿，`fund_accounts.sql` 8 断言 |
| Vitest | 71 文件 / 902 用例全绿 |
| HTTP 集成 | 29 文件 / 432 用例全绿 |
| tsc + vue-tsc / lint / CSS token | 通过 |
| schema:check（55 迁移）/ build | 通过 |

## 交付面

- 迁移 `20261119000003_fund_accounts.sql`：
  - `fund_accounts`（method 唯一映射一个账户）+ `balance_adjustments`（只 INSERT，不 UPDATE/DELETE）；
  - 余额函数 `account_balances()`：期初 + 已确认收款 − 已确认付款 + 调整，**实时算，不存冗余**；
  - 写函数 `create_fund_account` / `adjust_account_balance`，权限与 API 层一致。
- 契约：`balances.ts` + 3 个端点。
- API：`GET /api/account-balances`、`POST /api/fund-accounts`、`POST /api/account-balances/adjust`。
- Web：`/balances` 余额页，展示余额构成，建账户/调账弹窗，按权限隐藏入口。
- 测试：pgTAP 8 断言、API 单测 5 条、HTTP 集成 5 条。

## 资损口径（写死在数据库函数里，前端不许自己算）

1. 只认 `finance_applications.status = 'approved'`；pending / rejected / withdrawn 一律不计。
2. 按 method 归集：一个 method 在一家机构只有一个资金账户。
3. 调整流水不可变；改错用反向记录冲正，不涂改历史。
4. 余额不存列：避免「流水改了余额没变」这种资损级不一致。

## 踩过的坑（下次直接照做）

1. **PostgREST RPC 返回字段以函数声明为准**：我写成 `RETURNS TABLE(result_account_id ...)`，
   服务层却取 `row.result`，永远拿到空值 → 全部误判成 `INVALID_ACCOUNT`。
   规则：新 RPC 先核对 `RETURNS TABLE` 的列名，服务层取同名。
2. **外键 `(account_id, organization_id)` 要求被引用表有对应联合唯一约束**：
   只给 `fund_accounts.id` 加主键不够，必须显式加 `UNIQUE (id, organization_id)`。
3. **pgTAP 审批链不能用同一个人自审**：admin 建单又自己一级审批会被「禁止自审」拒，
   余额始终不变。要按 operator 提交 → finance 一级 → admin 二级搭三个身份。
4. **operator 的 dataScope=own**：客户必须由 operator 建，否则 `customer_not_available`。
5. **pgTAP 的 `IS()` 要求两侧同类型**：numeric 余额 vs 整数字面量会报
   `function is(numeric, integer) does not exist`，期望值要写 `1000::numeric`。

## 边界

- 余额按付款方式归集，不是按具体银行卡/账户实例——一个 method 只有一个账户。
- 期初余额建账户时设定，之后不能改（要改走调整流水）。
- 临期/出团提醒仍属 C9 未覆盖部分，与本卡无关。
