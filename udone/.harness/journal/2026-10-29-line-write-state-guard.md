# 明细行写入补上父订单状态守卫

## 今日完成

- 新增 `20261029000007_line_write_state_guard.sql`：应收/应付明细的 insert / update / delete 六条策略补上 `parent_order.status IN ('booking', 'active')`。
- 新增 `supabase/tests/line_write_guard.sql`：12 条断言，用真角色覆盖 completed 与 cancelled 两个终态。
- 做了变异验证：把状态条件去掉后，第 5/6/7/12 条断言同时变红（completed 的增改删 + cancelled 的增），证明测试不是摆设。

## 关键决策

- **用 `status IN ('booking','active')` 而不是「未锁定」判断**。状态机里 `lock` 就是 `active → completed`，没有独立的锁定列，所以「可写」等价于「处于业务进行中」。写成 status 判断与状态机口径一致，不需要新增列。
- **软删除与数据范围不在新策略里重复写**。`EXISTS` 子查询会应用 `orders` 自己的 SELECT 策略，父订单被软删除或不在数据范围时条件已不成立。多写一遍只会增加两处规则不同步的风险。
- **断言必须区分「INSERT 抛错」和「UPDATE/DELETE 影响 0 行」**。PostgreSQL 里 WITH CHECK 违反会抛 42501，而 USING 不成立只是静默不匹配，所以改/删用计数断言、增用 `throws_like`。混用会写出永远通过的假断言。
- **加了第 1 条基线断言**：booking 状态下直连 INSERT 必须成功。没有它，后面每条「被拒绝」都可能只是 GRANT 缺失造成的假阳性——那种测试全绿但什么都没守住。

## 遇到的问题

- UUID 夹具用了 `h1000000-...`，`h` 不是十六进制字符，直接语法错误。改用 `b` 前缀。
- `create_order_with_items` 返回单值 `uuid`，不是带 `result_order_id` 列的 record；照 `order_line_update.sql` 的做法先建单再从 `orders` 按 route_name 反查 id。
- 首轮变异测试在第 5 条后中断：rename 断言用 `IS((SELECT name ... WHERE name <> ...))`，一旦 UPDATE 真的生效会命中两行而报「more than one row」。改成 `count(*) = 0` 的计数断言，变异验证才跑得出全部四条。

## 下一步计划

- 收付款申请与审批流（R-FIN-02/03）：现在完成态的金额行改不了，接下来需要「已收款项如何转移/作废」的正规入口，而不是靠解锁订单绕回去。
- `completed` 订单是否应允许「补录已发生的收付款」是个业务问题，暂按不可写处理，等需求确认再改；如果确认要允许，应该是独立端点 + 审计，不放开明细表的写权限。
- admin 端仍是上流模板，业务模块为零。
