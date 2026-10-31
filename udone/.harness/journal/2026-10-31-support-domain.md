# 2026-10-31 · 支撑域（T-12 售后工单与时间线）

## 今日完成

`o-t12` 售后工单与时间线，两个提交：

- `b71b166` 三表 + 十四函数 + 77 条 pgTAP；连带动 `db-schema.md`。
- `8ac8272` 契约、十个端点、34 条单测、21 条集成（集成文件总数 223）。

`ops.settings` 是上一轮（o-t07）顺手先落的，这一轮直接用：`due_at` 通过
`ops.setting_int('ticket.dueHours', 48)` 取时限，不需要造替身表。

## 关键决策

1. **`isOverdue` 派生不落库，`due_at` 落库。** 两个看似同类的字段走了相反的路，
   因为语义不同：`due_at` 是「约定的截止时刻」，一旦定下就该是快照——把
   `ticket.dueHours` 从 48 改成 12，不该让上周创建的单子集体变成逾期；
   `isOverdue` 是「现在过没过」，它随时间自己变化，落库就必须有定时任务刷。
2. **`ticket_is_overdue` 显式传 `p_now`。** 逾期边界（差一秒、差一天）在 pgTAP 里
   必须能直接对着值断言，而「函数内部调 `now()`」只能靠「跑测试时恰好几点」。
   多一个参数换来 D3 那条「等于现在不算逾期」的断言——没有它，`<` 写成 `<=`
   永远不会被发现。
3. **状态机作为数据：`ops.allowed_ticket_actions(status)`。** 详情要回
   `allowedActions`、非法迁移也要回、前端按钮还要靠它对账。三份副本里只要有一份
   漏一条边，症状是「按钮点得动但一直 409」。
4. **`resolved` 不算逾期。** 契约原文是「`dueAt < now` 且未关闭」，字面只排除
   `closed`；但 `resolved` 意味着活儿已经干完，继续标逾期会让「逾期工单」这个
   数字永远降不下来——而它是总览里唯一会被人追问的指标。口径登记在 C-108。
5. **离开 `waiting` 清空 `waiting_on`。** 表约束只要求「waiting 时必须有
   waitingOn」，不清空也满足，但 `resume` 之后那一列会留着上一个等待对象，而
   列表页与导出都会把它当成「正在等谁」。这条由 T8 断言钉住，变异过一次（改成
   `coalesce(effective_waiting_on, waiting_on)` 后 T8 立刻红）。
6. **改派不是迁移。** `new → assigned` 是状态机的边；已 `in_progress` 的单子换人
   只改 `assignee_operator_id`，状态不变，前一个负责人记在事件的
   `metadata.previousAssigneeId` 里。把改派也记成一次 `assigned` 迁移，时间线上
   会出现两条 `assigned`，看不出这是第几次换人。
7. **`issueType` 不收枚举。** 契约 §3.6 写的是 `text NOT NULL`，没有词表。自己编
   一套会让前端下拉先被实现绑死；只约束长度，词表等运营端给（C-108）。
8. **租户映射与部署实例只有 uuid 列，没有外键。** 两张表属 o-t10 / o-t11，本轮不
   存在。建不带外键的列 + 写入时 `to_regclass` 守卫，表落地后由后续迁移补约束
   （补约束比补列安全，不需要回填）。
9. **三个筛选参数是契约没有的。** `createdFrom` / `createdTo` / `unassigned`
   契约 §5.6 里只有 `updatedFrom`，但列表页的「看某天进来的单子」与「待分派队列」
   都需要它们，而 `assigneeOperatorId` 表达不了「没有负责人」。日期一律
   `YYYY-MM-DD` 按 `Asia/Shanghai` 整天切——让调用方传时刻等于把时区判断推回
   前端，而那正是 §5.6 脚注明令禁止的事。已登记 C-108。

## 遇到的问题

- **「先插入、再 UPDATE 补 `waiting_on`」不成立。** 测试夹具直插一张
  `status='waiting'` 的工单，随后 UPDATE 补 `waiting_on`——插入当场就撞
  `tickets_check`，整个文件在 setup 阶段中断。CHECK 是行级、插入时即生效，
  「先造脏行再修」这条路在约束面前不存在。改成插入时带上值。
- **又一次以 `authenticated` 直读业务表。** C3 断言写的是
  `select count(*) from ops.ticket_events`，报 `permission denied`——那不是被测
  代码的问题，是测试在用端点拿不到的权限（o-t07 已经踩过同一课，这次没在第一版
  就照做）。改法：所有读侧断言走 `ops.list_ticket_timeline` / `ops.get_ticket`；
  所有写路径的版本号从**上一次 RPC 返回的信封**里取，存进会话变量 `support.env`。
  这也让测试更接近真实调用方：端点就是这么拿 `version` 的。
- **`pageSize` 有白名单。** timeline 单测用 `pageSize=5` 得到 400，因为
  `PAGE_SIZE_OPTIONS` 只认 15/10/20/30/50/100。这不是缺陷，是刻意的（默认 15
  也在白名单里，否则客户端回传自己的默认值会被拒）。测试改成 10。
- **合同条目不能只给 `quantity` + `unitPrice`。** 集成里造「别家客户的合同」时
  漏了 `productId`，400 报在 `items.0.packageId` 上——合同域要求条目必须能追到
  产品或套餐。补一个产品后通过。
- **逾期与总数的期望值第一次算错了三处。** `t_waiting`（等待中且过期）也算逾期，
  所以 L4 是 2 不是 1；总数把第二张单漏了，4 → 5。这三处是**测试算错**，不是实现
  错——但它说明「逾期」这两个字在写断言时的直觉与实现口径不一致，正好反过来印证
  决策 4 需要写进文档。

## 未验证项

1. **引用的存在性校验证不了。** `tenant_commands` / `entitlement_change_requests` /
   `deployment_version_records` 三张表都不存在，`to_regclass` 守卫一律跳过。
   R1 只证明了「表不在时关联被接受」，不宣称「引用不存在会报错」。
2. **按优先级系数算时限未做。** U-11 只写了「按优先级系数计算」，系数没给。
   本轮四档同基线（48 小时），系数待运营端定（C-107）。
3. **`overdueOnly` 在集成层从未命中。** `due_at` 由服务端按设置算，没有写
   `due_at` 的端点，集成层造不出逾期单。逾期判定由 pgTAP 对着边界值证明。
4. **详情时间线的 50 条上限没证。** 只证明了「首条是最新的」与「总数正确」，
   没造一张 51 条事件的工单去验截断。
5. **`assignableOperators` 不按权限过滤。** 契约只写「仅 active 成员」，所以任何
   有效运营成员都会出现在分派下拉里。若运营端期望「只列能接单的角色」，这是第二
   处需要同步的地方（C-108）。
6. **业务域审计写入仍然整体缺失。** 工单域也没写审计，与 o-t07 的结论一致：
   `ops.write_audit` 存在但客户 / catalog / 合同 / billing / 支撑五域一处都没调用，
   已上卡 `o-audit-write`。

## 下一步计划

- `o-t08` 收款 · 审核 · 核销 · 退款是下一个大件，也是整条线风险最高的一域：它要
  同时锁 `receipts` 与多行 `receivables`，同事务校验超额（`RECEIPT_EXCEEDED` /
  `RECEIVABLE_EXCEEDED`），还要做登记人≠审核人。**单独一轮、不并行。**
  本域与 billing 已给它备好落点：`receivables` 的
  `UNIQUE (id, customer_id, currency)` 就是核销复合外键的引用目标。
- `o-t09` 订阅权益与 `o-t10` 租户映射可以并行；两者只共享 `routes.ts` 末尾追加
  这一处写点（串行）。`o-t10` 落地时记得回来补 `tickets.tenant_mapping_id` 的外键
  与引用存在性校验，`o-t11` 同理补 `deployment_instance_id`。

## 断点（2026-10-31 13:00）

- 分支 `feat/business-slice`，两个提交 `b71b166`（DB）+ `8ac8272`（端点），
  工作树干净。
- 13 道门禁一次跑完退出码 0（另附 `secrets:check`）：26 迁移 / 20 文件 / 782 断言；
  集成 12 文件 223 条；单测 50 文件 562 例；build 主 chunk 1,638.75 kB（**无增长**，
  本轮只动后端）；deps:audit critical 0 / high 0 / moderate 1（`minimatch`）/ low 0；
  licenses 349 组。
- 变异两枪：逾期判定不排除 `resolved`（O3 红）、离开 waiting 不清空 `waiting_on`
  （T8 红）；复原均绿。
- 看板回写：`o-t12` → done；新增协作项 `C-108`（工单域四处口径 + 一条响应范围
  回写）；`SEED_VERSION` 37 → 38。已跑 `pnpm board:check`：101 张卡
  （71 done / 0 doing / 27 todo / 3 blocked）、协作 27 项（11 未闭环 / 16 已闭环）。
- 待办里的下一件是 `o-t08` 收款链路；`o-t09` / `o-t10` 可并行，两者只共享
  `routes.ts` 末尾这一处写点。
