# 业务端未完成任务开发计划（udone）

> **For agentic workers:** 执行时配合 `superpowers/subagent-driven-development` 或 `superpowers/executing-plans`；步骤用 `- [ ]` 勾选跟踪，完成项必须附验证证据。

**Goal:** 把 `udone` 业务端从「能跑通演示」推进到「可交付试运行」：先关掉当前无法验证的盲区，再补数据完整性与权限口径，最后按需求缺口逐模块补齐。

**本文与真源的关系:** 本文件是**执行层任务清单**，不重定义任何需求。

| 问题 | 去哪看 |
|---|---|
| 产品范围与验收口径 | `Docs/REQUIREMENTS.md`（R-ID 唯一真源） |
| 路线图阶段划分 | `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md` |
| 工程约束与门禁 | `.harness/ENGINEERING_STANDARDS.md`、`.harness/TESTING_STANDARDS.md` |
| 状态汇报格式 | `.harness/REPORTING.md` |

本文件只做一件事：把上述来源里**未完成**的部分，拆成可执行、可验证、可提交的任务，并标注每一项的现状证据与验收标准。

## 基线（2026-10-29 当次实测）

| 门禁 | 结果 |
|---|---|
| `format:check` | 通过 |
| `format:sql:check` | 25 个文件通过 |
| `lint` + CSS token | 通过 |
| `schema:check` | 与 14 个迁移一致 |
| `check:deploy` | 通过 |
| `typecheck` | 通过（`vue-tsc`，含 `.vue`，见 A2） |
| `test` | 39 个文件 / 272 用例通过（并发上限 6，见 A4） |
| `build` | 通过（主 chunk 1,638.00 kB / gzip 506.52 kB，见 D1） |
| `db:local:verify` | 重放 14 个迁移，11 个 pgTAP 文件 **189 断言**全过 |
| `db:local:http` | 真实 PostgREST 16.5 + 原生 PostgreSQL，**23 条** HTTP 集成用例全过 |

规模：14 迁移 / 31 个契约端点 / 6 个 API 模块 / 5 个前端业务模块。

**E2E 现状**：`tests/e2e/` 2 个 spec、6 个用例，全部是登录与成员邀请（`auth.spec.ts`、`member-onboarding.spec.ts`），客户、订单、收付款主线**一条都没覆盖**；`.workflow/ci.yml` 里没有任何 Playwright 步骤。

**本机服务栈现状**：无 Docker、无 Supabase CLI、无 PostgREST 二进制。数据库验证靠原生 PostgreSQL 17 + `scripts/db/supabase-shim.sql` 兼容层完成，不经过 PostgREST，因此 API 到数据库的真实 HTTP 链路从未被自动验证过。

## 任务总览

原计划 **21 项**：A 段 5 项、B 段 2 项、C 段 12 项、D 段 2 项。其中 **A3、C6、C7、C8、C9、C10、C11、C12 已完成**（见下文），剩余 13 项。P2 批量项已全部交付，明细见 §5。

| 编号 | 任务 | 优先级 | 规模 | 依赖 |
|---|---|---|---|---|
| A1 | 前端主线 E2E（Playwright + 网络拦截） | P0 | M | — |
| A2 | `.vue` 纳入类型检查（`vue-tsc`） | P0 | S/M | ✅ 已完成 |
| A3 | 服务端 HTTP 集成（PostgREST 假设） | P0 | L | 需决策 |
| A4 | vitest worker 超时定位 | P1 | S | ✅ 已完成 |
| A5 | 供应商模块行为测试 | P1 | S | — |
| B1 | 审批历史不随明细行删除消失 | P0 | M | — |
| B2 | 客户回收站与 `restore` 权限 | P1 | M | — |
| C1 | R-APPROVAL-01 审批流配置化 | P1 | L | — |
| C2 | R-MASTER-01 客户来源维护 | P1 | S/M | — |
| C3 | R-MASTER-01 标签管理补全 | P1 | S | — |
| C4 | R-ROUTE-01 线路主数据 | P1 | M | — |
| C5 | R-TOURIST-01 游客名单 | P1 | L | C4 |
| ~~C6~~ | 批量结算 | ✅ 2026-11-18 已验证（P2） | L | 见 §5 |
| ~~C7–C11~~ | 余额 / 报表 / 通知 / 审计 / CRM | ✅ 2026-11-19 全部已验证（P2） | L | 见 §5 |
| ~~C12~~ | 公司配置 | ✅ 2026-11-18 已验证（P2） | S | 见 §5 |
| D1 | 前端产物体积（chunk 拆分） | P2 | S | — |
| D2 | E2E 接入 CI | P1 | S | A1 |

---

## 阶段 A：验证闭环

当前最大的风险不是「功能没做」，而是「做了但不知道对不对」。这一阶段把盲区变成证据。

### A1 前端主线 E2E（Playwright + 网络拦截）

- [x] 新增 3 个 spec，覆盖「登录 → 订单列表 → 订单详情金额行 → 发起收款申请 → 审批通过 → 金额从在途转已收」

**现状证据:** `tests/e2e/` 仅 2 个 spec / 6 用例，全部围绕登录与成员邀请；上一轮提交说明里明确写了「这个界面没有在浏览器里跑过」。

**做法:**
- 用 Playwright 内置 `page.route('**/api/**')` 拦截请求，不起真实后端。
- **stub 的响应体必须先用 `@erp/contracts` 的 schema 解析一遍再返回**。stub 与契约不一致时当场失败，否则 E2E 会养活一份平行契约——那比没有 E2E 更危险。
- 同时覆盖四种状态：空列表、加载失败（500 时显示可读文案而非白屏）、无权限（按钮不出现）、驳回未填意见（提交前拦下）。

**验收标准:**
- 新增 ≥3 个 spec，`pnpm e2e` 本地全绿。
- 提交说明写明边界：**只证明前端渲染与交互，不证明服务端行为**。

**完成（2026-11-16 21:40）:** 5 个 spec / **11 用例**（10 通过 + 1 条需 CAPTCHA 测试密钥而跳过）。

**那条卡住的断言，根因不是选择器，是桩的响应不合契约。**
`auth.spec.ts` 里切换公司的响应体只写了 `userId/organizationId/role/sessionId`，
而 `authContextSchema` 还要求 `permissions` 与 `dataScope`。客户端校验失败 → 抛错 →
标题自然不变。表现是「点了 Beta Travel 标题没变」，看着像下拉没点中，实际是响应不合格。
修法：桩体改为 `authContextSchema.parse(...)` / `meResponseSchema.parse(...)` 构造，
漂移会当场炸在构造那一行，而不是伪装成交互问题。

**`npx playwright test` 卡死是 `npx` 去联网找包的缘故，不是用例问题。**
用 `pnpm e2e`（走本地 bin）或 `node node_modules/@playwright/test/cli.js test` 都正常，
11 个用例 25 秒内跑完并退出。之前那句「worker 不退出、要 --workers=2」是误判，已修正。

**边界（写进提交说明）:** 这套用例只证明**前端渲染与交互**；桩不模拟 RLS、事务与并发锁，
服务端行为由 pgTAP 与 HTTP 集成测试负责。

**规模:** M

### A2 `.vue` 纳入类型检查 — 已完成

- [x] 安装 `vue-tsc`，`@erp/web` 的 `typecheck` 改为 `vue-tsc --noEmit`

**完成情况（2026-10-30）:** 首次运行暴露 **10 条**真实错误（4 个视图文件），零 `@ts-nocheck`：

| 错误 | 数量 | 根因 |
|---|---|---|
| `TS7053` 用 `any` 索引 `Record<枚举, string>` | 9 | `a-table` 的 `#bodyCell` 插槽把 `record` 标成 `any`，模板里直接拿它索引标签表 |
| `TS2345` `'order.read'` 不可赋给 `never` | 1 | `authorizationForRole` 返回 `as const` 元组联合，与 `[]` 兜底求交后参数类型塌成 `never` |

两处都按根因修，没有逐行加断言：
- 新增 `apps/web/src/lib/display.ts` 的 `lookup()`，同时解决类型收窄与「服务端新增枚举值时单元格空白」两个问题（回退值让「不认识」可见）；4 条断言覆盖未知值、非字符串、原型链键。
- `authorizationForRole` 显式声明返回 `RoleAuthorization`，字面量类型留在内部矩阵。此前 3 个视图靠手写 `computed<readonly Permission[]>` 躲过此坑，漏写的那个就报错——错因与真实原因毫无关系，属于会反复踩的形态。
- 变异验证：把一处模板改回 `MAP[record.x]` 报 `TS7053`；往 `.vue` 塞 `const bad: number = 'x'` 报 `TS2322`。确认 `vue-tsc` 真的在检查模板与脚本段，不是静默跳过。

之后 `pnpm typecheck` 覆盖 `.vue`；`lint`/`test`(38 文件 260 用例)/`build`/`db:local:verify`/`db:local:http` 全绿。

### A3 服务端 HTTP 集成（PostgREST 假设）— 已完成

- [x] 取方案 a：真实 PostgREST + 原生 PostgreSQL，`pnpm db:local:http` 一键跑通

**完成情况（2026-10-29）:** 下载 PostgREST 16.5 Windows 二进制，连本地原生 PostgreSQL；15 条用例覆盖「建客户 → 建供应商 → 建单（事务函数）→ 财务汇总 → 提交申请 → 财务一审 → 过期版本冲突 → 管理员终审 → 超额拒绝 → 自审拒绝 → 付款路径 → 分页总数 → 越权 403 → 跨租户不可读」。鉴权用真 JWT 交给 PostgREST 校验，RLS 与 `has_permission()` 全都真跑；只替换 Supabase Auth（GoTrue），因为那部分已有独立单测。

**它抓到的第一个真缺陷:** `restPage` 把 PostgREST 的 **416 Range Not Satisfiable** 当错误抛出。凡筛选后翻到超出范围的页，所有列表端点都会 500——分页器正常操作即可触发。已改为「416 = 空页 + 保留 `Content-Range` 总数」，并补了单测。

**变异验证:** 把服务层的 `requested_amount` 改成 `requested_amount_typo` 后，第 5 条立刻变红（HTTP 500），证明这套用例确实守住了「参数名写错只会在线上炸」这个原始风险点。

**已补（2026-11-19）:** `RestMissingResourceError` + errorHandler 日志/`details.dependency`，404 与 PGRST202/205 不再笼统落 500。见 journal `2026-11-19-g1-g3-final-gaps.md` §G3。

### A3 原始评估（保留以便追溯）

- [x] 让至少 6 个写端点在真实 HTTP 下跑通，含乐观锁与三个 409

> **已由方案 a 取代（2026-10-29）**，此条保留只为追溯当时的判断依据：
> 最终交付的是上面 A3 的 21→24 个集成文件，覆盖远超「6 个写端点」。

**现状证据（当时的判断依据，保留）:** 仓库层单测全部打桩；31 个端点的真实 HTTP 行为无自动覆盖。上一轮用一次性 SQL 探针（真实 PG，跑完 `ROLLBACK`）手工验了 9 个参数名与 `result_application_id` / `new_status` / `new_step` / `error_code` 四组返回列名——**这恰恰证明这层假设会错**，而错了只会在生产 500，探针不入库等于没有回归保护。

**决策结果:** 采用方案 a。方案 b 只能覆盖一半：PostgREST 的 416、206、`Content-Range` 与 SQLSTATE→状态码映射都不在 pg 直连里，而这些正是这次抓到的 bug 所在。

### A4 vitest worker 超时定位 — 已完成

- [x] 连续 5 次全绿，或给出根因与规避配置

**根因（2026-10-30）:** 不是「worker 在测试中超时」，是 **fork worker 启动失败**：`Failed to start forks worker` → `Timeout waiting for worker to respond`。默认并发是 `cpus-1`，本机 16 核 → 15 个并发 Node 进程，Windows 上把 worker 启动压到超时。

**最关键的一点（比我原来的判断严重）:** 被吞掉的那个文件的用例**根本没跑**，而汇总仍然报 `Test Files 38 passed (38)`，只有末尾一个 `Errors 1 error`。实测同一份代码连跑两次：先 6 秒 272 用例通过，紧接着 61 秒 **257** 用例 + 1 error。也就是说默认并发下这个门禁每两次就有一次在漏跑 15 条断言，而信号看起来像抖动。

**规避配置:** `vitest.config.ts` 加 `maxWorkers: 6`。改后连续 4 次 4~5 秒、39 文件 272 用例全绿（比失败那次的 61 秒快十倍——说明 61 秒是争用，不是工作量）。

**教训（已写进 `.harness/ENGINEERING_STANDARDS.md`）:** `Errors N error` 一律按失败处理，且要看用例总数是否与上次一致；总数变少而没有失败用例 = 有断言被跳过。

**规模:** S

### A5 供应商模块行为测试

- [x] 新增 `apps/api/src/modules/suppliers/routes.test.ts` 与服务层关键分支

**现状证据:** `packages/contracts/src/suppliers.ts`、`apps/api/src/modules/suppliers/{routes,service}.ts`、4 个前端文件都在，但**没有任何测试文件**（grep `supplier` 只在别的模块测试里被顺带引用）。这是唯一一个「完整交付但零行为断言」的业务模块。

**覆盖:** 租户隔离、重名冲突、被应付引用时不可删（`OBJECT_REFERENCED`）、列表筛选与分页。

**完成情况（2026-11-16）:** 卡片要求的「被引用不可删」原本没有代码路径（模块只有 list + create），
所以先补了**薄的**删除能力再测：不自己数引用，直接交给外键 `order_payables.supplier_id` 的 RESTRICT，
23503 → **409 `OBJECT_REFERENCED`**（不是 CONFLICT：重名改名字，被引用得先去处置应付行）。
顺带把关键词清洗抽成 `sanitizeSupplierKeyword` 导出，让「服务层关键分支」可测。

⚠️ 与 `customer_sources` 同一个坑：`authenticated` 没有表级 `DELETE` 授权，只加策略会得到
`permission denied`（硬报错，不是 0 行）。迁移里 `GRANT DELETE` + 策略一起做。

**验证:** 新增 `routes.test.ts` **12 条**（列表/分页/筛选透传、重名 409、财务 403、删除 200/409/404、
关键词清洗含「裸 `%` 清空」）；新增 `supplier_delete.sql` **6 条** pgTAP。
pgTAP **37 文件**、单测 **65 文件 / 863 用例**、类型检查 api+web、eslint+CSS token、HTTP 集成 **24 文件 / 402 用例**。
详见 `.harness/journal/2026-11-16-a5-supplier-behavior-tests.md`。

**已补（2026-11-19）:** `PATCH /api/suppliers/:id` + 列表页编辑/启停/删除入口。见 journal §G1。

**规模:** S

---

## 阶段 B：数据完整性与权限口径

### B1 审批历史不随明细行删除消失

- [x] 有历史申请（含已驳回/已撤回）的明细行不可硬删，或删除后轨迹仍可读

**现状证据:** `finance_applications` 的三个外键都是 `ON DELETE CASCADE`（`20261029000008_finance_applications.sql:77–79`）。

已经挡住的部分：有在途申请的行删不掉——`update_order_with_items` 的删除判定含 `pending_amount > 0`（`20261029000006:192/202`），`order_line_update.sql:492` 有断言。

缺口：**被驳回或已撤回**的申请不占额度，行就能删，`finance_application_actions`（只追加的审批轨迹）随 CASCADE 一起消失。轨迹是审计材料，不该因为一次订单编辑而蒸发。

**决策（2026-11-15，已定）:** 两条路都不选原样，**改走「脱钩」**。理由：`RESTRICT` 在**终态**下无解——驳回/撤回没有可处置动作，行会永远删不掉，比现状更糟；软删要把订单行与汇总口径一起改，波及面远大于这张卡的收益。

**实现:** `20261115000001_finance_application_line_history.sql`
- 删行前用 `BEFORE DELETE` 触发器把申请的 `receivable_id` / `payable_id` 置空（`SECURITY DEFINER`，避免被操作员权限挡住而退化成级联删除）；
- CHECK 放宽为「至多一个，非空时与 kind 对应」；
- 补两个 partial index 供外键检查与脱钩更新使用。

**验证记录:** `db:local:verify` 全绿（30 个测试文件），新增 `finance_application_history.sql` **19 条断言**：应收、应付各走一遍「驳回 → 额度释放 → 经 `update_order_with_items` 删行 → 行没了、申请还在、引用为空、`order_id` 不变」，并断言两条驳回轨迹都还在。脱钩后的明细名称由 API 兜底为「（明细已删除）」，前端无需改动。详见 `.harness/journal/2026-11-15-b1-application-history.md`。

**已补（2026-11-19）:** `finance_applications.line_name` + BEFORE INSERT 快照触发器；脱钩后仍显示原名。见 journal §G2。

**规模:** M

### B2 客户回收站与 `restore` 权限

- [x] 新增 `customer.restore` / `order.restore` 权限 + 专用 SELECT 策略 + 恢复端点 + 回收站页

> **进度（2026-11-15）：全部完成（订单恢复端点除外，见末段）。**
>
> **第一步（数据库）**：`20261115000002_restore_permissions.sql`：两个权限码（仅 admin）+
> `customers_select_restorable` / `orders_select_restorable` 两条「读已删除」策略 +
> `restore_customer` / `restore_order` 两个函数。`permissions.ts` 与快照同步更新。
>
> **第二步（客户恢复端点）**：`POST /api/customers/:customerId/restore`（`CUSTOMER_RESTORE`，返回
> `restoredCustomerId`）；服务层走 RPC 而不是直接 PATCH —— 已删除行被 SELECT 策略隐藏，
> 直接 PATCH 连自己刚删的那行都看不见。不在回收站里一律 404，不区分「没删过 / 不存在 / 别家组织」。
>
> **第三步（回收站列表 + 页面）**：`GET /api/customers/recycle-bin`（`customer.restore`，
> 分页 + 关键字，`deleted_at desc`，只返回掩码字段）；`CustomerRecycleBinView.vue` +
> 路由 `customers/recycle-bin` + 客户列表页右上角「回收站」入口（仅 admin 可见）。
> 回收站与正常列表拆成 `list` / `listDeleted` 两个仓储方法 —— 两者可见性由**不同 RLS 策略**授权，
> 合并会在仓储层做权限分流，漏判就会让删掉的客户混进正常列表（有专门一条测试断言两者不混用）。
>
> **验证**：pgTAP **33 文件全绿**（`restore_permissions.sql` 12 条断言）；单测 **60 文件 / 799 用例**；
> 类型检查（api + web）；eslint + CSS token；HTTP 集成 **21 文件 / 380 用例**。
> 见 `.harness/journal/2026-11-15-b2-restore-permissions.md` 与 `2026-11-15-b2-recycle-bin-page.md`。
>
> **未做（已定）：订单恢复端点 / 订单回收站页**——业务端没有删除订单的入口（`routes.ts` 里没有
> `deleteOrder`），给一个「恢复不存在状态」的端点只会成为死接口，留到订单删除接入时一起做。
>
> **未做（口径已改判）：订单 `restore` 动作不改用 `order.restore`。**
> 状态机的 `restore` 是「已取消 → 原状态」，处理的是**业务状态**，不是 `deleted_at` 意义上的删除；
> 若改用 `order.restore`（当前只有 admin 有），计调员就再也无法自助恢复被取消的订单，
> 这是权限口径的业务变更，不是本卡能顺带决定的。`20261029000004` 的注释约束的是「读已删除行」，
> 两者不冲突。真要收紧，单开一张卡讨论。

**现状证据:**
- `customers` 有 `deleted_at`，RLS 已隐藏，但**没有恢复入口**——软删等于单向。
- `20261029000004_soft_delete_visibility.sql:16–17` 的注释已经写明意图：「后续做回收站时不要放宽这两条策略，应另加一条带 `customer.restore` / `order.restore` 权限的 SELECT 策略，让恢复能力与读取已删除数据的能力绑定。」
- `packages/contracts/src/permissions.ts` 里**没有** `customer.restore` / `order.restore`。
- 订单状态机已有 `restore` 动作（`cancelled` → `previous_status`，`20261029000002:711`），但走的是 `order.write`，与上述注释的意图不一致。

**做法:** 两个新权限；独立的「读已删除」策略（恢复能力 = 读已删除能力）；恢复端点；回收站页（R-ORDER-03 的一部分）。订单 `restore` 改用 `order.restore` 并更新权限快照。

**验收标准:** pgTAP「无 restore 权限读不到已删除行」「有权限可读可恢复」；`permissions.test.ts` 快照按意图更新。

**规模:** M

---

## 阶段 C：需求未开始

### C1 R-APPROVAL-01 审批流配置化

- [x] 配置表 + 实例快照 + 级次驱动流程，≥3 级可跑

**现状证据:** `current_step integer NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 2)` 与 `step ... BETWEEN 1 AND 2` 写死在迁移里；流程固定为「财务 → 管理员」两级；「允许撤回」「允许同人审批」是固定值，不是配置。

**关键约束（来自需求，不可省）:** 在途实例必须保存流程快照，**修改配置不得静默改变既有实例**。

**验收标准:** pgTAP「改配置不改变在途实例」；3 级流程可跑通；两个开关各有效。

**完成情况（2026-11-15，数据库层）:** `20261115000003_approval_flow_config.sql`。
按机构配置（`organization_approval_flows`，1~3 级，每级用「需要的权限」表达而非角色名）；
申请创建时把生效配置快照进 `flow_snapshot`，引擎只读快照、永不回读配置表；旧行无快照按默认 2 级处理，
行为与改造前一致。`allowWithdraw = false` 用错误码 `WITHDRAW_NOT_ALLOWED`，不抛异常（流程拒绝 ≠ 故障）。

验证：`db:local:verify` **32 个测试文件全绿**，新增 `approval_flow_config.sql` 14 条断言 ——
核心一对是「先按 2 级提交 → 配置改为 3 级 → 该申请快照仍 2 级且真的只用 2 级终审通过」＋「改后新提交才是 3 级」，
另覆盖两个开关各自生效。详见 `.harness/journal/2026-11-15-c1-approval-flow-config.md`。

**已补（2026-11-19）:** `GET/PATCH /api/approvals/flow` + 设置页「审批流」卡片；契约 `packages/contracts/src/approvals.ts`。见 journal `2026-11-19-b1-b6-gaps.md` §B1。

**规模:** L

### C2 R-MASTER-01 客户来源维护

- [x] CRUD 端点 + 客户表单下拉（含二级来源）

**现状证据:** `customer_sources` 只有建表、RLS、复合外键与两级唯一索引，**无任何 API、无下拉**。客户表单里 `source_id` 无法选择。

**完成情况（2026-11-15）:**
- `20261115000004_customer_source_delete.sql`：**表级 `GRANT DELETE` + 删除策略**。
  ⚠️ 只加策略不够 —— `authenticated` 原本没有表级 DELETE 权限，删除会直接
  `permission denied`（不是 0 行），接口层会当 500。
- 四条路由：`GET/POST /api/customer-sources`、`PATCH/DELETE /api/customer-sources/:sourceId`。
- 两级用「扁平 + parentId」返回，前端按父子平铺成「父 / 子」选项（不用 opt-group：搜索会丢分组）。
- 不允许改 `parentId`（改层级要防环，低频结构删了重建更安全）。
- 删除交给外键：被客户引用、或有子来源 → 23503 → **409** 并说明原因。

**验证:** pgTAP **33 文件全绿**（新增 `customer_source_delete.sql` 6 条断言，含「无写权限删除返回 0 行而非报错」）；
单测 **60 文件 / 796 用例**（客户模块新增 7 条）；类型检查 api+web；eslint+CSS token；HTTP 集成 **21 文件 / 380 用例**。
详见 `.harness/journal/2026-11-15-c2-customer-sources.md`。

**已补（2026-11-19）:** `/customer-sources` 列表页（改名/排序/启停/删除）。见 journal §B3。

**规模:** S/M

### C3 R-MASTER-01 标签管理补全

- [x] 补改名、删除（被引用时 RESTRICT）、客户批量打标

**现状证据:** 只有 `listCustomerTags` 与 `createCustomerTag` 两个端点，没有改名与删除。

**完成情况（2026-11-15）:**
- `20261115000005_customer_tag_manage.sql`：三处一起补——`GRANT DELETE`（原本只有 select/insert/update，
  缺表权限会让删除报 `permission denied` 而不是 0 行）、**UPDATE 策略**（原本根本没有，
  改名会被策略静默挡成 0 行、接口层只能报 404）、**DELETE 策略**。
- 外键 `customer_tag_links_tag_fk` 从 `ON DELETE CASCADE` 收紧成 `RESTRICT`：
  删标签原本会**静默清掉所有客户的打标记录**且不报错，现在 23503 → `409 OBJECT_REFERENCED`。
- 三条路由：`PATCH/DELETE /api/customer-tags/:tagId`、`POST /api/customers/batch-tags`。
- 批量打标**整批成功或整批不变**：先按可见性回读客户，有任何一个读不到就 404 且一行不写
  （`customer_tag_links` 的写策略只看组织与 `customer.write`，不看客户可见性，不回读就能给别人的客户打标）。
- 前端：`CustomerTagManagerModal.vue`（新建/改名/删除）、`CustomerBatchTagModal.vue`（加或减）、
  客户列表加勾选与两个入口。**顺带补上了「建标签」的入口** —— 此前 `createCustomerTag` 没有任何界面调用方，
  标签下拉永远是空的。

**验证:** pgTAP **34 文件全绿**（新增 `customer_tag_manage.sql` 7 条断言）；单测 **60 文件 / 809 用例**；
类型检查 api+web；eslint + CSS token；HTTP 集成 **22 文件 / 385 用例**（新增 `customer-tags.test.ts` 5 条真实链路）。
**变异验证**：把 `RESTRICT` 改回 `CASCADE` 后新断言有 3 条立刻变红。
详见 `.harness/journal/2026-11-15-c3-customer-tag-manage.md`。

**已补（2026-11-19）:** 标签管理弹窗每行可改色，空值发 `null` 清空。见 journal §B4。

**顺手发现（不在本卡范围）:** `format:sql:check` 在本机对 66 个既有 SQL 文件报不合格，
根因是 CRLF 与 sql-formatter 只输出 LF，不是格式走形；详见 journal 末段。

**规模:** S

### C4 R-ROUTE-01 线路主数据

- [x] 线路表 + 下拉 + 订单保存名称与金额快照

**现状证据:** `orders.route_name` 是纯文本，**没有线路主数据表**。改线路名后历史订单无法追溯原名称（R-FIN-01 要求「历史名称和金额不得随主数据修改而漂移」）。

**完成情况（2026-11-15）:**

- 新表 `routes`（`20261115000006_route_master.sql`）：名称、线路类型、地区、出发城市、天数、
  自组团、启停、备注；`(organization_id, name)` 唯一，`created_by` 由 `DEFAULT auth.uid()` 填入
  （插入策略要求它等于调用者，客户端填不了假值）。新权限 `route.read` / `route.write`
  （admin/operator 读写、finance 只读），权限快照断言 `permissions_and_disabled_sessions.sql` 随之更新。
- 四个端点：`GET/POST /api/routes`、`PATCH/DELETE /api/routes/:routeId`。
  改名为空 PATCH 直接 400；重名 409 `CONFLICT`；`null` 与「不传」区分（清空 vs 不修改）。
- 前端：订单表单的「线路名称」自由文本换成可搜索下拉 + 「新建线路」快捷新增
  （`views/routes/RouteFormModal.vue`、`views/routes/route-options.ts`）。
  下拉的 value **就是线路名**，不是 id —— 订单存的是名称快照，用 id 反而要造一个假 id 撑住历史值。
  编辑历史订单时 `ensure(name)` 会钉住那个名字（含当年手打、没建档的），否则下拉空白、一保存就被清成 null。
- **刻意不给 `orders` 加 `route_id` 外键**：快照按值保存就够了，加外键会诱导后来者 join 实时主数据，
  那正是需求禁止的漂移。金额快照同理 —— `order_receivables/payables` 的 name/amount 本来就是拷贝。

**验证:** pgTAP **35 文件全绿**（新增 `route_master.sql` 10 条断言，含「改名后历史订单 `route_name` 不变」
与「删线路后订单仍在」）；单测 **61 文件 / 819 用例**（新增 `modules/routes/routes.test.ts` 10 条）；
类型检查 api+web；eslint + CSS token；HTTP 集成 **23 文件 / 391 用例**
（新增 `tests/integration/routes.test.ts` 6 条，验证 `created_by` 真取到人、23505→409、DELETE 后 404）。
详见 `.harness/journal/2026-11-15-c4-route-master.md`。

**已补（2026-11-19）:** `/routes` 列表页 + `RouteFormModal` 支持编辑。见 journal §B2。原记录：端点齐了但界面只有订单表单里的「新建」，
与 C2 的来源管理页同一取舍；线路类型/地区/出发城市在公司字典（R-SETTING-01）落地前保持自由文本。

**规模:** M

### C5 R-TOURIST-01 游客名单

- [x] 名单 CRUD + 证件号去重 + CSV 预览/整批原子

**现状证据:** 全仓 `tourist` 零引用——表、API、页面都没有。

**覆盖要点:** 按证件类型 + 规范化证件号去重；证件号为空不自动合并；重复证件/非法日期/缺列/编码错误使**整批拒绝**，不产生部分写入。

**完成情况（2026-11-16）:**

- 新表 `tourists`（`20261116000007_tourist_roster.sql`）：姓名、手机、证件类型、证件号、
  成人/儿童、年龄、性别、备注，挂在订单上（复合外键带 `organization_id`，订单物理删除时级联）。
  去重键 `(order_id, document_type, normalized_document_number)` 建在**生成列**上
  （去空白、去连字符、统一大写），且是**部分唯一索引**（`WHERE normalized_document_number
  IS NOT NULL`）——证件号为空的人彼此不冲突，这正是「空号码不自动合并」。
  CHECK 要求「有号码必须有类型」，避免护照与身份证同号时少一维去重键。
- **不新增 `tourist.*` 权限**：名单是订单聚合的一部分，复用 `order.read` / `order.write`。
  可见性也不自己算，策略用 `EXISTS (SELECT 1 FROM orders ...)`，组织/权限/数据范围/软删除
  全由 orders 自己的 RLS 决定——同一份规则只写一处。
- 六个业务端点：`GET/POST /api/orders/:orderId/tourists`、
  `PATCH/DELETE /api/orders/:orderId/tourists/:touristId`、
  `POST /api/orders/:orderId/tourists/import-preview`、`.../import`；
  外加 `GET /api/tourists/import-template`（返回 JSON 里的文件名 + 内容，前端拼 Blob 下载，
  保住 `respond()` 的全量出站校验）。
- **导入走库函数 `import_tourists(order_id, mode, rows)`**，不是「先 DELETE 再 POST」：
  覆盖模式的两次调用之间进程被回收就是数据丢失；函数体是一个事务，一行失败整批回滚
  （含刚做的 DELETE）。返回 `inserted_count` / `deleted_count`。
- CSV：列头固定八列、`\uFFFD`/NUL 视为编码错误整批拒绝、逐行错误带物理行号
  （引号内换行不会把行号带偏）、行数上限 2000。证件类型/成人儿童/性别只认中文词表
  （也接受英文码），认不出就报错，不猜。预览与提交共用同一段解析代码，提交时服务端重新解析。
- 前端：订单详情新增「游客名单」区（列表 + 申报/名单差额提示 + 增改删 + CSV 导入弹窗 +
  模板下载）。无 `customer.sensitive.read` 时证件号与手机只显示掩码，且表单把这两个输入框
  锁住并从 PATCH 里剔除——否则一次「只改备注」的保存会把掩码当原值写回去。

**验证:** pgTAP **36 文件全绿**（新增 `tourist_roster.sql` 17 条断言，含「换了写法的同一证件被拒」
「空号码两行都能进」「批内重复整批回滚」）；变异验证：去掉部分唯一索引后该文件变「通过 10 / 失败 7」；
单测 **63 文件 / 849 用例**（新增 CSV 解析 16 条 + 路由 14 条）；类型检查 api+web；eslint + CSS token；
HTTP 集成 **24 文件 / 402 用例**（新增 `tests/integration/tourists.test.ts` 11 条，验证
`rpc/import_tourists` 的真实参数/返回、23505→409、覆盖模式回滚后名单不变）。
详见 `.harness/journal/2026-11-16-c5-tourist-roster.md`。

**已补（2026-11-19）:** 名单区「导出名单」CSV（用页面已加载数据，不绕过脱敏）。见 journal §B6。仍**未做**：游客与客户档案的关联（需求未要求，同一客户再报名是另一张单）；
名单不进「编辑订单」表单——整单提交是替换语义，混进名单会让「只改金额」也重写名单；
前端交互（表格、导入弹窗、模板下载）只有类型保证，没有真人点过。

**规模:** L

---

## 阶段 D：工程与性能

### D1 前端产物体积

- [x] 主 chunk < 500 kB，或给出「为什么不能拆」的结论

**现状证据:** `dist/assets/index-BSn1wpC7.js` 1,638.00 kB / gzip 506.52 kB，构建报 `Some chunks are larger than 500 kB after minification`。

**做法:** `build.rollupOptions.output.manualChunks` 拆分 antd / vue 生态；顺手核对是否有全量引入（`ant-design-vue` 按需加载是否生效）。

**完成情况（2026-11-16）:**

- **根因不是没做 code splitting**（路由一直是动态 import），是 `app.use(Antd)` 全量注册：
  它 `Object.keys(components).forEach(app.use)`，静态分析看不到边界，70 个组件连同各自的
  `vc-*` 依赖全部进包。**「按需加载是否生效」的答案是从未生效。**
- 改成显式注册清单（`apps/web/src/design-system/antd-registration.ts`，27 个组件），
  `main.ts` 只做 `forEach(app.use)`；子组件由父组件 install 带出。
- 同时删掉 `StyleProvider` 的注册：`app.use` 只注册组件名，本仓从没用 `<a-style-provider>`
  包裹过，它原本就没生效；`useStyleInject()` 有默认上下文兜底，删除行为中立。
- `manualChunks` 按生态切 `vendor-vue` / `vendor-antd` / `vendor-supabase` / `vendor`，
  目的是业务代码改动不再让 895 kB 的 antd 缓存失效。
- **新增守卫测试** `antd-registration.test.ts`：漏注册组件不会构建失败、不会类型报错，
  只会在浏览器里渲染成空白，所以扫全部 `.vue` 的 `<a-*>` 标签与 install 探测出的注册名对账。

**验证:** 入口 chunk **1,871.64 kB → 38.04 kB**（gzip 567.34 → 12.52）；首屏 JS 合计
**1,463.44 kB / gzip 445.80（−21.8% / −21.4%）**——总量真降了 408 kB，不是把数字搬到别的 chunk。
pgTAP **36 文件全绿**（本卡未动数据库）；单测 **64 文件 / 851 用例**（改前 63 / 849）；
类型检查 api+web；eslint + CSS token；构建通过；`vite preview` + Chromium 实测 `/login`
渲染正常、零 `Failed to resolve component`。变异验证：删掉 `Table` 注册后守卫报出 11 处
受影响模板。详见 `.harness/journal/2026-11-16-d1-web-bundle-size.md`。

**未做:** `vendor-antd` 仍 895 kB（gzip 270）——构成里每一项都在用（`vc-tree` 来自 Table 的
勾选、`RangePicker` 来自订单日期筛选…）。要再降只有「分页面局部注册把 Table/DatePicker
移出首屏」这条路，收益约 66 kB gzip，但会把标签解析从全局清单变成局部绑定，
在 A1 的浏览器回归铺好之前风险大于收益。zod 约占首屏 150~180 kB，属 `@erp/contracts`
的有意设计（响应体运行时校验），不在本卡。

**规模:** S


### D2 E2E 接入 CI

- [x] E2E 在 CI 真实跑通（GitHub Actions `udone-ci`，run #5 `44675102215` 全绿）

**现状证据:** GitHub Actions 两个 job 全绿，质量门禁 1m21s、前端 E2E 1m25s，总耗时 1m29s。
证据链接：https://github.com/Golinoa/xw-/actions/runs/44675102215 （提交 `9b8ffd2`）。

**注意:** 写完 yml 不算完成，必须看到流水线真实跑过并留下结果。

**配置完成（2026-11-16，待流水线实跑）:** `.workflow/ci.yml` 的 `quality` 阶段新增第二个 step
`e2e_gate`（`pnpm exec playwright install --with-deps chromium` → `pnpm e2e`）。
单独成 step 是因为浏览器下载约 150 MB，混进静态门禁会让「红的是哪一类」难判断。
YAML 已用解析器校验通过（2 个 step，触发器未变）。

**本地全量实测（2026-11-19）:** 5 个 spec + 新增的 `admin-surfaces.spec.ts` 共 **17 条用例，
16 通过 1 跳过**（跳过的仍是 CAPTCHA 那条，缺 site key）。新增 6 条覆盖 C6–C12 的六个界面，
并在编写过程中抓到并修掉一个**整页白屏**：`<a-table title="供应商统计">` 把字符串传给了
ant-design-vue 的渲染函数型 `title`，`/reports` 挂载即抛 `TypeError`。类型检查、生产构建
都发现不了这一类问题，只有真浏览器能暴露——这正是 `e2e_gate` 存在的理由。

**已推送（2026-11-19）:** `main` 推到 `dc2d874`（32 个提交），按 `prefix: main` 应触发 `udone-ci`。
仓库是私有的，匿名 API 读不到流水线（`/api/v5/repos/.../commits/<sha>` 直接 404），
所以**结果仍需在有权限的页面里确认一次**，格子保持未勾。

**已验证（2026-11-20）:** Gitee Go 始终没有生成流水线对象；改用 GitHub Actions 后，
`.github/workflows/ci.yml` 被自动识别并在 push 时触发。第 5 次运行
https://github.com/Golinoa/xw-/actions/runs/44675102215 两个 job 全绿，
`e2e_gate` 真实执行完毕（1m25s，无失败）。中间修掉三处只有 CI 才暴露的问题：
工作流自身的 Prettier 引号、`udone/package.json` 指向已删除目录的幽灵 glob、
Linux 可选包 `@img/sharp-libvips-linux-x64` 的开发期许可例外（用户批准）。
详见 journal `2026-11-20-d2-github-ci-green.md`。
若该镜像不允许 `apt`，`--with-deps` 会明确失败 —— **不要在失败时删掉这行让用例假装通过**，
正确做法是在镜像里预装 Chromium 依赖。

**CI 视角预检（2026-11-19 23:5x，提交 `646f28e`）** —— 观察不到结果，那就先把
「已知会红的点」清干净。结论：清掉了一个真会让流水线**第一步**就红的缺陷。

- `format:check` 在本机恒报 207 个文件红，那是 `core.autocrlf=true`
  （工作区全 CRLF）撞上 `.prettierrc.json` 的 `endOfLine: "lf"`，一直被当噪音跳过。
  **按 CI 检出内容（LF）复验**才暴露出 4 个文件真不合规：`ops/auth/routes.ts`（多余空行）、
  `CustomerRecycleBinView.vue`、`order-finance-flow.spec.ts`、`order-list-states.spec.ts`（行宽）。
  已修（15+/18−，纯格式），修后同一复验 **0 不合规**。⇒ `quality_gate` 第一行不再必红。
- 复验方法（本机唯一可信的办法，下次照抄）：
  `git -c core.autocrlf=false -c core.eol=lf archive HEAD --format=tar -o "C:/.../head.tar"`
  → 解包 → 在解包目录的 `udone` 里用 `udone/node_modules/prettier/bin/prettier.cjs`
  跑与 `package.json` 同一组 globs。**先确认导出文件的 CR 计数为 0**，否则测的不是 CI 的东西。
- `pnpm install --frozen-lockfile` 不会因锁文件过期炸：4 个 importer 与各 package.json 逐项一致。
- E2E 不会挂住：`CI=1` 全量 **24 通过 1 跳过 / 25.6s / 退出码 0**。
  上一轮「跑完不退出」只在复用外部 dev server（`reuseExistingServer`）时出现，不是流水线风险。

**仍卡在哪、需要什么（逐条可执行）:**
1. Gitee Go 里这条仓库**还没有流水线对象**（`.workflow/*.yml` 只是描述，不会自行注册）。
   需要用户在 `gitee.com/rainy_morningh/ERP` →「流水线」→ 新建（空模板 → 代码视图）
   → 粘贴根目录 `.workflow/ci.yml` → 保存。
2. 保存后核对三项：`name=udone-ci`、触发器 `main` / `feat/` 前缀、`quality` 阶段两个 step
   （`quality_gate` + `e2e_gate`）。
3. 随便推一次（或手动运行），确认 `e2e_gate` 绿。**这一格要看到真实结果才勾。**
4. 本机无法代办：缓存的 git 凭据是 9 位账号密码，Gitee OpenAPI 已不接受密码认证
   （实测 `Authorization: token` → 401），所以拿不到流水线 API。

**本地全序列回放（2026-11-20，HEAD `2fb4d5c`）** —— 按 `ci.yml` 的 goals 顺序逐步重跑，
不做等价替代。结论：**两个 step 预计全绿**，剩下只是运行镜像的不确定性。

| 步骤 | 结果 | 耗时 |
|---|---|---|
| `format:check`（LF 导出，CI 视角） | ✅ 0 不合规 | ~10s |
| `lint`（eslint + CSS token） | ✅ | 10s |
| `typecheck`（api + web） | ✅ | 11s |
| `test`（vitest） | ✅ 74 文件 / 925 用例 | 13.6s |
| `build`（web + api） | ✅ | 13s |
| `schema:check` | ✅ 61 个迁移与清单一致 | 2s |
| `check:deploy` | ✅ | 3s |
| `e2e_gate`（`CI=1`，25 条） | ✅ 24 通过 1 跳过，退出码 0 | 23.2s |

Node 版本差异已探：用系统 Node 24.22.1 复跑单测，**74 文件 / 925 用例同样全绿**。
唯一仍需留意的是镜像能否 `apt` 装 Chromium 依赖（`--with-deps` 失败时要预装，不许删这行）。

**顺带纠正一条被误判两轮的门禁（范围外发现，未改）:** `format:sql:check` 的红**不是**
CRLF 噪音。换行归一化后仍有 **25 个文件**真不一致，且 `sql-formatter` 的输出更差
（`count(*)` → `count (*)`、单行 `CHECK` 被拆成 4 行），故不做批量格式化；
它不在 `ci.yml` 里，不影响流水线。详见 journal `2026-11-20-d2-ci-sequence-replay.md` 第 3 节。

**收尾核查（2026-11-20 03:4x，HEAD `b1b973b`）:** 计划内其余 20 项在 HEAD 上产物齐全，
不存在「勾了但东西没了」——61 迁移 / 50 个 pgTAP / 34 个 HTTP 集成测试 / 68 个单测文件 /
7 个 E2E spec，只增不减；17 个页面组件全部挂在路由上（另外 13 个是弹窗/抽屉），
35 条 `app.route` 覆盖 16 个业务模块 + 17 个 ops 模块、无孤儿模块。
本轮没重跑测试（2 小时前刚按 `ci.yml` 全序列回放过，期间零提交），避免把核查变成又一次门禁。
详见 journal `2026-11-20-backlog-closure-audit.md`。

**2026-11-20 09:4x：三份 `ci.yml` 收敛成一份会跑的那份**（journal `2026-11-20-d2-single-live-workflow.md`）

- **真缺陷**：`udone/.github/workflows/ci.yml` **永远执行不到**（GitHub 只读仓库根），
  而 `tests/tooling/harness-config.test.ts` 断言的正是它 ⇒「CI 已覆盖 `deps:audit` /
  `licenses:check` / `secrets:check` / `db:test`」这一结论从来没被任何一次运行验证过。
  已 `git rm`；断言改为指向根目录那份，并加两条反向断言（`playwright install --with-deps
  chromium` 必须存在；子目录不得再有副本）。两条都做过变异验证（各 `1 failed | 10 passed`）。
- 根 `.github/workflows/ci.yml` 成为唯一活文件：`quality` 15 步 + `e2e` 7 步，action 钉 SHA、
  `permissions: contents: read`；把那 4 道门禁补回来（本机先逐条实测：`deps:audit`
  critical 0 / high 0、`licenses:check` 349 组通过、`secrets:check` 退出 0、canary 退出 0）。
- `format:check` 的 glob 补 `"../.github/**"`——此前只覆盖 `udone/.github` 与 `../.workflow`，
  **真正会跑的那份配置反而不在格式门禁里**。
- 顺带排掉「Linux 首跑才红」的四类风险：856 条相对导入 **0 处**大小写不一致；
  lockfile v9 含 `@rollup/rollup-linux-*` / `@esbuild/linux-x64`（不会缺二进制）；
  无 `.only`（否则 vitest `forbidOnly` 直接失败）；`pnpm -v` = 11.24.0 与 `packageManager` 一致。
- 门禁：单测 **74 文件 / 925 用例**、lint + CSS token、改动文件按 LF 副本 prettier 全绿。
- **格子仍不勾**：Gitee Go 无流水线对象、仓库无 GitHub remote，两条流水线都还没有真实运行记录。

**本轮之后要做的只有一件事（不是我能代办的）:** 在 Gitee Go 建流水线并跑一次，
看到 `e2e_gate` 绿后再勾这一格。若短期内不打算建，建议把 biz-backlog 的小时级自动化暂停。

**规模:** S（依赖 A1）

---

## 5. P2 批量项（C6–C12 全部完成，2026-11-19 收官）

以下按 `Docs/REQUIREMENTS.md` 对应章节执行，开工时再拆成 A/B 阶段的粒度。

| 编号 | 需求 | 现状（2026-11-18） | 规模 |
|---|---|---|---|
| ~~C6~~ | R-SETTLE-01 批量结算 | ✅ **已验证 2026-11-18**：2 表 + 3 RPC + 4 端点 + Web 页面；pgTAP 43 文件、HTTP 集成 25 文件/412 用例、Vitest 67/883 全绿；证据 `.harness/journal/2026-11-18-c6-settlement-batches.md` | L |
| ~~C7~~ | R-BALANCE-01 账户余额 | ✅ **已验证 2026-11-19**：资金账户 + 实时余额函数 + 不可变调整流水 + 3 端点 + Web 页；pgTAP 47 文件、HTTP 29/432、Vitest 71/902 全绿；证据 `.harness/journal/2026-11-19-c7-account-balances.md` | L |
| ~~C8~~ | R-REPORT-01 报表与统一口径 | ✅ **已验证 2026-11-19**：2 个口径函数 + 2 端点 + Web 报表页 + CSV 导出同源；pgTAP 48 文件、HTTP 30/437、Vitest 72/907 全绿；证据 `.harness/journal/2026-11-19-c8-reporting.md` | L |
| ~~C9~~ | R-NOTIFY-01 站内通知 | ✅ **已验证 2026-11-19**：通知表 + 事务内触发器 + 3 端点 + Web 页与未读角标；pgTAP 46 文件、HTTP 28/427、Vitest 70/897 全绿；证据 `.harness/journal/2026-11-19-c9-notifications.md` | M |
| ~~C10~~ | R-AUDIT-01 审计日志 | ✅ **已验证 2026-11-19**：IP/设备掩码摘要 + 统一 write_audit + 订单状态/金额/审批触发器 + 只读查询页；pgTAP 45 文件、HTTP 27/422、Vitest 69/892 全绿；证据 `.harness/journal/2026-11-19-c10-audit-log.md` | M |
| ~~C11~~ | R-CRM-01/02 线索与公海 | ✅ **已验证 2026-11-19**：线索 + 事件时间线 + 公海乐观锁 + 7 天回收 + 幂等转客户，7 端点 + Web 页；pgTAP 49 文件、HTTP 31/442、Vitest 73/912 全绿；证据 `.harness/journal/2026-11-19-c11-crm-leads.md`。转订单（预订单、金额待补）与阶段统计已补 2026-11-19 | L |
| ~~C12~~ | R-SETTING-01 公司配置 | ✅ **已验证 2026-11-18**：配置表 + 版本化 RPC + 2 端点 + Web 设置页；二次确认落在服务端；pgTAP 44 文件、HTTP 集成 26 文件/418 用例、Vitest 68/888 全绿；证据 `.harness/journal/2026-11-18-c12-company-settings.md` | S |

---

## 6. 执行顺序与门禁规则

**建议顺序（先便宜的先做，先风险高的先做）:**

1. ~~A2~~ —— ✅ 2026-10-30 完成，`.vue` 类型盲区已关闭。
2. A1 —— 把前端从「未验证」变成「已验证」，这是当前最大的一块空白。
3. B1 —— 数据完整性，越晚做积累的历史数据越多，迁移越麻烦。
4. A5 —— 小成本补证据（A4 已于 2026-10-30 完成）。
5. B2 → C1 → C3 → C2 → C4 → C5 —— 业务功能按依赖推进。
6. ~~A3~~ —— ✅ 2026-10-29 完成（方案 a，真实 PostgREST）。
7. D2 → D1。
8. ~~C7–C11 按业务优先级排。~~ ✅ 已全部完成。

**注:** 运营后台（`feat/ops-console` → 本分支）的 T-01~T-14 与 Wave 0 前置纠正已另立计划 `2026-10-30-ops-backend-implementation.md`，优先级高于本文件第 2 项之后的全部条目——它一开，A1 的 E2E 基线会跟着变，先做 A1 要返工。

**每个任务的完成定义（缺一不可）:**

- 独立提交，提交信息说明「为什么」而不只是「改了什么」。
- 门禁全绿：`format:check` / `format:sql:check` / `lint`(+CSS token) / `schema:check` / `check:deploy` / `typecheck` / `test` / `build` / `db:local:verify`。
  （2026-11-20 实测：`format:sql:check` 对存量 25 个文件恒红，且 `sql-formatter` 的输出比手写更差、
  会重排已提交的迁移 ⇒ 该项按「新增迁移必须能被 formatter 接受、存量不动」执行，
  判据与理由见 D2 卡片与本日 journal。`format:check` 在本机需按 LF 导出复验，工作区直接跑必红。）
- 涉及迁移必须补 pgTAP；涉及行为规则必须做**变异验证**（改坏实现，确认断言真的变红）。
- 任务状态只有两种：**已验证** / **未验证**。不存在「基本完成」。
- 无法验证的部分（真实 Supabase、真实浏览器、真实流水线）必须在提交说明与 journal 中标注，不得被「全绿」掩盖。

## 7. 明确排除

- **admin 运营后台**：位于相邻仓库，由独立主线维护，不在本计划范围。
- **R-FILE-01 七牛文件存储**：需求已明确暂缓，触发条件是「出现需要持久化的上传/下载流程后另立执行任务」。在此之前不实现 SDK、上传 UI/API、签名 URL。
- **多实例限流与幂等**：当前为内存实现，已在代码注释与 `.harness/CONTRACTS.md` 标注「单实例有效」，等真正需要多实例时再做。

## 8. 跟踪方式

- 勾选本文 `- [ ]` 并附证据链接（提交哈希 / journal 文件）。
- 关闭任务时同步 `.harness/docs/exec-plans/tech-debt-tracker.md` 与 journal 当日记录。
- 本文与 `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md` 冲突时，以那份计划的阶段划分与验收为准；本文件只在「任务粒度与现状证据」上更细。
