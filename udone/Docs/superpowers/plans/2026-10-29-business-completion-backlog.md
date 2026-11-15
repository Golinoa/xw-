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

原计划 **21 项**：A 段 5 项、B 段 2 项、C 段 12 项、D 段 2 项。其中 **A3 已完成**（见下文），剩余 20 项。下表 C6–C12 合并为一行呈现，明细见 §5。

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
| C6–C12 | 结算 / 余额 / 报表 / 通知 / 审计 / CRM / 公司配置 | P2 | L | 见 §5 |
| D1 | 前端产物体积（chunk 拆分） | P2 | S | — |
| D2 | E2E 接入 CI | P1 | S | A1 |

---

## 阶段 A：验证闭环

当前最大的风险不是「功能没做」，而是「做了但不知道对不对」。这一阶段把盲区变成证据。

### A1 前端主线 E2E（Playwright + 网络拦截）

- [ ] 新增 3 个 spec，覆盖「登录 → 订单列表 → 订单详情金额行 → 发起收款申请 → 审批通过 → 金额从在途转已收」

**现状证据:** `tests/e2e/` 仅 2 个 spec / 6 用例，全部围绕登录与成员邀请；上一轮提交说明里明确写了「这个界面没有在浏览器里跑过」。

**做法:**
- 用 Playwright 内置 `page.route('**/api/**')` 拦截请求，不起真实后端。
- **stub 的响应体必须先用 `@erp/contracts` 的 schema 解析一遍再返回**。stub 与契约不一致时当场失败，否则 E2E 会养活一份平行契约——那比没有 E2E 更危险。
- 同时覆盖四种状态：空列表、加载失败（500 时显示可读文案而非白屏）、无权限（按钮不出现）、驳回未填意见（提交前拦下）。

**验收标准:**
- 新增 ≥3 个 spec，`pnpm e2e` 本地全绿。
- 提交说明写明边界：**只证明前端渲染与交互，不证明服务端行为**。

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

**遗留:** PostgREST 返回 404（RPC 不存在，例如迁移没应用）时，服务层仍落到 500「服务暂时不可用」，不指向具体原因。属于错误可诊断性问题，未在本轮处理。

### A3 原始评估（保留以便追溯）

- [ ] 让至少 6 个写端点在真实 HTTP 下跑通，含乐观锁与三个 409

**现状证据:** 仓库层单测全部打桩；31 个端点的真实 HTTP 行为无自动覆盖。上一轮用一次性 SQL 探针（真实 PG，跑完 `ROLLBACK`）手工验了 9 个参数名与 `result_application_id` / `new_status` / `new_step` / `error_code` 四组返回列名——**这恰恰证明这层假设会错**，而错了只会在生产 500，探针不入库等于没有回归保护。

**决策结果:** 采用方案 a。方案 b 只能覆盖一半：PostgREST 的 416、206、`Content-Range` 与 SQLSTATE→状态码映射都不在 pg 直连里，而这些正是这次抓到的 bug 所在。

### A4 vitest worker 超时定位 — 已完成

- [x] 连续 5 次全绿，或给出根因与规避配置

**根因（2026-10-30）:** 不是「worker 在测试中超时」，是 **fork worker 启动失败**：`Failed to start forks worker` → `Timeout waiting for worker to respond`。默认并发是 `cpus-1`，本机 16 核 → 15 个并发 Node 进程，Windows 上把 worker 启动压到超时。

**最关键的一点（比我原来的判断严重）:** 被吞掉的那个文件的用例**根本没跑**，而汇总仍然报 `Test Files 38 passed (38)`，只有末尾一个 `Errors 1 error`。实测同一份代码连跑两次：先 6 秒 272 用例通过，紧接着 61 秒 **257** 用例 + 1 error。也就是说默认并发下这个门禁每两次就有一次在漏跑 15 条断言，而信号看起来像抖动。

**规避配置:** `vitest.config.ts` 加 `maxWorkers: 6`。改后连续 4 次 4~5 秒、39 文件 272 用例全绿（比失败那次的 61 秒快十倍——说明 61 秒是争用，不是工作量）。

**教训（已写进 `.harness/ENGINEERING_STANDARDS.md`）:** `Errors N error` 一律按失败处理，且要看用例总数是否与上次一致；总数变少而没有失败用例 = 有断言被跳过。

**规模:** S

### A5 供应商模块行为测试

- [ ] 新增 `apps/api/src/modules/suppliers/routes.test.ts` 与服务层关键分支

**现状证据:** `packages/contracts/src/suppliers.ts`、`apps/api/src/modules/suppliers/{routes,service}.ts`、4 个前端文件都在，但**没有任何测试文件**（grep `supplier` 只在别的模块测试里被顺带引用）。这是唯一一个「完整交付但零行为断言」的业务模块。

**覆盖:** 租户隔离、重名冲突、被应付引用时不可删（`OBJECT_REFERENCED`）、列表筛选与分页。

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

**遗留:** 未做明细名称快照（脱钩后只知道是哪一单，不知道原叫「团款」）；本机缺 vitest，`pnpm test` 未跑，本次无 TS 改动，`tsc --noEmit` 已过。

**规模:** M

### B2 客户回收站与 `restore` 权限

- [ ] 新增 `customer.restore` / `order.restore` 权限 + 专用 SELECT 策略 + 恢复端点 + 回收站页

> **进度（2026-11-15）：数据库与契约已完成，端点与页面待做。**
> `20261115000002_restore_permissions.sql`：两个权限码（仅 admin）+
> `customers_select_restorable` / `orders_select_restorable` 两条「读已删除」策略 +
> `restore_customer` / `restore_order` 两个函数。`permissions.ts` 与快照同步更新。
> 验证：`db:local:verify` 31 个文件全绿，新增 `restore_permissions.sql` **12 条断言**；
> `tsc --noEmit` 0 错误。**未做**：恢复端点（要改 `routes.ts` 与路由一致性守卫）与回收站页
> —— 本机缺 vitest，改了无法验证契约与实现一一对应。见 `.harness/journal/2026-11-15-b2-restore-permissions.md`。
> 另：`customer_rls.sql` 两条按旧口径写死的断言已按新意图调整（admin 现在有此权限）。

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

**未做:** 配置读写端点（`GET/PUT /api/v1/approvals/flow`）与设置页；契约层 `ApprovalFlow` schema 待端点定稿后一起加（避免两处定义漂移）。

**规模:** L

### C2 R-MASTER-01 客户来源维护

- [ ] CRUD 端点 + 客户表单下拉（含二级来源）

**现状证据:** `customer_sources` 只有建表、RLS、复合外键与两级唯一索引，**无任何 API、无下拉**。客户表单里 `source_id` 无法选择。

**规模:** S/M

### C3 R-MASTER-01 标签管理补全

- [ ] 补改名、删除（被引用时 RESTRICT）、客户批量打标

**现状证据:** 只有 `listCustomerTags` 与 `createCustomerTag` 两个端点，没有改名与删除。

**规模:** S

### C4 R-ROUTE-01 线路主数据

- [ ] 线路表 + 下拉 + 订单保存名称与金额快照

**现状证据:** `orders.route_name` 是纯文本，**没有线路主数据表**。改线路名后历史订单无法追溯原名称（R-FIN-01 要求「历史名称和金额不得随主数据修改而漂移」）。

**规模:** M

### C5 R-TOURIST-01 游客名单

- [ ] 名单 CRUD + 证件号去重 + CSV 预览/整批原子

**现状证据:** 全仓 `tourist` 零引用——表、API、页面都没有。

**覆盖要点:** 按证件类型 + 规范化证件号去重；证件号为空不自动合并；重复证件/非法日期/缺列/编码错误使**整批拒绝**，不产生部分写入。

**规模:** L

---

## 阶段 D：工程与性能

### D1 前端产物体积

- [ ] 主 chunk < 500 kB，或给出「为什么不能拆」的结论

**现状证据:** `dist/assets/index-BSn1wpC7.js` 1,638.00 kB / gzip 506.52 kB，构建报 `Some chunks are larger than 500 kB after minification`。

**做法:** `build.rollupOptions.output.manualChunks` 拆分 antd / vue 生态；顺手核对是否有全量引入（`ant-design-vue` 按需加载是否生效）。

**规模:** S

### D2 E2E 接入 CI

- [ ] `.workflow/ci.yml` 跑 A1 的 spec，以实际跑通为准

**现状证据:** CI 里没有任何 Playwright 步骤。

**注意:** 写完 yml 不算完成，必须看到流水线真实跑过并留下结果。

**规模:** S（依赖 A1）

---

## 5. P2 批量项（需求未开始，暂不拆细）

以下按 `Docs/REQUIREMENTS.md` 对应章节执行，开工时再拆成 A/B 阶段的粒度。

| 编号 | 需求 | 现状 | 规模 |
|---|---|---|---|
| C6 | R-SETTLE-01 批量结算 | 无表无 API | L |
| C7 | R-BALANCE-01 账户余额 | 无资金账户概念 | L |
| C8 | R-REPORT-01 报表与统一口径 | 无统计服务 | L |
| C9 | R-NOTIFY-01 站内通知 | 无 | M |
| C10 | R-AUDIT-01 审计日志 | 无独立审计表，仅有业务轨迹 | M |
| C11 | R-CRM-01/02 线索与公海 | 无 `leads` 表 | L |
| C12 | R-SETTING-01 公司配置 | 无 settings 表 | S |

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
8. C6–C12 按业务优先级排。

**注:** 运营后台（`feat/ops-console` → 本分支）的 T-01~T-14 与 Wave 0 前置纠正已另立计划 `2026-10-30-ops-backend-implementation.md`，优先级高于本文件第 2 项之后的全部条目——它一开，A1 的 E2E 基线会跟着变，先做 A1 要返工。

**每个任务的完成定义（缺一不可）:**

- 独立提交，提交信息说明「为什么」而不只是「改了什么」。
- 门禁全绿：`format:check` / `format:sql:check` / `lint`(+CSS token) / `schema:check` / `check:deploy` / `typecheck` / `test` / `build` / `db:local:verify`。
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
