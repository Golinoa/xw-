# 收付款申请与额度占用

## 今日完成

- `20261029000008_finance_applications.sql`：`finance_applications` + `finance_application_actions` 两张表、四个函数（创建 / 审批 / 撤回终审 / 创建人撤销）、三个额度调整辅助函数、两条读策略。
- `supabase/tests/finance_application_flow.sql`：19 条断言，覆盖额度占用、超额拒绝、两级审批、驳回、撤销、终审撤回、自审禁止。
- 权限新增 `finance.write`（operator + finance + admin）与 `finance.approve`（finance + admin），TS 契约与两处快照同步更新。
- 变异验证：把 `confirm_finance_application_hold` 改成只释放 pending 而不加 confirmed，第 11 条断言按预期变红，随后恢复。

## 关键决策

- **收支共用一张表**。收款与付款的字段、状态机、审批路径完全对称，拆两张表只会把同一套逻辑写两遍。用 `kind` + 两个可空外键 + CHECK 互斥，复合外键 `(line_id, order_id)` 保证申请引用的明细行必须属于同一张订单——跨订单引用在数据库层就不成立。为此给两张明细表补了 `UNIQUE (id, order_id)`。
- **函数 SECURITY DEFINER，表不给客户端任何写权限**。客户端若能直接 PATCH `finance_applications.status`，待审就能被改成已确认，额度校验形同虚设。所以写路径只有函数，表的 INSERT/UPDATE/DELETE 一律不授予 authenticated。
- **三个额度调整函数撤销 authenticated 执行权**。它们本身不做校验（调用方必须已经锁住申请行），放给客户端等于开放 `confirmed_amount` 的任意写。这是本轮最容易漏的一处——PostgreSQL 默认给 PUBLIC 授予 EXECUTE，不显式 REVOKE 就是敞开的。
- **`FOR UPDATE` 锁明细行再校验额度**。两条并发申请同一行时，后者会等前者提交后重新读到已占用的 `pending_amount`，才会被挡下。表的 `CHECK (confirmed + pending <= amount)` 是最后一道兜底，函数里的校验只是为了给出可读错误码。
- **已取消订单不再产生资金流动，已锁团允许**。尾款在出团后结是常态，`completed` 约束的是改价而不是收款。这个判断写进了函数注释，容易在后续被误当成漏判。
- **两级审批写死**。R-APPROVAL-01 的流程配置表没做，级次固定为财务 → 管理员，配置项「允许撤回」固定 yes、「允许同人审批」固定 no。与其做一张半成品配置表，不如先固定行为并在测试里锁住。

## 遇到的问题

- 迁移里写成 `REVOKE ... FROM PUBLIC, public.authenticated`。`authenticated` 是角色，不在 `public` 模式里，这个写法直接语法错误。改成 `FROM PUBLIC, authenticated`。
- 主函数先引用三个辅助函数、后定义，plpgsql 创建时不报错（延迟解析），只有真正执行才炸。这类错误静态检查看不见，靠测试才暴露出来。
- 测试服用了 `h1000000-...` 作为 UUID 前缀，`h` 不是十六进制字符。前四个域用的 c/d/e/f 都是十六进制，所以之前没踩到。
- **测试数量出现过不稳定**：先后跑出 34 文件 197 用例、33 文件 195 用例、33 文件 193 用例。随后连跑三次都是 34/197，`vitest list` 也稳定返回 34 个文件。怀疑是与 `format:check`、`db:local:verify` 并行执行时 CPU 争用导致个别文件被跳过，但**没有证据**，只记录现象。之后门禁改为顺序执行。
- 两次提交都触发 `CRLF will be replaced by LF` 警告。git 按 LF 存储，工作区是 CRLF，规范化后 `git diff --ignore-cr-at-eol` 为空，属缓存显示问题，无实质差异。

## 下一步计划

- 收付款申请目前只有数据层：没有契约 DTO、没有 API 端点、没有界面。下一步按契约 → API → 前端补齐，前端优先做「待审列表 + 审批操作」。
- 付款路径与收款共用函数，但只有收款有断言。补一组对称的付款测试，尤其是供应商维度。
- 流程配置（R-APPROVAL-01）、站内通知（R-NOTIFY-01）、账户余额（R-BALANCE-01）都还没开始；余额依赖已确认流水，现在已经有数据可以支撑了。
