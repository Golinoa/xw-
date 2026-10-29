# 2026-10-29 财务项目与订单财务汇总

## 今日完成

- 应收/应付查询与订单财务摘要打通，分三次提交（分支 `feat/business-slice`）：
  - `46a9c39` feat(udone): finance contracts and receivable scope fix
  - `e8a86ea` feat(udone): finance query endpoints
  - `a440575` feat(udone): finance UI and order list outstanding amounts
- 契约：新增 `finance.ts`——`orderFinanceSummarySchema`、应收/应付列表项、`summarizeAmountLines` 与
  `summarizeOrderFinance` 两个纯函数；`orders.ts` 的列表项补 `uncollectedAmount` / `unpaidAmount`。
  `ROUTES` 累计 18 个端点（新增 3 个）。
- 数据库：`20261029000003_finance_scope.sql` 收紧 `order_receivables` / `order_payables` 的数据范围
  （详见下文「遇到的问题」）。没有新增表，也没有新增聚合函数。
- API：`modules/finance/` 一个仓储 + 三个端点；`lib/postgrest.ts` 抽出关键词清洗与 `in.(...)` 编码，
  客户、订单、财务三处共用一份。
- 前端：`/finance` 页（应收 / 应付两个页签，URL 同步筛选与分页）；订单详情新增「收款与付款」区块；
  订单列表新增「未收 / 未付」两列。
- 测试：167 → 186。其中 17 个是本次新增（5 个契约纯函数用例 + 12 个端点用例），
  契约用例直接断言唯一真源第 21 节的验收数据（应收 7,500 / 应付 4,800 / 收 3,000 / 付 4,800
  → 利润 2,700、毛利率 36%、客单价 2,500、净现金流 −1,800、收款进度 40%、付款进度 100%）。

## 关键决策

- **摘要由纯函数算，不由接口算**：`summarizeOrderFinance` 放在契约包里，接口和单元测试调同一份。
  口径（利润、毛利率、客单价、进度、净现金流）就有了唯一实现，页面不可能自己再除一遍。
- **摘要只吃明细行，不吃订单表上的合计列**：`orders.receivable_total` 是缓存，
  一旦某次重算漏了，摘要会跟着显示旧数字。生产路径上函数 `recalculate_order_totals()`
  负责让两者一致，但摘要不该依赖这个假设成立。
- **比率用比值、不用百分数**：`0.36` 而不是 `36`。分母为 0 时返回 `null` 而不是 `0`——
  `0` 会被读成「毛利率为零」，实际含义是「还没有应收，算不出来」。展示层 `formatRatio`
  乘 100 并保留一位小数，`null` 显示为 `—`。
- **未收 / 未付含在途，可申请余额不含**：两个数各有用途。财务看未收（含待审申请），
  业务看可申请余额（扣掉在途，防止同一笔钱被申请两次）。两个都返回，不让前端自己减。
- **不新增 `finance.read` 权限**：财务明细是订单的子资源，能看订单就该看到自己订单的金额，
  否则列表上摆着「未收 7,500」却点不进去。真正需要独立权限的是「申请收付款」这类写动作
  （R-FIN-02/03），等做审批流时再引入 `finance.write`。
- **订单列表改为加载明细行**：`未收 / 未付` 只能从明细算出来。当前页订单批量取一次明细，
  不退化成 N+1；顺手删掉了 `decorate()` 里已经恒为 true 的 `withLines` 参数。
- **暂不做跨订单汇总**：应收合计、应付合计、利润、毛利率都是**订单维度**的口径，已覆盖。
  全组织口径的合计需要 SQL 聚合函数（PostgREST 不做 SUM），留给报表任务，
  不在这一步用「取全量到内存再累加」硬凑。

## 遇到的问题

- **明细表的数据范围漏洞（本次修掉）**：`order_receivables` / `order_payables` 的 SELECT 策略
  只校验「同组织 + order.read」，没有校验 own/all；而 `orders` 是校验的。结果 `scope=own`
  的操作员看不到别人的订单，却能直接读到那些订单的应收应付金额。新增的明细列表端点会把这个
  潜在漏洞变成可达路径，所以先修再上。
  - 明细表没有 `created_by`，无法照抄订单的范围判断，改成顺着父订单判定：
    策略里的 `EXISTS (SELECT 1 FROM orders ...)` 会再套一层 `orders` 自己的 RLS。
  - **只收紧 SELECT 策略是不够的**：原来的写策略是 `FOR ALL`，而 PostgreSQL 的宽松策略之间是
    OR 关系，`FOR ALL` 同样覆盖 SELECT，范围检查会被绕过去。所以把它拆成
    insert / update / delete 三条独立策略。
- **子智能体交付的前端有 1 处真实缺陷**：搜索框的清除图标只触发 `change` 不触发 `search`，
  清空关键词后列表仍停在旧结果。已补一个只接管「被清空」的分支。
- **一次假警报，值得记下来**：审计时怀疑 `auth.currentOrganization.value?.role` 用错（Pinia 会
  解包 ref）。核实后确认本仓的 `useAuthStore` 是自定义单例、返回的是裸 ref，`.value` 是对的，
  且与 `HomeView`、`CustomerListView`、`OrderListView` 写法一致。**没有改**。
  这类「看起来像 bug」的地方必须先读实现，凭框架惯例去改会把对的改错。
- **数据库门禁仍未验证（第三次记录，风险未消除）**：本机无 Supabase CLI、无 Docker
  （WSL 被安全策略拦截），`pnpm db:test`（pgTAP）与空库迁移重放**没有执行**。
  本次新增的 8 条 RLS 策略尤其需要真实数据库验证：策略写错的表现是明细读不出来，
  而不是数据泄露（收紧方向），但仍是未验证状态。

## 验证记录（2026-10-29，本机，干净工作区）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（web + api） |
| `pnpm test` | 33 文件 / 186 测试通过 |
| `pnpm lint` | 通过（含 CSS token 检查） |
| `pnpm format:check` | 通过 |
| `pnpm format:sql:check` | 通过（13 个 SQL 文件） |
| `pnpm schema:check` | 通过（8 个 migration） |
| `pnpm build` | 通过（7.69s）；财务页 chunk 10.12 kB / gzip 4.17 kB，订单页 36.96 kB |
| `pnpm db:test` | **未执行**（无 Supabase CLI / Docker） |

## 下一步计划

- 收付款申请（R-FIN-02/03）：`pending_amount` 已有字段与容量约束，缺的是申请单、审批流与
  「在途 → 已确认」的记账事务。这一步需要引入 `finance.write` 权限。
- 全组织财务汇总与报表：需要 SQL 聚合函数或物化视图，与报表任务一起做。
- 客户回收站与恢复；客户来源维护端点与下拉；标签管理 UI（均为此前遗留）。
- `.vue` 仍无类型级检查（项目未装 `vue-tsc`），SFC 只经 ESLint 与 `vite build`。
- `supplierListQuerySchema.activeOnly` 仍是字符串枚举，与布尔语义不一致，待统一。
