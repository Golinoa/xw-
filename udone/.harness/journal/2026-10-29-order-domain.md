# 2026-10-29 订单域（含供应商最小可用）

## 今日完成

- 订单域从契约到前端打通，分三次提交（分支 `feat/business-slice`）：
  - `9985f2b` feat(udone): order and supplier domain with server-side money recalculation
  - `96be5d7` fix(udone): order detail state and payable supplier validation
  - `a1238a9` feat(udone): order and supplier management UI
- 契约：新增 `orders.ts`（列表/详情/创建/更新/状态流转 DTO、`moneySchema` 金额守卫）、
  `suppliers.ts`（列表 + 创建的最小契约）；`permissions.ts` 新增 `order.read` /
  `order.write` / `supplier.read` / `supplier.write`；`errors.ts` 新增
  `ORDER_STATE_CONFLICT`。`ROUTES` 累计注册 15 个端点，其中订单 5 个、供应商 2 个。
- 数据库：`20261029000002_order_domain.sql` 新建 suppliers、orders、order_receivables、
  order_payables 四表，沿用 `(业务列, organization_id)` 复合外键；订单号用
  `order_number_seq` + `SO-YYYYMMDD-NNNNNN`（`Asia/Shanghai` 时区），租户内唯一。
  `person_count` / `profit` / `available_amount` 为生成列，金额一律 `numeric(14,2)`。
  四个事务函数：`create_order_with_items`、`update_order_with_items`、
  `transition_order_status`、`recalculate_order_totals`。
- API：`modules/orders/` 与 `modules/suppliers/` 分仓储 / 路由两层；列表用 `restPage()`
  取 total；金额合计永远由服务端重算，请求里的合计字段被忽略；状态流转只接受
  具名动作（`confirm`/`revert`/`lock`/`unlock`/`cancel`/`restore`），不接受直接写状态值。
- 前端：`/orders` 列表（URL 同步筛选）+ 表单弹窗 + 详情抽屉；`/suppliers` 列表 + 表单；
  抽 `lib/format.ts` 统一 `¥12,000.50` 金额与时间格式。
- 测试：157 → 167（订单 10 个用例：分页、own 数据范围、服务端合计、三位小数拒绝、
  起止日期倒置、跨租户外键 400、非法流转 409、缺原因 400、版本冲突 409、财务只读 403）。

## 关键决策

- **金额与合计不接受客户端输入**：创建/更新时请求只描述「明细行」，订单级合计由
  `recalculate_order_totals()` 在库内重算。这样即使前端算错、或被绕过直连 API，
  账也不会被写脏。`moneySchema` 额外拒绝超过两位小数的值，避免 `0.1+0.2` 型浮点尾差。
- **状态机用 CASE 表而不是一堆 IF**：`transition_order_status()` 内部把
  「当前状态 × 动作 → 目标状态」写成 CASE，非法组合返回 `error_code` 而不是 RAISE，
  让 API 能稳定映射成 409 `ORDER_STATE_CONFLICT` + 可读原因，而不是 500。
- **只有创建走事务函数，更新不走**：创建涉及订单行 + 应收 + 应付三张表，中途失败会
  留下有订单没明细的半成品；更新是先 PATCH 再重写明细分表，失败重试即可收敛，
  不值得再引入一个函数（与客户域的判断一致）。
- **`lock`/`unlock`/`cancel` 强制要求原因**：契约层用 `.refine` 拦截，库层
  `status_reason` 用 `coalesce(新原因, 旧原因)` 保留，无原因动作不会把已有说明抹掉。
- **供应商先做最小可用**：目前只有列表与创建，够订单应付行引用即可。结算口径
  （`monthly` / `per_trip`）已进契约但不参与计算，留到财务域一起做。

## 遇到的问题

前端实现完成后做了逐项审计，发现并修掉 9 处真实缺陷，其中 3 处在后端、3 处在既有基础设施：

- **`status_reason` 被无原因动作清空**：`confirm`/`revert` 不传原因时会把上一次的
  锁团说明覆盖成 NULL，审计痕迹丢失。改为 `coalesce`。
- **停用的供应商仍可被新订单引用**：外键只保证租户一致，不保证 `is_active`。已停用的
  供应商被写进应付行，结算口径会悄悄变脏。创建与更新两个函数都补了 `is_active`
  存在性检查，失败抛 `23503 supplier_not_available`。
- **订单详情缺 `previousStatus`**：取消时记了原状态，但没往 API 吐，界面上无法说明
  「恢复」会回到哪个状态。已加进 `orderDetailSchema` 并条件展开。
- **按客户名搜订单搜不到**：列表展示客户名，但客户名不在 `orders` 表上，
  `or=(order_number.ilike, route_name.ilike)` 覆盖不到。补了一次
  `customers?name=ilike.*` 查询，把命中的 id 拼进 `customer_id=in.(...)`。
- **`pageSize=15` 被自己的契约拒绝**（客户域遗留，此处回归验证）：`DEFAULT_PAGE_SIZE`
  不在 `PAGE_SIZE_OPTIONS` 里，客户端回传默认值即失败。已把 15 加入白名单并加回归测试。
- **可选字段无法清空**（同上）：契约只有「缺失 = 不改」，改错的值永远改不回来。
  已改为 `.nullable().optional()`，`null` 表达清空。
- 另外三处为 api-client 的 GET 查询串、path-only 路由校验、`ContractViolationError`
  误报，已在客户域的 `517e297` 修完，此处仅回归确认。

## 数据库门禁仍未验证（与客户域同一风险，未消除）

本机无 Supabase CLI、无 Docker（且 WSL 被安全策略拦截），`pnpm db:test`（pgTAP）与
空库迁移重放**没有执行**。本次新增的 RLS 策略、复合外键、生成列表达式，以及四个
事务函数的 SQL 语法与运行时行为均未在真实 PostgreSQL 上验证过；只通过了
`format:sql:check` 与 `schema:check`。**这不是已验收状态**，需要在具备 Docker 或
Supabase CLI 的环境补跑后才能算通过。

## 验证记录（2026-10-29，本机，干净工作区）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（web + api） |
| `pnpm test` | 31 文件 / 167 测试通过 |
| `pnpm lint` | 通过（含 CSS token 检查） |
| `pnpm format:check` | 通过 |
| `pnpm format:sql:check` | 通过（12 个 SQL 文件） |
| `pnpm schema:check` | 通过（7 个 migration） |
| `pnpm build` | 通过（7.84s）；主包 1.6 MB 告警为既有问题，订单页 chunk 34.99 kB / gzip 11.09 kB，客户页 19.39 kB，供应商页 5.62 kB |
| `pnpm db:test` | **未执行**（无 Supabase CLI / Docker） |

## 下一步计划

- 应收应付查询端点与订单财务汇总：应收合计、应付合计、未收未付、利润、毛利率，
  以及订单维度财务摘要（财务域 R-FIN 系列）。订单表现有 `profit` /
  `available_amount` 生成列可直接复用，缺的是聚合与筛选口径。
- 客户回收站与恢复（目前只有软删除，没有恢复入口）。
- 客户来源（customer_sources）维护端点与 UI 下拉，表已建、无 API。
- 标签管理 UI（创建标签端点已有，界面只能选不能管）。
- `.vue` 无类型级检查：项目未装 `vue-tsc`，SFC 只经 ESLint 解析与 `vite build`。
- `supplierListQuerySchema.activeOnly` 目前是字符串枚举，与布尔语义不一致，待统一。
- 订单「预订(booking) → 取消」在界面上没有入口，先确认业务是否允许。
