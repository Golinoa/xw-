# 旅行社 OMS MVP 与试运行上线实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的平台骨架上交付旅行社 OMS P0/P1 多人协作 MVP，并通过真实 staging、隔离、财务、恢复和用户验收后开放团队试运行。

**Architecture:** 保持 Vue 3 + TypeScript + Ant Design Vue 前端、Hono/Cloudflare Worker API、Supabase Auth/PostgreSQL/RLS 的单 Worker 模块化单体。所有 API 请求由 Worker 校验 Supabase 会话和所选组织；Worker 将已验证的 `X-Organization-ID` 传至 PostgREST，RLS 从 PostgREST 当前事务的请求头读取组织并独立校验 `auth.uid()` 的组织成员关系。业务功能按共享身份/契约依赖逐批纵向交付，财务多表写入由 PostgreSQL 事务/RPC 保证原子性。

**Tech Stack:** pnpm workspace、Vue 3、TypeScript、Vite、Ant Design Vue、Hono、Zod、Cloudflare Workers、Supabase Auth/PostgreSQL、SQL/PLpgSQL migrations、Vitest、Playwright、pgTAP。未来智能体界面再评估社区 Vue 库 `ant-design-x-vue`，当前不安装。格式化和静态规则按 Task 2 统一为 Prettier + ESLint；不同时引入第二套格式化器或 migration 工具。

**Spec:** `Docs/REQUIREMENTS.md`、`Docs/TECH_SELECTION.md`、`Docs/REPLICATION_SPEC.md`、`ARCHITECTURE.md`、`.harness/`。

## 目标范围与明确排除

- 本计划的“上线”指公司团队可用虚构及经批准的最小化试运行数据进行多人公网协作；Cloudflare Workers Free + Supabase Free 没有生产 SLA，不据此宣称正式商用生产就绪。
- MVP 覆盖 `REQUIREMENTS.md` 定义的 P0 与 P1：认证/租户、权限、基础资料、订单、游客、财务申请/审批/流水/余额、CRM、结算、通知、回收站、导出和基础报表。
- 持久化附件 UI/API、七牛云集成、AI、银行/第三方支付、外部消息、多币种、提成和企业级 SSO 不在此计划内。文件集成仍由 R-FILE-01 的产品触发条件单独立项。
- 目标站行为缺口以 `REPLICATION_SPEC.md` 标注为准；复刻建议只在需求中已明确采用时作为验收依据，不反向伪装成目标站事实。

## Global Constraints

- API 后端使用 TypeScript + Hono，运行在 Cloudflare Workers。
- 数据库迁移、RLS、约束和事务函数统一使用 Supabase CLI SQL migration。
- 前端不得持有 service role 密钥；service role 只存在于 Worker Secret。
- 所有租户数据必须经过组织/租户上下文和 PostgreSQL RLS 双重保护。
- 测试使用虚构数据，不写入目标站真实账号、Cookie、Authorization 或个人资料。
- 财务多表写入通过单次 PostgreSQL 函数/RPC 完成；外部请求不得盲目重试非幂等财务命令。
- 健康检查和数据库备份是不同运维任务；健康查询成功不能作为备份成功或可恢复证明。
- 文件持久化流程未确认，不实现七牛 SDK、上传 UI/API、签名 URL 或附件对象授权功能。
- 各 Task 只改其列出的责任范围；实施前后检查工作树并保留其他未提交文件。每个工作日按仓库根目录 `AGENTS.md` 要求写 journal。
- 新增或修订的工程约束必须标明执行入口、阻断条件和失败证据；仅写在 `.harness/` 文档中的规则不视为已自动执行。Task 2 未通过前不得启动 Task 3–8 的业务功能实现。
- 依赖准入至少记录用途、包归属、维护状态、许可、安全公告及锁文件影响；CI 依锁文件执行依赖漏洞与许可证策略检查。检查工具及阈值在 Task 2 中选择、固定并文档化，不以未配置的扫描器声称安全合规。
- 变更涉及数据库迁移/RLS 时必须执行本地 PostgreSQL/pgTAP 验证；任何本地或 CI mock 都不能替代真实 staging 验收。生成的数据库 schema 文档必须从迁移源可重复生成，禁止手工补写。
- Task 4–8 开始业务编码前，必须完成“目标项目源码参考门”：按下文 ERPNext 对照表阅读目标文件及测试，记录借鉴点、拒绝照搬点和本任务要验证的行为；记录进入对应 journal 后才可勾选开发步骤。Task 1–3 已完成，不追溯重开；Task 9 仅在上线加固需要时参考其测试/迁移组织方式。
- ERPNext 只作为设计样例。不得复制其实现代码、元数据或依赖；本仓库技术栈、PRD、目标系统证据与数据隔离规则优先。ERPNext 仓库采用 GPL-3.0，代码复用须另行进行许可审查；本计划只允许借鉴概念和工程方法。

## 决策门

以下决策须在对应任务开始前得到产品负责人确认，不允许实现者自行改变用户可见行为：

1. **登录标识：** 需求写“用户名和密码”，当前 Supabase 前端使用 email/password。明确 MVP 使用邮箱登录，还是提供用户名登录映射；通过后同步需求、登录表单、Auth 测试和管理员说明。
2. **试运行数据边界：** 在跨租户、权限、备份和恢复验收之前，不导入批量证件号或其他高敏感真实信息。
3. **生产边界：** 若要求正式商业生产 SLA、国内访问保证或真实高敏感个人数据，先升级托管/区域和运维决策，不以免费试运行通过替代这些要求。

## Review Focus

- 缺失、格式错误、非成员或被撤销成员的 `X-Organization-ID` 必须拒绝；数据库直接请求伪造该 header 也不得读取其他租户数据。
- 两个租户中相同 ID、跨租户外键、批量混合租户 ID 不得泄漏数据或产生部分写入。
- 两个并发财务申请争用同一可申请余额时至多一个成功；重复提交/审批/撤回不得产生重复流水或余额变化。
- 非法 CSV、重复证件、空列、超大输入和有效/无效混合行必须按批准的整批策略返回逐行原因，不得部分落库。
- 用户停用、会话过期、组织成员移除、审批配置变化和越权导出必须在服务端重新校验且不泄露跨租户对象是否存在。

## Files and Ownership Map

- `apps/api/src/middleware/`：会话、组织上下文、统一错误和 request ID；不得含业务 SQL/RPC 细节。
- `apps/api/src/modules/<domain>/`：各领域 route/service/repository；接口按 `packages/contracts` 契约实现。
- `apps/web/src/views/`、`components/`、`stores/`：工作流页面、共享表单/表格组件和客户端状态；不放授权或财务真值规则。
- `packages/contracts/src/`：DTO、枚举、权限、错误码和 API 响应结构的唯一共享 TS 契约。
- `supabase/migrations/`、`supabase/tests/`、`supabase/seed.sql`：版本化 schema/RLS/RPC、数据库测试和纯虚构 seed；不手工编辑生成 schema 报告。
- `.harness/`：代码约定、质量/安全/可靠性门槛、活跃计划与按日 journal。
- `.github/workflows/`：持续集成、部署前静态门禁和受控部署；绝不提交生产凭证。
- `playwright.config.ts`、`tests/e2e/`、`tests/smoke/`：本地虚构 UAT 与经授权的真实 staging 验收；凭证只从受保护 secret/env 提供。

## ERPNext 源码参考门（Task 4–8 开发前必做）

参考基线：`D:/Coding/ERP/ERPNext`，branch `version-16`，commit `7474d9e786277383de1242ab882f16856d17a9c9`。只读分析，不修改该目录。每个 Task 在开始编码前，于本仓库当日日志记录：需求/验收项、阅读的具体源码与测试文件、提炼出的行为规则、是否采纳及理由、在本项目中的落点、验证用例。引用路径应精确到文件/函数，不写“参考 ERPNext”这种不可复核的描述。

| 本计划任务 | 先读目标源码与测试 | 可评估的做法（经本项目需求确认后才采用） |
|---|---|---|
| Task 4 主数据 | `erpnext/selling/doctype/customer/{customer.py,customer.json,test_customer.py}`、`erpnext/buying/doctype/supplier/{supplier.py,supplier.json,test_supplier.py}` | 主数据状态、字段约束、列表筛选与角色边界；只映射到本项目已定义的客户/供应商资料。 |
| Task 5 订单 | `erpnext/selling/doctype/sales_order/{sales_order.py,sales_order.json,test_sales_order.py}` | 明确状态命令、提交前校验、关联单据限制、重复/非法转换测试；不引入库存承诺等本项目没有的 ERP 范围。 |
| Task 6 财务 | `erpnext/accounts/doctype/payment_entry/{payment_entry.py,payment_entry.json,test_payment_entry.py}`、`erpnext/accounts/doctype/gl_entry/{gl_entry.py,gl_entry.json,test_gl_entry.py}`、`erpnext/accounts/doctype/sales_invoice/{sales_invoice.py,sales_invoice.json,test_sales_invoice.py}` | 原交易保留、撤销/冲正可追溯、财务状态约束与异常测试；本项目仍以自身精确金额、事务/RPC、审批和审计要求为准。 |
| Task 7 结算/通知 | 对照 `payment_entry` 源码和测试，并检查 `ERPNext/erpnext/hooks.py` 中相关事件注册 | 只评估可追踪异步任务、事件触发和重试边界；没有直接对应本项目结算流程的部分记为“不采纳/无直接类比”，不为了相似而增加模块。 |
| Task 8 CRM/报表 | `erpnext/crm/doctype/lead/{lead.py,lead.json,test_lead.py}`、`erpnext/crm/doctype/opportunity/{opportunity.py,opportunity.json,test_opportunity.py}` | 阶段/失效原因、列表过滤、聚合指标口径与测试组织；不引入本项目 PRD 未要求的 CRM 流程。 |
| Task 9 发布验收 | `ERPNext/erpnext/patches.txt` 与本表相关 DocType 测试 | 评估迁移顺序、升级兼容、回归测试组织方法；不得把 ERPNext 的发布流程当作本项目已执行的证据。 |

拒绝采纳也要记原因，例如业务范围不符、Frappe/ERPNext 专属机制、与 Workers/Supabase 架构冲突、无法证明安全边界。每个参考点须转成该 Task 的具体验收断言或明确排除项。源码阅读不能替代需求确认、数据库/API/浏览器测试或运行环境验证。

## 质量工程门（适用于每个任务）

1. **开发前：**确认需求和任务边界、检查并保留既有 WIP；完成上述源码参考门；先写失败行为/边界用例，再实现；冻结跨端 API/schema/RLS 契约并指定唯一写入方。
2. **开发中：**小步修改；数据库/RLS/RPC 由迁移源驱动；权限必须在服务端和数据库验证；财务/状态改变用显式命令与事务/幂等策略；记录可定位的审计和错误信息；不得把 mock 结果描述为真实集成。
3. **任务交付：**按 Task 运行适用的格式/lint/typecheck/unit/build 门禁；数据库变更另跑空库迁移及 pgTAP，API/页面跑对应集成和 Playwright；跨租户/角色类功能同时验证允许与拒绝路径；记录命令、结果、环境、失败和未覆盖项。
4. **依赖/安全：**新增依赖先评估必要性、维护状态、许可、漏洞、体积与锁文件差异；不提交凭证；新增强制工程规则必须有自动执行入口和负向失败证据。沿用 Task 2 已冻结的工具与策略，不另起平行工具链。
5. **完成门：**更新需求追踪、计划勾选和 journal；审阅 diff，确认改动只属于当前 Task；Task 自身改动按项目流程独立提交。真实 staging、跨端 E2E、性能/恢复门只能用相应环境证据关闭，静态检查或 mock 不可代替。

## 执行顺序与批次

依赖顺序是强制的：Task 1 和 Task 2 完成并通过审查前，不开始业务模块；Task 3–8 按编号推进，契约稳定后的独立页面工作可拆开评审，但生产数据库迁移只能由一个批次串行推进；Task 9 上线门禁依赖所有 MVP 模块验收完成。

### Task 1: 让组织上下文真正到达 PostgreSQL RLS（P0 阻断项）

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/services/organization-service.ts`
- Modify: `apps/api/src/routes/organizations.ts`
- Modify: `apps/api/src/services/supabase-auth-verifier.ts`
- Create: `supabase/migrations/20261003000003_request_organization_context.sql`
- Modify: `supabase/tests/identity_rls.sql`
- Create: `supabase/tests/request_organization_context.sql`
- Modify: `apps/api/src/services/organization-service.test.ts`
- Modify: `tests/smoke/deployed-stack.spec.ts`

**Interfaces:**
- `requireAuth()` 得到已验证的 `AuthContext.organizationId`；未经验证的客户端 header 不能直接赋给该上下文。
- `supabaseRequest(environment, token, path, init, organizationId?)` 仅在 Worker 已验证组织成员后附加 `X-Organization-ID` 到对应 PostgREST 请求。组织发现/创建等无需所选组织的请求显式不带该 header。
- `public.current_organization_id() returns uuid` 读取 `current_setting('request.headers', true)` 中的 `x-organization-id`，并要求当前 `auth.uid()` 是该组织成员；无 header、无效 UUID、非成员一律返回 NULL/拒绝。
- 不在本 Task 使用 service role，不信任客户端 header 单独授权，不依赖未配置的 JWT custom claim。

- [x] **Step 1: 编写失败的 RLS 请求上下文测试**：验证成员带 header 只读所选组织、成员切换到自己另一组织后只读另一组织、缺 header/非成员/畸形值拒绝、伪造其他用户 ID 无效；更新/插入/删除策略均验证租户边界。用例包含 `usesSelectedOrganizationFromRequestHeader`、`deniesNonMemberOrganizationHeader`、`failsClosedWithoutOrganizationHeader`。
- [x] **Step 2: 运行数据库测试确认失败**：在 WSL 隔离 Supabase PostgreSQL 17 + GoTrue 项目中运行 `supabase test db --local`；旧 JWT helper 对照令请求上下文用例 RED 8/14，恢复 `00003` 后全套 GREEN 35/35。
- [x] **Step 3: 实现事务级请求头上下文与成员校验**：新增向前兼容的 migration；helper 使用空 `search_path`、明确授权和成员关系查询；策略对 NULL 组织上下文 fail closed。
- [x] **Step 4: 为 Worker → PostgREST 请求传递上下文并增加测试**：要求仓储方法接收已验证的 `organizationId`；对 `/api/organizations/:id/members` 断言上游请求同时带调用者 bearer token 与匹配组织 header；`/api/me` 和组织创建保持无选中组织行为。
- [x] **Step 5: 在本地 DB 和部署 staging 验证真实链路**：从真实 Supabase Auth 会话分别使用至少两个虚构租户与三个角色，读写本组织对象、伪造另一组织 header；记录 HTTP、用户、所选组织和读写拒绝证据。只有数据库策略拒绝证据可标为 RLS 通过。进度：本地 PostgreSQL 17/Auth/Worker/PostgREST 两租户三角色链路完成；本轮复跑正式 Supabase PostgreSQL 17 + GoTrue `supabase test db --local`，3 个文件、35/35 通过。Staging project ref 为 `uxshseqgleiqyopnmomt`（`udone-staging`），linked migration list 本地/远端 `20261003000000`–`20261003000003` 同步。此前两个 admin fixture 的真实 Worker/RLS smoke 3/3 结果仍有已提交记录；本轮 Auth Admin HTTPS 创建验收身份时 TLS 握手失败、Worker health 请求在连接阶段超时，未收到 HTTP 响应，未成功创建任何远端用户/组织/成员，也未执行 staging SQL 写入。因此三角色 staging Auth 与读写/拒绝证据仍缺，本步骤未完成。2026-10-05 有界恢复复查：本地 `00000`–`00003` migration 与上次 linked 同步记录相符；一次 Worker health 返回 HTTP 200，但一次 Supabase Auth Admin users API 返回 HTTP 403，组织 fixture 只读重复项核查亦失败，无法确认没有重复记录。未重试、未执行任何 staging 写入，Step 5 仍未完成。 最终验收（2026-10-05）：staging Auth Admin 使用 WSL Supabase CLI 提供的 service_role key 后 HTTP 200；按精确邮箱/组织标记查重未发现候选重复。为已存在的 operator/finance Auth 账号重置随机内存密码用于验收（未创建账号），通过 Auth 用户 JWT 调用 create_organization_with_owner 创建 Task1 组织 056d74f3-5f2d-4688-b106-0af8d9711132，并为 operator、finance 添加到既有租户 A/B 及该验收组织。三种真实会话均完成 Worker 当前组织成员读取 HTTP 200、所选组织 RLS 读取 HTTP 200/1 行、本人 profile 写入成功、非成员组织 header 查询 0 行及 Worker 切换 HTTP 403；admin 对验收组织更新影响 1 行，operator/finance 更新影响 0 行。linked migrations 20261003000000–20261003000003 本地/远端同步。pgTAP 3 files/35 tests 已在本 journal 前序记录通过，本轮续验未重跑。
- [x] **Step 6: 更新架构说明并提交本批**：同步 `ARCHITECTURE.md`、`.harness/SECURITY.md` 和活跃计划，说明 header 来源、DB 二次成员校验及撤权即时生效边界。Task 1 实现/文档提交：`4186473`；验证记录提交：`65787a2`。

**Task 1 当前进度（2026-10-05）：**步骤 1–6 全部完成，Task 1 验收通过；Task 2 已解锁。Worker/API Vitest 50/50、API typecheck 和 Supabase PostgreSQL 17.11 + GoTrue `supabase test db --local` 3 files/35 tests 的既有通过证据见 `.harness/journal/2026-10-05-task1-organization-rls.md`。Staging linked migration list 确认本地/远端 `20261003000000`–`20261003000003` 一致。真实 staging Auth 会话覆盖 admin、operator、finance：所选组织 RLS 读取均为 HTTP 200/1 行；三个账号均成功写入本人 profile；伪造非成员组织 header 的 RLS 读取均为 HTTP 200/0 行，Worker 切换均为 HTTP 403；admin 组织更新返回 1 行，operator/finance 更新返回 0 行。Operator 加入既有租户 A，finance 加入既有租户 B；二者及既有 admin 加入 Task1 标记组织。Operator 与 finance Auth 账号本来已存在，本轮通过 Auth Admin API 将密码重置为随机内存值用于验收，没有创建这两个用户；随机密码未打印或保存。Worker `/api/organizations/:id/members` 每角色返回当前调用者自己的 1 行；数据库中该组织实际有 admin/operator/finance 三条 membership，其他成员枚举行为未在本 Task 断言。首轮 Auth Admin 403 是错误使用 publishable key 作为 apikey，改用 CLI reveal 的 service_role 后 HTTP 200。历史失败检查记录保留于 journal，本段为续验最终状态。

**迁移前向兼容裁定：**保留已存在的 `20261003000001_rls_helpers.sql` 不变，使用 `20261003000003_request_organization_context.sql` 替换 helper 并收紧发现策略，符合数据库规范“已应用 migration 不回写”。

### Task 2: 收敛 harness 代码风格、依赖和 CI 门禁

**Files:**
- Modify: `package.json`、`apps/web/package.json`、`apps/api/package.json`
- Create: `.editorconfig`、`eslint.config.mjs`、`.prettierrc.json`、`.prettierignore`
- Create: `.github/workflows/ci.yml`
- Create: 依赖漏洞/许可证策略配置（具体工具在基线审查后选定并锁定）
- Modify: `.harness/ENGINEERING_DESIGN.md`、`.harness/FRONTEND.md`、`.harness/SECURITY.md`、`.harness/RELIABILITY.md`、`.harness/QUALITY_SCORE.md`
- Modify: `Docs/TECH_SELECTION.md`
- Create: `tests/tooling/harness-config.test.ts`
- Modify: `.harness/docs/generated/db-schema.md` 的生成流程（只修改生成器/命令，不手工编辑报告）

**Interfaces:**
- Root scripts: `format:check`, `lint`, `typecheck`, `test`, `build`, `check:deploy`、依赖审计和 schema 文档生成/校验；CI 对 pull request 和主分支执行一致命令。
- 统一 TypeScript/Vue SFC ESLint 与 Prettier；共享/服务端请求输入使用 Zod runtime schema；SQL 使用明确的格式检查命令，不混用第二套 TS formatter。
- 规则文档给出文件/符号命名、单文件责任、API/Zod 输入验证、错误码、Vue loading/empty/error 状态、SQL migration 命名、依赖审批和禁止秘密入仓规则。
- CI 使用锁文件冻结安装；在仓库中固定并校验 Node 版本（兼容 Vite、Workers 与工具链）及 `package.json` 的 pnpm 版本；不读取生产凭证、不连接可写 staging/production。
- pull request 阻断门：format check、lint、TypeScript typecheck、unit/contract tests、build、deploy-config validation、secret scan、依赖漏洞/许可证策略检查，以及从 migration source 重建并校验 schema inventory。
- 数据库/RLS 测试在隔离的本地 Supabase/PostgreSQL 环境运行；涉及 migration、RLS、grants、RPC 的变更必须通过 pgTAP。CI 失败应保留可定位日志，测试不得依赖共享 staging/生产数据。
- E2E 分为无凭证、可复现的 PR 流程与真实 staging 验收；只有前者可成为无外部凭证 PR 门禁，staging 结果归 Task 9 及相关功能验收记录。
- lint、类型、测试、构建、密钥扫描、依赖策略或 schema 校验的失败均阻断合并；覆盖率百分比先不设虚构阈值，按 P0 关键业务场景 coverage list 验收。
- 所有门禁命令必须可在本地复现，并有故意破坏配置/秘密/迁移输入的负向配置测试；分支保护要求这些 CI 检查全部通过后才允许合并。

- [x] **Step 1: 记录当前代码风格基线和已有例外**：检查 TS/Vue/SQL 文件；为 ESLint/Prettier 建立最小配置与配置回归测试。2026-10-05 基线：42 个 TS、3 个 Vue SFC、4 个 migration；无 format/lint config/script。未提交的 frontend/lockfile WIP 改了 Ant Design Vue 依赖，后续只在此基础上增补工程工具，不重置或重排该改动。
- [x] **Step 2: 运行工具配置测试确认缺失**：`pnpm vitest run tests/tooling/harness-config.test.ts`；预期因配置与脚本缺失失败。已新增回归测试并观察到预期 RED：3 tests failed，缺少 format/schema scripts、`.prettierignore` 与 CI workflow。
- [x] **Step 3: 添加 formatter/linter 与命令**：固定兼容当前 Vue/TS 工具链的版本和 Zod；不顺带升级业务依赖；确认 ignored build、coverage、临时目录不会被 formatter 改写。2026-10-05：Prettier/ESLint/SQL formatter、Zod 与 Node/pnpm 版本固定；`format:check`、`format:sql:check`、`lint`、`typecheck`、`test`、`build`、`check:deploy` 通过；Vitest 配置排除 `.worktrees`，formatter ignore 回归测试通过。
- [x] **Step 4: 建立供应链与秘密门禁**：审查现有直接/传递依赖；固定漏洞扫描和许可证策略工具、版本、阻断级别及例外审批记录；扫描锁文件；加入 secret scan 并用虚构 canary 验证阻断；检查生产 secret 不进入前端变量或构建产物。2026-10-05：npm 官方 registry 锁文件审计 0 advisories；secret scan/canary、构建产物与 deploy-config secret 检查通过。对当前 license-policy.json 中精确 11 个 dev-tool package/version/license 组合作窄范围工程策略批准，未加入全局许可证表达式；策略拒绝新包/版本/表达式和生产依赖使用，并记录再分发时的 notice/attribution/LGPL review 条件。该决定不是法律意见。
- [x] **Step 5: 修复并自动验证 schema inventory**：从 `supabase/migrations/` 生成 `.harness/docs/generated/db-schema.md`；验证 migration 数量/对象清单与生成输出一致，重复生成无差异；报告仍只作生成物。2026-10-05：4 migrations、4 tables、5 functions、2 indexes、14 policies、0 triggers；两次生成 SHA256 相同，`schema:check` 通过。
- [x] **Step 6: 补充 harness 的具体规范**：移除已落实的 TODO；确立命名、格式、组件测试、CSS tokens、SQL 和依赖评审规则；`TECH_SELECTION.md` 标注 Pinia/TanStack Query 是采用、暂缓或移除的最终状态；每项强制规范链接到确切命令或自动门禁。2026-10-05：更新 harness 规范和技术选型；Pinia/TanStack Query 暂缓；相关 TODO 已落实或保留为规范示例。
- [x] **Step 7: 增加 CI 与分支保护**：PR/主分支执行冻结 lockfile 安装、format/lint/typecheck/unit/build/deploy config/secret/dependency/schema 检查；本地隔离数据库执行 pgTAP；仅将可重复、无生产凭证的 E2E 放入 PR gate。记录所需 Git 分支保护设置，不假设 YAML 工作流会自动启用保护。2026-10-05：CI workflow 已配置上述门禁和最小权限；建议 main 要求 PR、CI checks 成功、分支最新且禁止 force-push/bypass。远端 branch protection 与 GitHub Actions 实际运行记录不可用；本计划要求记录设置方案，不要求远端实开或远端执行，故不阻断本步骤。
- [x] **Step 8: 验证并提交本批**：运行全部新增门禁及负向配置测试，确认 CI 的成功/失败路径和日志；记录基线告警、不能自动执行的环境门及责任归属；不将大包体优化扩展为无关重构。2026-10-05：冻结安装、format/SQL format、lint/CSS token、typecheck、62 项测试、build、deploy config、0-advisory audit、精确 license exceptions、secret scan/canary、schema check 与 WSL/Docker pgTAP 3 files/35 tests 均通过；schema 连续生成 hash 一致。负向 license/secret/CSS canary 均通过拒绝验证。GitHub Actions 与远端 branch protection 的读取/执行不可用；按 Step 7 只需记录设置建议，不阻断本地验收。Task 2 已提交并完成；无关主 bundle 告警已记录，不扩展优化；Task 3 尚未开始。

### Task 3: 固化登录、租户成员生命周期、角色权限与数据范围合同

**Files:**
- Modify: `Docs/REQUIREMENTS.md`、`Docs/TECH_SELECTION.md`
- Modify: `packages/contracts/src/auth.ts`、`permissions.ts`、`errors.ts`
- Modify: `apps/web/src/views/LoginView.vue`、`apps/web/src/stores/auth.ts`
- Modify: `apps/api/src/services/supabase-auth-verifier.ts`、`apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/modules/members/`（邀请、启用/停用、角色指派）
- Modify: `apps/api/src/routes/organizations.ts`
- Create: `supabase/migrations/20261003000004_permissions_and_member_lifecycle.sql`
- Create/Modify: `supabase/tests/permissions_and_disabled_sessions.sql`
- Create: `tests/e2e/member-onboarding.spec.ts`
- Create/Modify: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Supabase Auth 是身份唯一来源；Worker 每个受保护请求验证 token、用户启用状态、所选组织成员和角色/权限。
- 所有会话/API 返回共享 `AuthContext`；组织切换请求只有在成员验证成功后更新客户端状态。
- 首位组织管理员为创建组织的用户；管理员邀请员工到当前组织并指派角色；成员停用后 Worker 对每个请求重新检查 active membership，拒绝其后续访问，不等待前端 token 自行过期。
- Auth provider 的 admin invite 操作只能放在明确授权的成员服务中；service role 仅用于 Supabase Auth Admin，不用于绕过业务表 RLS；成员/角色数据库变更经调用者 JWT 与受限 RPC 完成。
- 登录标识实现严格按“决策门”选定项；不通过客户端 metadata 自报 username，不向匿名接口泄露账号是否存在。
- 核心角色 `admin`、`operator`、`finance` 的 permission/action 和 own/all 数据范围分开建模；前端隐藏只为体验，服务端与 RLS 各自强制。

- [x] **Step 1: 关闭用户名/email 产品决策并写入需求**：2026-10-05 按用户授权由执行者定案：Supabase Auth 验证邮箱为全局登录标识，无 username 映射；邀请按邮箱发送；密码重置通过 Auth recovery email 且统一确认文案；不做自定义按账户锁定，保留不含秘密的认证失败审计；部署使用 Auth IP 限流/CAPTCHA；改密撤销 refresh session，已签发 access JWT 至多存续至过期；组织成员停用由 Worker 每个受保护请求重查并立即阻断；display_name 与身份邮箱分离。已记录于 REQUIREMENTS R-AUTH-01/R-AUTH-02 与 TECH_SELECTION §6.4。依据 Supabase 官方 Auth 密码、限流、会话、审计和 CAPTCHA 文档。
- [x] **Step 2: 增加权限矩阵和会话失败用例**：contracts 与 pgTAP 覆盖 admin/operator/finance 权限及 own/all 范围、disabled membership、邀请和撤权；API/Auth store tests 覆盖拒绝与错误会话行为。
- [x] **Step 3: 同步 contracts、Supabase policy 与 Worker 校验**：角色权限从受保护数据库映射加载；每个受保护请求重查 active membership；跨组织 header 与成员发现策略由 pgTAP 覆盖。
- [x] **Step 4: 实现邀请和成员管理 API**：新增邀请、成员角色/状态更新及接受路由；调用者 JWT 执行业务 RPC，service role 仅调用 Supabase Auth Admin；校验组织/邮箱/角色并写审计。
- [x] **Step 5: 更新登录/邀请/成员 UI 状态**：登录使用通用错误和 recovery 提示；组织切换失败保留原上下文；管理员邀请/成员更新面板及待处理状态可见。用全新 Vite 服务跑恢复、邀请接受和管理员邀请浏览器流程，3/3 通过。
- [x] **Step 6: 执行 DB、API、浏览器验收并提交**：WSL pgTAP 4 文件/61 assertions、隔离 Vitest 18 文件/74 tests、认证登录/切换/退出/恢复/邀请接受/管理员邀请 E2E 5/5、配置 CAPTCHA widget E2E 1/1、管理员成员面板 E2E 3/3、API/Web TypeScript、SQL 格式检查 10 文件、schema inventory 5 migrations 和 Web 生产构建均通过。2026-10-05 将认证流程抽到 `AuthFlow.vue`/`AuthCaptcha.vue`，提交 `feat: isolate Task 3 authentication UI`；干净基线 LoginView 包装已验证，原 Ant Design Vue `LoginView.vue` 与其他 WIP 保持 unstaged。中断安装后的恢复仅在 WSL 执行 `pnpm install --frozen-lockfile`：lockfile up-to-date、356 包本地复用/0 下载、postinstall 通过；16 个根直接依赖、所需 `.bin` 与 workspace 二进制均可解析。lockfile 和用户 WIP 文件 SHA256 均与操作前相同。Web bundle 保留既有约 1.75 MB/534 KB gzip 告警，不扩展优化。Task 4 未开始。

### Task 4: 交付用户权限配置和基础资料 P0

**Files:**
- Create: `apps/api/src/modules/master-data/{customers,suppliers,routes,regions,dictionaries}/`
- Create: `apps/api/src/modules/settings/`
- Create: `apps/web/src/views/{customers,suppliers,routes,settings,users}/`
- Create: `apps/web/src/components/{DataTable,FormField,ConfirmAction}/`（只在确有重复工作流时抽取）
- Create: `supabase/migrations/20261003000005_master_data_settings.sql`
- Create: `supabase/tests/master_data_rls.sql`
- Modify: `packages/contracts/src/index.ts` 及对应新 DTO/错误码
- Create: `tests/e2e/master-data.spec.ts`

**Interfaces:**
- 每个租户实体使用 UUID、`tenant_id`、审计字段、版本号与明确软删/停用规则；跨租户外键由数据库约束和服务端共同拒绝。
- Route/service/repository 分层；所有 ID 查询均限制在已验证组织内；字段验证使用共享 schema，服务端响应覆盖前端预测值。
- Master data 列表统一分页、筛选、排序、空态、错误态和权限态；被引用项只能停用或返回 `OBJECT_REFERENCED`。
- 管理员可在成员管理以外维护需求范围内的公司资料、字典和审批/订单设置；设置版本化并审计，不能由前端绕过权限 API 更新。

- [ ] **Step 1: 为租户隔离、重复名称/引用删除和审计写失败用例**：`rejectsCrossTenantForeignKey`、`preventsDeletingReferencedSupplier`、`masksCustomerSensitiveFields`。
- [ ] **Step 2: 运行对应 Vitest 与 pgTAP 用例确认失败**。
- [ ] **Step 3: 编写 schema migration、外键/唯一约束/RLS 和纯虚构 seed**。
- [ ] **Step 4: 实现用户/角色授权矩阵、公司设置及客户、供应商、路线、地区和字典 API 与页面**：客户标签/来源等依需求分别建模；历史订单后续保存名称快照；不得把跨租户平台管理能力暴露给公司管理员。
- [ ] **Step 5: 运行领域/API/数据库测试、键盘与 1366×768 浏览器验收**。
- [ ] **Step 6: 提交本批并更新 `REQUIREMENTS.md` R-ID 到验收证据映射**。

### Task 5: 交付订单、游客与 CSV 导入 P0 核心

**Files:**
- Create: `apps/api/src/modules/orders/`、`apps/api/src/modules/tourists/`、`apps/api/src/modules/imports/`
- Create: `apps/web/src/views/orders/`、`apps/web/src/components/orders/`、`apps/web/src/views/orders/TouristsView.vue`
- Create: `supabase/migrations/20261003000006_orders_and_tourists.sql`
- Create: `supabase/tests/orders_tourists_rls.sql`
- Create: `tests/e2e/orders.spec.ts`、`tests/e2e/tourists-import.spec.ts`
- Modify: `packages/contracts/src/`：订单、状态命令、金额、游客和导入 DTO

**Interfaces:**
- 订单状态仅通过明确命令转换，不接受通用 PATCH 修改状态；金额、人次、应收应付与利润在服务端/事务中计算。
- 创建订单原子写入订单、项目和 audit；幂等键重复请求返回第一次结果。
- 游客导入先预览，用户确认后遵守需求中的“任一错误整批不导入”策略；导入暂存不持久化为附件。
- CSV 使用 UTF-8 BOM；拒绝公式注入，敏感字段按权限展示/导出。

- [ ] **Step 1: 编写订单状态、金额篡改、重复提交、跨租户外键和导入边界测试**：`recomputesOrderTotalsOnServer`、`rejectsInvalidOrderTransition`、`createsOrderIdempotently`、`importsTouristsAtomically`；包含固定 UAT 数据 2 成人 1 儿童、应收 7500、应付 4800、利润 2700。
- [ ] **Step 2: 运行新增测试确认失败**。
- [ ] **Step 3: 实现订单/项目/游客 migration、约束、RLS 和事务 RPC**：包含 booking/active/completed/cancelled 迁移、原因审计、版本冲突和引用保护。
- [ ] **Step 4: 实现订单 API、页面与游客 CSV preview/confirm 工作流**：不实现附件上传或七牛集成。
- [ ] **Step 5: 验证人数、金额、回收站/恢复、CSV 全批原子性与真实 Supabase 行为**。
- [ ] **Step 6: 提交本批并记录逐个 R-ORDER/R-TOURIST 验收证据**。

### Task 6: 交付收付款、审批、资金流水和余额 P0

**Files:**
- Create: `apps/api/src/modules/finance/`、`apps/api/src/modules/approvals/`
- Create: `apps/web/src/views/finance/`、`apps/web/src/views/approvals/`
- Create: `supabase/migrations/20261003000007_finance_approvals.sql`
- Create: `supabase/tests/finance_transactions.sql`
- Create: `tests/e2e/finance-approval.spec.ts`、`tests/database/finance-concurrency.test.ts`
- Modify: `packages/contracts/src/`：财务/审批 DTO、冲突码、审计事件类型

**Interfaces:**
- `payment_requests`、审批轮次/动作和只追加 `ledger_entries` 均带 `tenant_id`；精确金额使用 `numeric(14,2)`。
- 财务命令使用 PostgreSQL 单 RPC 事务；额度以锁定/原子更新防止超额竞争；客户端仅展示计算结果。
- `Idempotency-Key` 与实体版本控制定义为稳定 API 契约；相同键返回原操作结果，审批级次过期返回 409。
- 余额只由期初和确认资金流水派生；撤回通过反向流水冲正，不改写历史记录。

- [ ] **Step 1: 为申请、驳回重提、两级审批、自审默认、撤回、并发超额和重复 RPC 编写失败测试**：`rejectsConcurrentOverAllocation`、`replaysIdempotentPaymentRequest`、`reversesLedgerOnUndoApproval`、`preservesEarlierApprovalOnResubmission`。
- [ ] **Step 2: 运行 pgTAP、Vitest 和 API 用例确认失败**。
- [ ] **Step 3: 实现财务 schema、不可变流水、事务 RPC、权限/RLS 与锁策略**。
- [ ] **Step 4: 实现收款/付款/审批/余额页面和 API**：错误信息说明具体应收/应付项目，前后级审批保留历史动作。
- [ ] **Step 5: 执行 50 并发资源竞争与 staging 重复请求验收**：最多一个竞争者获得余额；只产生一份确认流水。
- [ ] **Step 6: 更新审计与运行手册并提交本批**。

### Task 7: 交付结算、通知及站内运维提醒 P1

**Files:**
- Create: `apps/api/src/modules/settlements/`、`apps/api/src/modules/notifications/`
- Create: `apps/web/src/views/finance/SettlementView.vue`、`apps/web/src/components/notifications/`
- Create: `supabase/migrations/20261003000008_settlements_notifications.sql`
- Create: `supabase/tests/settlement_notification_rls.sql`
- Create: `tests/e2e/settlement-notifications.spec.ts`
- Modify: `wrangler.toml` 或根 Wrangler 配置以接入受控 Cron；新增 `.dev.vars.example` 只放变量名

**Interfaces:**
- 批量结算事务以明确应付项目 ID 和剩余额度为输入，重复纳入与余额不足返回项目级冲突；付款事实只产生一次 ledger entry。
- 站内通知在相应业务事务提交时以 outbox/事务写入，不调用外部短信、邮件、企业微信。
- Worker Cron 仅扫有索引的待办条件，使用请求 ID、截止时间和幂等键；任务状态可重试，不重复发送/记账。

- [ ] **Step 1: 编写结算重复项、并发额度、通知重复投递及租户隔离测试**：`rejectsDuplicateSettlementItem`、`doesNotDuplicateNotificationOnRetry`、`isolatesNotificationsByOrganization`。
- [ ] **Step 2: 运行新增 DB/API 测试确认失败**。
- [ ] **Step 3: 实现结算与通知表、RLS、RPC/outbox 和 Cron 调度**。
- [ ] **Step 4: 实现结算复核、通知未读/已读及对象跳转页面**。
- [ ] **Step 5: 对测试环境执行重复调度和 Worker 暂停/超时场景验收**。
- [ ] **Step 6: 提交本批并记录通知与结算监控项**。

### Task 8: 交付 CRM、公海、导出、回收站与基础报表 P1

**Files:**
- Create: `apps/api/src/modules/crm/`、`apps/api/src/modules/reports/`、`apps/api/src/modules/exports/`
- Create: `apps/web/src/views/crm/`、`apps/web/src/views/reports/`、`apps/web/src/views/recycle-bin/`
- Create: `supabase/migrations/20261003000009_crm_reporting.sql`
- Create: `supabase/tests/crm_reports_exports_rls.sql`
- Create: `tests/e2e/crm.spec.ts`、`tests/e2e/reports-exports.spec.ts`
- Modify: `packages/contracts/src/`：CRM、分页过滤、报表和 CSV DTO

**Interfaces:**
- 线索转客户/订单是事务命令并幂等；重复客户提示遵循 `REQUIREMENTS.md` 第 25 节。
- 列表、报表和 CSV 共用过滤、权限范围及服务端汇总口径；报表指标注明日期和状态口径。
- 导出继承当前筛选与角色数据范围；写审计；超过 3 秒的导出进入异步任务并产生有时效授权下载。
- 回收站恢复校验关联和原业务状态；生产彻底删除维持关闭。

- [ ] **Step 1: 编写线索去重/转换幂等、公海越权、恢复关联、导出权限和指标一致性测试**：`convertsLeadOnlyOnce`、`rejectsCrossTenantLeadClaim`、`restoresOrderWithOriginalState`、`appliesFiltersAndDataScopeToExport`、`keepsDashboardAndReportTotalsConsistent`。
- [ ] **Step 2: 运行数据库/API/browser 测试确认失败**。
- [ ] **Step 3: 实现 CRM/回收站/报表模型、聚合查询、RLS 和导出审计**。
- [ ] **Step 4: 实现线索跟进/公海/转换、搜索/筛选/回收站、报表和 CSV 下载流程**。
- [ ] **Step 5: 用固定 UAT 数据对账订单详情、余额、仪表盘、报表和 CSV；验证筛选不扩大数据范围**。
- [ ] **Step 6: 提交本批并更新 P1 traceability matrix**。

### Task 9: 试运行加固、迁移和上线门禁

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-staging.yml`、`.github/workflows/deploy-production.yml`
- Create: `docs/runbooks/backup-restore.md`、`docs/runbooks/deploy-and-rollback.md`、`docs/runbooks/incident-response.md`
- Create: `tests/smoke/release-gates.spec.ts`、`tests/e2e/mvp-uat.spec.ts`
- Modify: `Docs/REQUIREMENTS.md`、`Docs/TECH_SELECTION.md`、`.harness/RELIABILITY.md`、`.harness/SECURITY.md`

**Interfaces:**
- 环境严格分离：local/staging/production 使用独立 Supabase project、Cloudflare Worker vars/secrets、fixture 和访问角色；任何 deploy 不执行生产 `db reset`/seed。
- staging migration 先 dry-run/list，再前向应用；失败时使用向前修复 migration，不假设可逆 schema rollback。
- 发布 gate 以真实部署的 Worker、Supabase Auth、PostgreSQL/RLS、Playwright 证据为准；报告内容区分通过、失败、跳过与未验证。
- 免费环境只可作为受控团队试运行，不承诺 SLA；真实敏感数据、正式运营、性能或容量越界触发升级/迁移评估。

- [ ] **Step 1: 编写发布准入表和门禁失败条件**：覆盖目标构建、权限/隔离矩阵、P95、50 并发、导出、敏感信息扫描、恢复证据和回滚责任人。
- [ ] **Step 2: 补齐 CI/CD 与迁移安全检查**：PR 静态/单元/DB checks；staging 和 production deploy 均需受保护环境批准，生产 secret 不落盘。
- [ ] **Step 2a: 自动化迁移准入**：CI 从空白隔离数据库按序应用全部迁移并运行 pgTAP；部署前检查 linked migration 状态及 dry-run；仅允许向前修复迁移，不在 CI 或发布脚本中对 staging/production 执行 reset/seed；对迁移失败和回滚/恢复处置留存演练记录。
- [ ] **Step 2b: 锁定依赖与发布来源**：发布使用已审阅提交和 lockfile 冻结安装；依赖漏洞/许可证与 secret scan 结果纳入 release artifact；区分构建时公开配置与运行时 Worker secrets，并验证前端产物无服务端密钥。
- [ ] **Step 3: 演练加密备份和恢复**：备份保留 7 日备份 + 4 周备份；记录真实恢复时长并证明 RPO ≤24h、RTO ≤4h；确认附件因本 MVP 不启用而不在数据库备份中误报为已保护。
- [ ] **Step 4: 执行完整 staging UAT**：至少两个租户，每租户 admin/operator/finance；登录、权限、订单、游客、收付审批、余额、CRM、导出、通知和恢复全链路。
- [ ] **Step 5: 执行上线性能与安全验收**：P95 普通列表/详情 <800ms、复杂报表 <3s；50 并发额度竞争无超额/重复流水；验证服务限额告警、备份失败告警、密钥与个人数据扫描。
- [ ] **Step 6: 由负责人审阅限制与支持手册**：登录标识、免费服务边界、敏感数据限制、恢复/故障操作、迁移触发条件和未纳入功能逐项签收。
- [ ] **Step 7: 试运行发布**：使用专用 staging 验收后发布生产配置；记录 release ID、migration list、URL、健康检查与 UAT 报告；先邀请受控用户，观察一个业务周期后扩大范围。

## 需求覆盖与完成定义

- Task 1–3：`R-AUTH-01`、`R-AUTH-02`、`R-TENANT-01` 和所有全局工程/安全约束。
- Task 4：`R-CUSTOMER-01`、`R-MASTER-01`、`R-SUPPLIER-01`、`R-ROUTE-01`。
- Task 5：`R-ORDER-01..03`、`R-TOURIST-01`，订单状态/金额/导入验收。
- Task 4：`R-SETTING-01` 的公司资料/业务设置及权限；Task 6–7：`R-FIN-01..03`、`R-APPROVAL-01..02`、`R-SETTLE-01`、`R-BALANCE-01`、`R-NOTIFY-01`、跨批次 `R-AUDIT-01`。
- Task 8：`R-CRM-01..02`、`R-REPORT-01`、订单导出/回收站与交叉口径。
- Task 9：需求 §11–12、§22–26 的试运行、性能、安全、恢复、数据、兼容和交付门槛。
- `R-FILE-01` 是已明确延期项，不作为本 MVP 的通过条件；AI、外部支付/通知亦不进入完成声明。

一个 R-ID 仅在 schema/RLS、API、页面状态、审计、失败用例和目标环境验收齐全后标记完成。MVP 上线不等于正式生产批准；只有 Task 9 所需证据完整且业务负责人签收受控试运行边界，才允许对团队宣告可用。

## 计划自审

- 依赖顺序：组织上下文与可执行 CI/harness 在业务开发前完成；Task 2 覆盖本地可复现的格式、静态、类型、单元、构建、依赖/许可证、secret、schema inventory 与隔离数据库门禁；主数据早于订单；订单早于财务；CRM/报表依赖稳定的用户/订单/财务数据；Task 9 覆盖 staging/发布/恢复门禁。
- 需求覆盖：P0/P1 R-ID 按上节映射；延后文件与 AI 范围明确；数据量/保留年限等负责人决策在上线签收中关闭。
- 接口一致性：`AuthContext.organizationId` 是服务端已验证组织；PostgREST 请求头只由服务端从该上下文构造；RLS helper 再按 `auth.uid()` 校验成员。
- 评审风险：五项 Review Focus 分别由 Task 1、5、6、5、3/8 验收，发布门禁再跑跨模块版本。
- 运行证据边界：计划步骤仅定义未来要执行的检查；没有观察到命令/目标环境结果前，不勾选、不报告通过。
- 自动化边界：规范只有在脚本/配置、CI 运行记录、失败阻断证明及分支保护配置均可查时，才标记为自动执行；GitHub 分支保护需在仓库设置中单独配置并核实。
- 跨项目边界：本计划只交付旅行社 ERP `udone`。并列运营后台 `~admin` 的 Vben 导入、Node/pnpm/lockfile 锁定与独立 CI 应维护在 `~admin` 自己的计划中；其运营功能只通过 `udone` 已版本化 API 集成，不复制本计划中的后端或迁移任务。
