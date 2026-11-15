# B1 审批轨迹不随明细行删除消失

日期：2026-11-15 · 卡片：P9-B1（P0）· 出口：pgTAP 19 条断言

## 问题

`order_receivables` / `order_payables` 被删时，`finance_applications` 的两个外键是
`ON DELETE CASCADE`，申请随之消失，`finance_application_actions`（只追加的审批轨迹）
再按自己的外键跟着消失。

`update_order_with_items` 里的删行守卫（`LINE_HAS_PAYMENTS`）只挡 `confirmed_amount > 0
OR pending_amount > 0` 的行。**被驳回 / 已撤回**的申请金额已归零，守卫拦不住 ——
于是「这行申请过什么、谁批的、为什么驳回」被一次订单编辑抹掉。

## 决策（两选一，已定）

计划里给的两个方向：

| 方案 | 后果 |
| --- | --- |
| A. 外键改 `ON DELETE RESTRICT` | 删行会 409 要求先「处置申请」。但驳回/撤回是**终态**，没有任何可处置动作 ⇒ 该行永远删不掉，用户卡死且无出路。**否决。** |
| B. 脱钩（本实现） | 删行前把申请上的行引用置空，申请与轨迹留下，`order_id` 不变仍能定位订单。 |

选 B。判定依据是「A 方案在终态下无解」这一条，与实现成本无关。

脱钩后 `receivable_id` / `payable_id` 皆为空，因此 CHECK 从
「必须有一个且与 kind 对应」放宽为「至多一个，非空时必须与 kind 对应」。
明细名称由 API 侧兜底（`finance-application-service.ts` 的 `toItem` 已有
`lineName ?? '（明细已删除）'`），所以没有在申请上加快照字段 —— 不加表结构。

## 实现

`supabase/migrations/20261115000001_finance_application_line_history.sql`

1. 放宽 `finance_applications_line_exclusive`。
2. `detach_finance_applications_from_line()` + 两个 `BEFORE DELETE` 触发器
   （`order_receivables` / `order_payables`）。
   - `SECURITY DEFINER` + `search_path = ''`：删行的操作员不一定有 UPDATE 申请的权限，
     而脱钩是删除动作的副作用，不能因权限边界退化成级联删除。
   - `REVOKE ALL ... FROM PUBLIC`：触发器函数不该被任何人直接调用
     （上一单元刚修过触发器函数残留 PUBLIC EXECUTE 的问题）。
3. 两个 partial index：外键检查与脱钩更新都按单列定位。

## 验证

`node scripts/db/local-db.mjs verify` → **30 个测试文件全过**，其中新增
`supabase/tests/finance_application_history.sql`（19 条断言）：

- 应收侧：驳回 → 额度释放 → 走真实入口 `update_order_with_items` 删行 → 行没了、
  申请还在、`receivable_id` 为空、`order_id` 不变。
- 应付侧：同样一遍。
- 汇总断言：两条驳回轨迹都还在（用管理员身份读，操作员看不到轨迹）。

删除走 `update_order_with_items` 而不是直接 `DELETE`：守卫与脱钩触发器都在这个
函数调用的路径上，绕过它测出来的绿是假的。

顺带确认：`schema:check` 已重新生成（38 迁移 / 240 函数 / 90 索引 / 8 触发器）。

## 边界与未做

- 未跑 `pnpm test`（单测）与 `lint`：本机 node_modules 是半成品，见
  `.workbuddy/reports/2026-11-14-本地环境搭建记录.md`。本次改动不涉及 TS 文件，
  `tsc --noEmit`（排除测试）已过。
- 未做「明细名称快照」：脱钩后只能知道是哪一单，不知道原来叫「团款」。
  若要连名称一起留，需要给申请加两列，属于另一次改动。
- 前端无改动：API 已返回「（明细已删除）」，界面不需要新增提示逻辑。
