# B2 客户回收站（第三步：回收站列表端点 + 页面）

日期：2026-11-15 · 卡片：P9-B2（P1）· 出口：pgTAP 33 文件 + 单测 799 用例 + 回收站页可用

## 做了什么

数据库和恢复端点在前两步已完成，这一步只补「看不见的东西」——**能列出回收站里的客户**，
以及一个能点的页面。

| 层 | 内容 |
| --- | --- |
| 契约 | `customerRecycleBinItemSchema` / `customerRecycleBinQuerySchema` / `customerRecycleBinResponseSchema`；`ROUTES.listDeletedCustomers` = `GET /api/customers/recycle-bin` |
| 服务 | `CustomerRepository.listDeleted(filter)`：`deleted_at=not.is.null`、`order=deleted_at.desc`、关键字只搜姓名/电话 |
| 路由 | `GET /api/customers/recycle-bin`，权限 `customer.restore` |
| 前端 | `CustomerRecycleBinView.vue` + 路由 `customers/recycle-bin` + 客户列表页右上角「回收站」入口（仅 `customer.restore` 可见） |
| 测试 | routes.test.ts 新增 3 条：掩码 + 参数透传、回收站与正常列表两次查询互不混用、无 restore 权限 403 |

## 决策

1. **独立路径，不给 `listCustomers` 加 `includeDeleted`**。
   两个查询的可见性由**两条不同的 RLS 策略**授权（`customers_select_scoped` 要
   `deleted_at IS NULL`，`customers_select_restorable` 只认 `customer.restore`）。
   合并成一个端点等于在仓储层做权限分流，且一旦漏判就会让删掉的客户混进正常列表 —
   所以分成 `list` / `listDeleted` 两个方法，测试里专门断言「调回收站时没调 list」。

2. **列表权限用 `customer.restore`，不是 `customer.read`**。
   延续 `20261029000004` 的注释口径：能读已删除 = 能恢复。给 `customer.read` 开一个读通道，
   等于造出一条没有界面管控的「看见别人删了什么」的能力。

3. **回收站不给排序参数**。唯一合理的顺序是「最近删的在前」，排序写在仓储里；
   契约里多一个只能选一项的白名单，只是多一处要校验的地方。

4. **回收站只返回掩码字段，不返回 `idNumber` / `remark`**。
   已经删掉的数据没必要再暴露一遍原值；页面上需要认人只要姓名 + 掩码手机号。

5. **页面不做 URL 状态同步**（客户列表页是做的）。回收站是「进去处理几条就走」的临时页，
   没有分享链接与返回栈的诉求，少一层 `router.replace` 就少一处状态打架。
   代价：刷新回到第 1 页、关键字清空。这是刻意取舍，不是漏做。

6. **入口放在客户列表页，不进顶部导航**。回收站只有 admin 能看，
   给所有人加一个点了就 403 的导航项没有意义。

## 验证

| 门禁 | 结果 |
| --- | --- |
| pgTAP `db:local:verify` | **33 文件全绿**（41 个迁移重放） |
| 单元测试 | **60 文件 / 799 用例**（新增 3 条，原 796） |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成 | **21 文件 / 380 用例** |

HTTP 集成第一次跑挂在本机 PostgREST 启动（`等待 PostgREST 就绪超时`），
日志显示 23:48:56 已连上库但还没打出 `API server listening`；重跑一次全过，
确认是 Windows 上 PostgREST 冷启动偶发慢，不是代码问题（第二次 22 秒跑完）。

## 没做

- **订单回收站页 / 订单恢复端点**。业务端根本没有删除订单的入口（`routes.ts` 里没有
  `deleteOrder`），页面会是一个永远空的列表。等订单删除接入时一起做，理由与第二步一致。
- **订单状态机的 `restore` 动作不改用 `order.restore`（与卡片「做法」原文不一致，已改判）**。
  卡里写的是「订单 `restore` 改用 `order.restore`」。查了实现：`transition_order_status` 的
  `restore` 是「`cancelled` → `previous_status`」，处理的是**业务状态**，与 `deleted_at` 无关；
  它和 `confirm` / `revert` / `lock` 一样是一条状态迁移，权限走 `orders` 表的 `order.write` 更新策略。
  改成 `order.restore`（当前只有 admin 有）的实际后果是：**计调员再也不能自助恢复被取消的订单**。
  这是权限口径的业务变更，不该在一张「回收站页」的卡里顺手做，所以只记录、不改。
  `20261029000004` 的注释约束的是「读已删除行」，与这里不冲突。
- **显示「谁删的」**。`customers.deleted_by` 有值，但要在界面显示姓名得再查一次成员列表；
  本轮只显示删除时间。要加时在 `listDeleted` 里补一次成员查询即可，不动契约的其他字段。
- **回收站里的批量恢复**。单条恢复已够用，批量属于新交互，没顺手加。
