# Task 7 + Task 8 完成度审计

- 审计对象：`admin/.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md`
  - Task 7：第 187–192 行（6 条，私有化部署台账 / 售后工单）
  - Task 8：第 198–204 行（7 条，账号配置 / 审计 / 总览 / 报表 / 导出）
- 方式：只读静态审计（未安装依赖、未起服务、未跑测试、未连数据库、未 git 操作）
- 结论时点：2026-11-16
- 代码基线：`udone` 主工作树（未采用 `.worktrees/` 下的历史分支）与 `admin/apps/web-antd`

> 判定口径（复合条目的处理）：一条计划项若包含多个子要求，只要有一个子要求找不到实现或证据，就不算完成，记 `未实现`，并在「缺什么」里写清是单点缺口还是整块缺口。因此下表的 `未实现` 多数不是「整块没做」，而是「就差一处」。

## 结论速览

| 判定 | 条数 |
|---|---|
| 已实现 | 3 |
| 已实现无测试 | 0 |
| 未实现 | 9 |
| 需真跑 | 1 |
| **合计** | **13** |

缺口分布（9 条未实现的实际性质）：

| 性质 | 条数 | 条目 |
|---|---|---|
| 缺审计写入（工单域） | 2 | 188、189 |
| 前端缺功能（合同/授权关联、报表页、导出继承筛选） | 2 | 190、201 |
| 缺自我提权防护/测试 | 1 | 199 |
| 缺访问审计与 requestId 关联 | 1 | 200 |
| 缺 Playwright 与 staging | 2 | 192、204 |
| 缺性能基线 | 1 | 203 |

后端 Task 7/8 的**主链路是完整的**：deployment 7 个端点、tickets 10 个端点、accounts 7 个端点、overview 1 个、reports 4 个、exports 3 个，全部有路由、契约、迁移 + pgTAP；`ops_deployment_domain.sql` 1497 行、`ops_support_domain.sql` 1441 行、`ops_overview_domain.sql` 90 个断言、`ops_reports_domain.sql` 66 个、`ops_exports_domain.sql` 108 个。真正的问题集中在**审计覆盖面、前端功能完整度、跨端参数格式**三处。

---

## 报表与导出专项

### 1. 口径是否唯一：**应收已唯一且有等值断言；其余四项指标不是**

**已做到的部分：**

- 应收的派生状态与净额只有一处：视图 `udone/supabase/migrations/20261031000009_ops_overview.sql:49-74`。总览（`:303-320`）与应收报表（`udone/supabase/migrations/20261031000010_ops_reports.sql:61,147`）都从这个视图读；另三个报表（临期权益、租户同步失败、部署版本）与应收口径无关，各查自己的表。
- 计划里点名的 T-13 等值断言确实存在，且是逐值相等而不是「大致相等」：
  - 总览 vs 应收列表：`udone/supabase/tests/ops_overview_domain.sql:812-838`（total / settled / overdue 三条 `IS(...)`）
  - 报表 vs 应收列表：`udone/supabase/tests/ops_reports_domain.sql:525-557`（overdue 相等）
  - 状态派生一致：`udone/supabase/tests/ops_overview_domain.sql:1069`

**没做到的部分：**

- 契约自己声明的统一载体 `ops.fn_overview_metrics(...)` **不存在**：`admin/Docs/ops-api-contract.md:1093` 写了这个函数名，`udone` 全仓搜不到实现。实际做法是 `get_ops_overview` 内部直接写 SQL。
- 其余四项指标各写一套 SQL，没有与对应列表端点比对：
  - 临期权益 `20261031000009_ops_overview.sql:193-209`（订阅看 `ends_on`、授权看 `valid_to`，自己拼）
  - 开放/等待工单 `:217-234`（`status not in ('resolved','closed')`）
  - 同步失败 `:239-254`（`distinct on (mapping_id)` 取最新命令）
  - 运行租户 `:167-176`
  - 对应 pgTAP 只断言「等于夹具里的固定数字」：`ops_overview_domain.sql:648-710`（B5/B8/B9/B10），不是「等于列表 `total`」。
- 还有一处已登记的契约内部矛盾：总览金额**不按合同状态过滤**，而契约 §10 写「仅限 signed/active」，迁移在 `20261031000009_ops_overview.sql:20-25` 明确承认并选择了「与应收列表同一集合」。这是有意识的取舍，但意味着「合同待收金额」与按合同过滤的报表不是同一集合。

结论：**不能宣称「所有指标口径只在一处」**。应收做到了；另外四项是同一函数里的独立实现，没有等值证据。

### 2. 导出保护：**有行数硬上限，没有时间上限；执行挂在读请求上有拖慢风险**

- 行数上限 100000：`udone/supabase/migrations/20261031000013_ops_exports.sql:407`（`max_rows integer := 100000`），超限返回 `too_many_rows`（`:527-530`），API 侧翻成 `ROW_LIMIT_EXCEEDED`（`udone/apps/api/src/modules/ops/exports/runner.ts:150-152`）。
- 权限在执行时按**发起人**重判：`20261031000013_ops_exports.sql:322`、`ops_exports_domain.sql:604-636`（F4：发起人被撤权后 `export_fetch_rows` 返回 `forbidden`）。这条比「创建时校验一次」强。
- 租约 10 分钟 + 过期回收：`20261031000013_ops_exports.sql:338-344`，避免任务卡死在 `running`。
- 每次读请求最多推进 1 条：`udone/apps/api/src/modules/ops/exports/runner.ts:36`（`MAX_RUNS_PER_REQUEST = 1`）。
- **时间上限没有**：整个「取 10 万行 → 在 Worker 里拼 CSV 字符串 → 签名上传」同步跑在一个 `GET /exports` 或 `GET /exports/{id}` 请求里（`runner.ts:20-36,139-173`）。没有任何 wall-clock 超时或分片续跑；10 万行全量进内存（`toCsv` 一次性 join，`runner.ts:76-83`）。
- 团队自己承认了这一点：`udone/.harness/journal/2026-10-31-exports.md:152`「真实规模下的执行耗时未知……懒执行意味着它会挂在某个用户的读请求上」；`:149-151` 还写明 `too_many_rows` 分支从未在真库触发过。

结论：**行数有保护、权限有保护、状态有保护；时间/内存没有保护**。如果单条导出接近 10 万行，症状会是「导出列表页偶发卡顿」，而不是导出失败。

### 3. 审计日志：**是独立表，不是 `updated_at`；但工单域完全没写，部署域没带 requestId**

- 独立表：`udone/supabase/migrations/20261030000003_ops_identity.sql:111-123`（`ops.audit_events`，含 `actor_operator_id / action / entity_type / entity_id / request_id / reason / before_summary / after_summary / created_at`），RLS 开启 `:369`，读取要 `audit.read` 策略 `:456`，写入只经 `ops.write_audit`（`:248`）。
- 覆盖面核对（`grep -c "perform ops.write_audit"`）：

| 迁移 | 审计写入次数 |
|---|---|
| `20261031000008_ops_deployment_domain.sql` | 4（`:341,556,653,758`） |
| `20261031000003_ops_support_tickets.sql` | **0** |
| `20261031000002_ops_billing_receivables.sql` | **0**（收款域 `…0004` 有 9 次） |

- 部署域的 4 次审计**拿不到 requestId**：库函数有 `p_request_id` 参数，但路由一个都没传（`udone/apps/api/src/modules/ops/deployment/routes.ts` 中 `p_request_id` 出现 0 次；对照 accounts 路由 `:209,308,382,428` 都传了）。结果是 `audit_events.request_id = NULL`，请求关联断链。
- 工单域没有任何 `ops.audit_events` 动作码：`udone/packages/contracts/src/ops/audit-actions.ts` 75 个动作码里没有 `ticket.*`。这一条与团队自己的记录一致：`udone/.harness/journal/2026-10-31-support-domain.md:85-87`「业务域审计写入仍然整体缺失。工单域也没写审计……已上卡 `o-audit-write`」。

结论：**表是独立且不可覆盖的，方向对；但「谁改了工单」只存在于工单自己的时间线里，运营审计页查不到。部署域查得到，但点不进请求链路。**

---

## Task 7（6 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 187 | 部署/工单契约与生命周期 API | 已实现 | 契约 `udone/packages/contracts/src/ops/deployment.ts:145-197`、`tickets.ts:183-252`；路由 `udone/apps/api/src/modules/ops/deployment/routes.ts:198,229,285,310,376,426,485`（7 端点）、`tickets/routes.ts:205,242,267,317,346,382,427,479,526,563`（10 端点）；禁凭据白名单 `supabase/migrations/20261031000008_ops_deployment_domain.sql:39-42` + pgTAP `supabase/tests/ops_deployment_domain.sql:1326-1340`；「不自动部署、写端点无 202」`deployment/routes.ts:55-56`；升级记录只靠登记推进 `20261031000008_ops_deployment_domain.sql:676-780` | 无（路由测试 31 例 `deployment/routes.test.ts`、35 例 `tickets/routes.test.ts`） |
| 2 | 188 | 跨客户/历史/重复/审计测试 | 未实现 | 跨客户：`supabase/tests/ops_support_domain.sql:460`（C5 合同跨客户）、`:1178`（R7 工单挂别人实例）、`ops_deployment_domain.sql:426,445`（license/contract customer mismatch）；敏感字段：`ops_identity_rls.sql:389`；工单全状态与重开：`ops_support_domain.sql:554,906,933,943,969`；重复状态命令：`:969`（T18）+ `deployment_domain.sql:628`（version_mismatch） | **「审计失败」这一类测试没有，因为没有审计可失败**：`20261031000003_ops_support_tickets.sql` 全文 0 次 `write_audit`，`ops_support_domain.sql` 全文 0 处 audit 断言 |
| 3 | 189 | 迁移/RLS/审计/API 落地 | 未实现 | 表与时间线：`supabase/migrations/20261031000003_ops_support_tickets.sql:47`（tickets）、`:118`（ticket_events）、`:147`（ticket_references）；部署两表 `20261031000008_ops_deployment_domain.sql:55,111`；RLS `tickets.sql:1205-1211`、`deployment.sql:987-990`；部署审计 `deployment.sql:341,556,653,758`；时间线只由 SECURITY DEFINER 追加、无 UPDATE/DELETE 函数 | **工单的 `ops.audit_events` 写入缺失**（见专项 3），所以「审计」这一子项未落地；部署审计也未带 requestId |
| 4 | 190 | 部署台账与工单页面 | 未实现 | 页面：`admin/apps/web-antd/src/views/ops/deployment/instances.vue`、`detail.vue:477-538`（版本记录/授权/工单三块）、`views/ops/support/list.vue`、`detail.vue:176,217,270`、`components/ticket-timeline.vue`；动作全：`src/api/ops/support/rules.ts:59-97`（assign/start/wait/resume/resolve/close/reopen）；单测 10 个文件（部署 4 + 售后 6） | **① 合同/授权关联建不出来**：建实例表单字段见 `create-instance-modal.vue:34-42`（客户/类型/负责人/版本/日期/环境），**没有 contractId/licenseId**；API 类型 `src/api/ops/deployment/types.ts:168-178` 无 `contractId`，编辑类型 `:190-197` 无 `contractId/licenseId`；详情只能显示 `detail.vue:420` 的「未关联」。后端实际支持这两个字段（`packages/contracts/src/ops/deployment.ts:154-156`）。② 产品筛选是死控件：`instances.vue:277-285`，后端列表函数没有该参数 `20261031000008_ops_deployment_domain.sql:784-791`。③ 未与真后端联调 |
| 5 | 191 | 售后角色字段限制 | 已实现 | 角色映射 `supabase/migrations/20261030000003_ops_identity.sql:783-807`（`support_agent` 无 `customer.sensitive.read`、无任何 `receivable.*`）；pgTAP `supabase/tests/ops_identity_rls.sql:365`（无 receivable 权限）、`:381`（读不到应收）、`:389`（读不到联系方式原值）；掩码由库决定是否有键 `20261030000007_ops_customer_domain.sql:586,853-860`；工单 DTO 直接不含联系方式 `20261031000003_ops_support_tickets.sql:236-275`、契约 `packages/contracts/src/ops/tickets.ts:99-104` | 无 |
| 6 | 192 | Playwright 工单与台账 | 未实现 | 后端正反向权限/RLS 已有（见 188）；前端 e2e 目录只有 6 个文件：`admin/apps/web-antd/e2e/{http/ops-contract.ts,http/permission.e2e.ts,stub/access.e2e.ts,stub/auth.e2e.ts,stub/governance.e2e.ts,support/auth.ts}`，全库搜不到 ticket/deployment 的 spec；且都是桩或 HTTP 回放（`e2e/http/permission.e2e.ts:1-9` 自述「非真实后端集成」） | 工单完整状态流、跨客户拒绝、台账关联三类 Playwright 用例；staging 验收与 traceability 更新 |

---

## Task 8（7 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 198 | 账号/审计/总览/导出契约 | 已实现 | 契约 20 个域文件 `udone/packages/contracts/src/ops/`，其中 `accounts.ts:33-42`（version/mfaRequired 已定稿）、`overview.ts`、`exports.ts`、`audit-actions.ts`（75 个动作码）；路由注册 `udone/packages/contracts/src/routes.ts:1054,1323`；后端不按角色名分支：`grep 'platform_admin/support_agent/finance_ops'` 在 `apps/api/src`、`packages/contracts/src` 只命中 `*.test.ts` | 无（多值参数编码问题记在 190/附录，不属契约缺失） |
| 2 | 199 | 提权/停用/越权/口径测试 | 未实现 | 停用会话：`supabase/tests/ops_identity_rls.sql:288,301`（resolves to no operator / 读 0 行）+ `ops_login_state.sql:149`；导出越权：`ops_exports_domain.sql:618-636`（F4）；口径：`ops_overview_domain.sql:812-838`；部分依赖故障：`:989-991`（D3）；不同权限看总览：`:580-592`、`:881-892` | **「自我提权」没有防护也没有测试**：`ops.create_role`（`supabase/migrations/20261030000005_ops_identity_write.sql:477-519`）只校验权限码是否存在（`:506-510`），不校验「授予集合 ⊆ 调用者已有权限」；持有 `role.manage`+`operator.manage` 的人可以建一个全权角色再分配给自己。唯一的自锁是 `LAST_ADMIN`（`ops_identity_write.sql:444,459`），那是防「把自己降没」，不是防提权 |
| 3 | 200 | 审计/异步导出/聚合/关联 | 未实现 | 账号权限审计：`20261030000005_ops_identity_write.sql:246,422,521,669`；审计查询 RPC `:712`；异步导出（懒执行）`apps/api/src/modules/ops/exports/runner.ts:20-119`；服务端数据范围 `20261031000009_ops_overview.sql:97-176` 按 `has_permission` 逐项判；总览单 RPC 无 N+1 `:78` | **「访问审计」不存在**：`packages/contracts/src/ops/audit-actions.ts` 里没有登录/读取类动作码，`apps/api/src/modules/ops/auth/routes.ts` 全文 0 处 audit；**部署域审计无 requestId**（路由 0 处 `p_request_id`，见专项 3） |
| 4 | 201 | 账号页/审计页/总览/报表/CSV | 未实现 | 账号：`admin/apps/web-antd/src/views/ops/identity-audit/operators.vue`（邀请/停用/角色/权限选择器，`components/permission-picker.vue`）；审计：`audit.vue:57-68`（actor/action/entity/requestId/时间范围）；总览：`overview.vue:195-204,241,277`；导出：`exports.vue:213-226`、`components/export-create-modal.vue:108-116` | **① 报表页整块缺失**：`src/api/ops/` 无 reports 域，`src/router/routes/modules/` 10 个文件无 reports，全 `src/` 搜 `report` 只命中 fixture 文本；后端 4 个报表端点（`reports/routes.ts:130,158,187,213`）在后台无入口。② **导出不继承列表筛选**：导出弹窗要求手填 JSON（`export-create-modal.vue:50,70`），各业务列表页没有导出按钮（`grep createExport views/ops` 除治理页外 0 命中） |
| 5 | 202 | 五项指标与明细同口径 | 需真跑 | 实现：`udone/supabase/migrations/20261031000009_ops_overview.sql:193-254`（权益/工单/同步）、`:167-176`（租户）、`:290-320`（应收）；展示统计时刻/窗口/部分失败：`admin/.../overview.vue:241,248,277`；应收等值已被断言（`ops_overview_domain.sql:812-838`、`ops_reports_domain.sql:525-557`） | 临期权益、开放工单、SaaS 租户、失败同步四项**没有与各自列表端点比对的断言**（现有断言只对夹具常数，`ops_overview_domain.sql:648-710`）；契约声明的 `ops.fn_overview_metrics` 未实现（`admin/Docs/ops-api-contract.md:1093`）。这四项是否逐值相等只能对两端实跑比对才能定论 |
| 6 | 203 | 性能基线 P95 证据 | 未实现 | 无压测脚本：`find` 全仓 `*perf*/*bench*/k6*/*loadtest*` 只命中 `.git/k6.log`（内容仅一行 `ok`）；无查询计划记录；无 Worker/API 时延报告 | 合成规模数据、P95 列表/详情 <800ms、复杂报表 <3s、`EXPLAIN` 计划、时延记录。团队自认耗时未知：`udone/.harness/journal/2026-10-31-exports.md:152`；计划第 241 行也把性能列为未关闭 |
| 7 | 204 | Playwright 与 PRD 追踪 | 未实现 | 仅有的 e2e 是治理四页渲染：`admin/apps/web-antd/e2e/stub/governance.e2e.ts:17-79`（成员表/设置/审计列表/导出列表），且为桩数据；账号停用拒绝、总览下钻筛选、CSV 授权与口径一致均无用例 | 五类 Playwright 场景（停用后写拒绝、角色视图、审计可查、下钻筛选、CSV 授权/口径）；`admin/Docs/PRD.md` 无 R-ID 追踪矩阵（搜 `R-ID/traceability` 只命中计划文件本身） |

---

## 附录：跨端联调会立刻暴露的一个硬伤（不在 13 条内，但影响 190/192/204）

**多值筛选参数名前后端不一致，所有 `status` 多选筛选会被静默忽略。**

- 契约把多值参数写成 `status[]`：`admin/Docs/ops-api-contract.md:538,572,591,595,602,610,615,620,639,649`（§5.5/§5.6/§5.7 正文一致）。
- 前端按契约字面量发送 `status[]` / `priority[]`：`admin/apps/web-antd/src/api/ops/support/endpoints.ts:98-103`、`src/api/ops/deployment/endpoints.ts:78`，另有 billing/entitlement/tenant 共 6 个域同样写法。
- 后端读的是 `status`：`udone/apps/api/src/modules/ops/tickets/routes.ts:180`、`deployment/routes.ts:181`；同写法共 10 个路由文件（contracts/customers/entitlements/exports/receipts/receivables/reports/tenant-integration）。
- Hono 的 `queries(key)` 按名字精确匹配（`hono/dist/utils/url.js` 的 `_getQueryParam`），不会把 `status[]` 归一成 `status`；前端也未配置 `paramsSerializer`（`admin/apps/web-antd/src/api/request.ts:116-121` 的 `new RequestClient` 只传了 baseURL/responseReturn/withCredentials；`packages/effects/request/src/request-client/request-client.ts:15-37` 的 brackets/repeat 开关从未被启用），axios 默认把键名 `status[]` 原样输出。
- **失效是「静默返回全量」，不是 400**：本仓锁定的 Hono `4.13.12` 里，`queries()` 是直接委托、没有独立分支——`udone/node_modules/.pnpm/hono@4.13.12/node_modules/hono/dist/request.js:67-69`（`queries(key) { return getQueryParams(this.url, key); }`），`getQueryParams` 再走 `utils/url.js:193` 的 `return key ? results[key] : results`，键不存在时取到的是 `undefined`。于是 9 个路由的 `if (statuses) raw.status = statuses`（如 `deployment/routes.ts:182`、`receipts/routes.ts:189`）跳过赋值 → zod 的 `status` 可选项为空 → RPC 收到 `p_statuses: null`；exports 例外地写 `?? []`（`exports/routes.ts:208`），RPC 收到空数组。而 SQL 同时把 `null` 与空数组定义成「不筛」：`udone/supabase/migrations/20261031000004_ops_billing_receipts.sql:407-411`、`20261031000006_ops_entitlement_domain.sql:1662/1765/1989`、`20261031000007_ops_tenant_integration_domain.sql:1228`（均为 `p_statuses is null or cardinality(p_statuses)=0 or ...`）。两条路径的终点都是「返回全量」。
- **后端单测抓不到**：测试的 URL 构造器是 `url.searchParams.append(key, item)`，传的键就是裸 `status`（`udone/apps/api/src/modules/ops/tenant-integration/routes.test.ts:191`、`entitlements/routes.test.ts:243-246`）。更典型的是 `entitlements/routes.test.ts:1010` 用例名写着「把 subjectType 与 status[] 传给 RPC」，但实际请求键是 `status`（`:1022`）——**名字是 `status[]`，发出去的是 `status`**。单测绿只证明「后端读 `status` 时是对的」，证不了前端发的是 `status[]`。
- 结果：`GET /deployments?status[]=active` 返回全状态；`GET /tickets?status[]=resolved` 返回全部工单；财务「待审核」队列 `GET /receipts?status[]=recorded` 会显示全部收款。不报错、不告警。

这是「代码都在、单测都绿、一联调就错」的典型形态。**根因在契约正文**：§5.5/§5.6/§5.7 把参数写成 `status[]`，前后端各照一面实现。修复二选一——后端同时接受 `status` 与 `status[]`，或前端改发重复键 `status=a&status=b`——但**必须同一次改掉契约正文**，否则下一个域还会照抄。另需补一条跨端契约测试（发真实查询串、断言筛选真的收窄结果）；再补一条不碰数据库的三行单测钉住 Hono 行为（`new Hono().get('/', c => c.json({ q: c.req.queries('status') }))`，请求 `/?status[]=a`），这样升级 Hono 时也不会把机理读错。

---

## 最值得警惕的三个缺口

1. **工单域零审计**：`ops.audit_events` 里查不到任何工单的分派/解决/关闭/重开，只有工单自己的时间线。售后是最容易产生争议（谁答应过什么、谁关的单）的域，这一块的审计价值最高。团队已上卡 `o-audit-write`，但计划 188/189 不能勾。
2. **导出没有时间上限，且挂在读请求上**：10 万行上限能挡住无限导出，但挡不住「一条 9.9 万行的导出让某个运营的列表页卡住几十秒」。没有超时、没有后台队列、CSV 全量进内存。上线前至少要压一次真实规模。
3. **多值筛选参数名不一致**：不会报错，只会「筛选不生效」。最具体的后果是财务「待审核」队列（`GET /receipts?status[]=recorded`）会把**全部收款**列出来，运营按这个队列审批就会看到已审核/已核销的单子；同理「逾期工单」「逾期应收」都可能显示全量。这条比缺页面更危险，因为它看起来是通的，而且根因在契约正文，下一个域还会照抄。

---

## 附：本次审计未做的验证

- 未启动本地数据库，未执行任何 pgTAP / Vitest / Playwright。
- 未启动 `admin` 或 `udone`，未发起任何 HTTP 请求；「需真跑」的结论仅基于静态阅读。
- 未核对 staging 环境、未检查生产配置、未做 git 操作。
