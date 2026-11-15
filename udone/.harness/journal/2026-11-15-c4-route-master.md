# C4 线路主数据

日期：2026-11-15 · 卡片：C4（P1）· 出口：线路表 + 订单表单下拉 + 快捷新增 + 名称快照不漂移

## 问题

`orders.route_name` 是纯文本，全库没有线路表。后果不是「少个功能」，而是三件具体的事：

1. 同一个线路在不同订单里写法各异（「云南六日游」/「云南6日游」），按线路统计永远对不上；
2. 订单表单里那条线路名是手打的，**没有任何地方能维护一份公司口径的线路清单**；
3. R-FIN-01 要求「历史名称和金额不得随主数据修改而漂移」，而在没有主数据之前，
   这句话连「漂移」的条件都不成立——你没有可改的主数据。

## 决策

1. **不加 `orders.route_id` 外键。** 这是本卡最重要的一个决定。
   需求要的是「历史订单保留名称快照」，而快照按值保存就够了：下单时把线路名拷进
   `orders.route_name`，之后线路改名、停用、删除都碰不到它。
   加外键的代价是：要么改订单事务函数（`create_order_with_items` / `update_order_with_items`
   都要重声明），要么诱导后来者 join 实时主数据来显示线路类型/天数——**那正是需求禁止的漂移**。
   金额同理：`order_receivables` / `order_payables` 的 `name` + `amount` 本来就是拷贝，
   不是对主数据的引用，本卡不需要再动。
2. **下拉的 value 是线路名，不是 id。** 名称在组织内唯一（`routes_name_key`），足以做键。
   用 id 的话，编辑历史订单时必须给「当年手打、后来没建档」的名字造一个假 id 才能撑住下拉显示，
   否则 `a-select` 显示空白、用户一保存就把 `route_name` 清成 null —— 那是悄悄改数据。
   `useRouteOptions().ensure(name)` 现在把这类历史值直接钉成选项。
3. **线路类型 / 地区 / 出发城市是自由文本，不是枚举。**
   需求把这三项交给「公司字典」维护（R-SETTING-01），而 `business_dictionaries` 表还不存在。
   现在写死枚举，等于把「公司可维护」降级成「发版才能改」。只有 `days` 做成强类型：
   它能被校验（1–365），而且不能被字典化。
4. **新权限 `route.read` / `route.write`，不复用 `order.*`。**
   线路是公司口径的主数据，与「能开一张单」是两件事：只允许按既有线路开单、
   不允许新增线路的岗位是存在的。分配与供应商对称：admin/operator 读写，finance 只读。
5. **`created_by` 用 `DEFAULT auth.uid()`，不让服务层传。**
   插入策略要求 `created_by = auth.uid()`，服务层如果自己传就等于把「谁创建的」交给调用方；
   默认值让「伪造创建人」在数据库层直接不成立。
6. **删除不做引用阻断。** 线路没有被任何表外键引用（决策 1 的直接结果），
   所以删一条线路就是删一个字典项；历史订单照样带着当时的名字活下去。
   这与客户来源/标签的 RESTRICT 语义不同，不是漏了检查。
7. **空 PATCH 直接 400。** 只改 `updated_at` 的空写没有任何语义，与标签改名同一口径。

## 改动清单

| 层 | 内容 |
| --- | --- |
| 数据库 | `20261115000006_route_master.sql`：`routes` 表 + `(org,name)` 唯一 + RLS 四条策略 + `GRANT SELECT/INSERT/UPDATE/DELETE` + `route.read`/`route.write` 权限播种 |
| 契约 | `packages/contracts/src/tour-routes.ts`（列表/创建/更新/删除 + 参数 + 回执）；`ROUTES` 新增 4 条；`PERMISSIONS` 新增两项并改三个角色的矩阵 |
| 服务 | `modules/routes/route-service.ts`：list / create / update / remove，23505 → `TourRouteNameConflictError` |
| 路由 | `GET/POST /api/routes`、`PATCH/DELETE /api/routes/:routeId` |
| 前端 | `views/routes/route-options.ts`（服务端关键字检索 + 钉住历史值）、`views/routes/RouteFormModal.vue`（快捷新增）；订单表单「线路名称」输入框 → 可搜索下拉 + 新建入口（按 `route.write` 隐藏） |
| 测试 | `supabase/tests/route_master.sql` 10 条；`modules/routes/routes.test.ts` 10 条；`tests/integration/routes.test.ts` 6 条；`permissions_and_disabled_sessions.sql` 权限快照加两项 |

## 验证

| 门禁 | 结果 |
| --- | --- |
| pgTAP | **35 文件全绿**（43 个迁移），新增 `route_master.sql` 10 条断言 |
| 单元测试 | **61 文件 / 819 用例**（改前 60 / 809） |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成 | **23 文件 / 391 用例**（新增 `tests/integration/routes.test.ts` 6 条） |

**变异验证**：把 `created_by uuid NOT NULL DEFAULT auth.uid()` 的默认值去掉后重跑 pgTAP，
`route_master.sql` 立刻变成「通过 6 / 失败 4」——建线路、开订单、改名、删除四条连锁变红
（线路压根建不出来，后面全部落空）。改回后全绿。这说明那条默认值不是装饰，
它同时承担了「插入策略能过」与「审计字段不可伪造」两件事。

**为什么值得单独写 HTTP 集成用例（原计划没打算写）**：`created_by` 的默认值、
`23505 → 409`、`DELETE ... return=representation` 这三件事全都发生在 PostgREST 一侧，
pgTAP 与单测都只能证明「我以为是那样」。集成用例在真实 PostgREST 上验了：
建线路 201 且 `created_by` 真取到人、重名 409 `CONFLICT`、删第二次 404。

**前端行为不在自动门禁内**（`vue-tsc` 只保证类型）：下拉搜索、快捷新增回填、清空后提交 null，
这三条只有人点过才知道。

## 未做

- **线路管理页**（列表 / 改名 / 启停 / 删除的界面）。端点全齐，界面只做了订单表单里的「新建」。
  与 C2 的来源管理页同一取舍：卡片要的是「线路表 + 下拉」，管理页属于新页面。
  后果要说清：**改名和停用目前只能走 API**，因为订单表单没有管理入口。
- **按线路统计报表**：需要 `route_id` 或按名称归并，属于 C8（R-REPORT-01）的范围，
  且本卡已明确不加 `route_id`，届时要在报表侧决定按名称还是补一个弱引用。
- **线路相关 E2E** 归 A1。

## 顺手发现（不在本卡范围，未改）

`routes` 表建了 `updated_by` 列，但更新时没有任何一层会写它 —— 服务层只写 `updated_at`。
这不是本卡引入的：`customers` / `customer_sources` / `customer_tags` 全都一样，
列在、写了空，审计链上少一环「谁改的」。修它要么给每张表加 BEFORE UPDATE 触发器，
要么在服务层统一带 `updated_by`（需要把 `userId` 传进仓储，签名要改一圈）。
跨模块改动，本轮不动，留作独立任务。
