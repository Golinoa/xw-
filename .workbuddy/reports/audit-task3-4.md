# Task 3 + Task 4 完成度审计

审计对象：`admin/.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` 的 Task 3（124–132 行，9 条）与 Task 4（140–147 行，8 条），共 17 条。
审计方式：只读源码、迁移、pgTAP、集成测试与 journal，未执行任何命令级测试。

## 结论速览

| 判定 | 条数 |
|---|---|
| 已实现 | 14 |
| 已实现无测试 | 0 |
| 未实现 | 2 |
| 需真跑 | 1 |

> 注：第 145 条按主体功能（分页/排序/状态/快照）记为「已实现」，但其「服务端多选筛选」一半存在前后端参数名不一致的实质缺陷，见文末附录；若按严格口径，这一半应视为未完成。

一句话结论：Task 3 的前 8 条与 Task 4 的前 6 条在两端都已有真实代码与测试落点；真正缺的不是「页面代码」，而是 **staging 联调（132）**、**Task 4 的浏览器端到端（146）** 和 **PRD R-ID 追踪（147）**。计划里 T3/T4 全未勾选，主要是被这三项与「未联调」这个总前提卡住，不是代码空白。

## Task 3（9 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 124 | 运营成员/权限/会话契约设计 | 已实现 | `udone/packages/contracts/src/ops/identity.ts:16-37`（opsContext + 两个 403 reason）；`udone/packages/contracts/src/ops/session.ts:14-45`（/session、/meta、/permissions 响应）；`admin/Docs/ops-api-contract.md:403-497`（§3.9 身份域、§4 权限目录）；`udone/supabase/migrations/20261030000003_ops_identity.sql:35-120`（operators/roles/permissions/role_permissions/operator_roles/audit_events 六表）；独立性证据 `udone/supabase/tests/ops_cross_domain_denials.sql:414-475`（租户成员读不到任何 ops 行） | 权限动作码存在三处手工同步：DB seed、`apps/api/src/modules/ops/*/routes.ts` 里的字符串字面量、`admin/apps/web-antd/src/constants/permissions.ts`。注释自称「后端 pgTAP 与前端单测双重对账」，但前端没有任何 39 码对账测试（`grep OPS_PERMISSION` 于 `*.test.ts` 仅见使用，无计数/对账断言）。另：机器可读 schema 确实在 udone（合格），但人工契约与后端回执（`admin/Docs/ops-api-contract.md`、`admin/Docs/ops-backend-handoff.md`）都放在 admin 仓，与计划「udone 为唯一真源」的边界相反，两仓无法独立校验文档版本 |
| 2 | 125 | 最小身份切片与三类拒绝 | 已实现 | `udone/apps/api/src/middleware/ops-auth.ts:60-133`（调 `get_current_ops_context()`，不看令牌自述）、`:326-349`（无令牌 401 / 非有效成员 403）；`20261030000003_ops_identity.sql:176-220`（RPC 的 `status='active'` 过滤）；拒绝路径 pgTAP `udone/supabase/tests/ops_identity_rls.sql:149`（anon 无 USAGE）、`:183`（租户成员零行）、`:288-301`（disabled 零行）；真实栈集成 `udone/tests/integration/ops-identity.test.ts:33-56`（租户成员 403） | — |
| 3 | 126 | 身份集成/pgTAP + 高风险审计 | 已实现 | `udone/supabase/tests/ops_identity_rls.sql`（705 行，含 39 码 seed 对账 `:509-519`）；`udone/supabase/tests/ops_identity_write.sql`；写路径审计 `20261030000005_ops_identity_write.sql:240-260`（operator.invited）、`:422`（update）、`:521`（role.created）、`:669`；实跑记录 `udone/.harness/journal/2026-10-31-cross-domain-denials.md:19`（37 迁移 / 29 个 pgTAP / 1230 断言）、`2026-10-30-p1-first-four-units.md:63`（db:local:verify 通过）；集成 21 文件（`udone/tests/integration/`） | 邀请失败时对 GoTrue 的补偿删除只有单测证据，缺真实 Supabase 项目验收（udone journal `2026-10-30-ops-identity-alignment.md:52-53` 自述） |
| 4 | 127 | API adapter/环境校验/认证/requestId | 已实现 | `admin/apps/web-antd/src/api/request.ts:116-160`（拦截器链：内存 token、X-Request-Id、body 直出、401 单飞刷新、5xx 退避、错误映射）；`src/api/adapter/env.ts:241-292`（启动即校验，生产禁 mock/禁密钥）；`src/api/adapter/request-id.ts:7-60`；`src/api/__tests__/request.test.ts:125-404`（13 例，含 requestId 复用、401 单飞、403 reason 区分）；`src/api/__tests__/env.test.ts`；前端无 Supabase SDK（`grep -i supabase` 仅命中文档与密钥扫描测试） | 客户端是手写 TS 类型，不是由后端契约生成；两端 schema 漂移只能靠人工与 `contract-version` MAJOR 门兜底 |
| 5 | 128 | demo 登录换真实认证流程 | 已实现 | `admin/apps/web-antd/src/views/_core/authentication/login.vue:28-33`（无注册/验证码/二维码/找回密码）、`:63-97`；`src/store/auth.ts:108-207`（认证状态机，覆盖 contract_mismatch / no_membership / disabled / network_error / no_permission）、`:216-239`（登出清动态路由）；后端 `udone/apps/api/src/modules/ops/auth/routes.ts:74-149`（GoTrue 换令牌→成员判定→激活→lastLogin→发 refresh cookie）；`src/store/__tests__/auth-session.test.ts:163-391`（12 例） | 未与真实后端跑过（见 132），所有状态分类目前只由 mock/单测证明 |
| 6 | 129 | 角色权限驱动 route/menu/action | 已实现 | `src/router/guard.ts:79-155`（只取 accessCodes、不读 roles）；`src/router/access.ts:39-70`（authority=动作码，无权路由不注册→直达 404）；`src/views/ops/_shared/use-ops-permission.ts:17-40`；使用面 31 个页面文件；测试 `src/router/__tests__/menu-from-access-codes.test.ts:34-72`、`route-authority.test.ts:31-63`、`unauthorized-404.test.ts`、`guard-access-codes.test.ts:45-65` | 未使用 Vben `v-access:code` 指令，按钮级控制统一走 composable（功能等价）；菜单与动作的「服务端也拒绝」由后端 pgTAP/路由测试另行证明，不在前端证据内 |
| 7 | 130 | 全局运营壳/用户态/拒绝页 | 已实现 | `admin/apps/web-antd/src/layouts/basic.vue:80-104`（BasicLayout + UserDropdown + 登录过期弹窗 + 锁屏）；`src/views/_core/fallback/forbidden.vue:10-25`（403）、`src/views/_core/fallback/not-found.vue:17-20`（404，文案 `src/locales/langs/zh-CN/ops-shell.json:61`「可能是当前账号没有该页面权限」）；`src/views/ops/customer/list.vue:52,309`（业务页权限拒绝态）；e2e 间接覆盖 `apps/web-antd/e2e/stub/auth.e2e.ts:77-86`（登出/用户菜单） | 壳层无独立组件测试；「服从 DESIGN.md」无自动化或评审证据，只能人工走查 |
| 8 | 131 | Playwright 登录/守卫/菜单/登出 | 已实现 | `apps/web-antd/e2e/stub/auth.e2e.ts:19-87`（登录允许、凭据拒绝、未登录重定向带 redirect、登出清理）；`e2e/stub/access.e2e.ts:12-37`（有 customer.read 时菜单可见、页面可进）；`e2e/http/permission.e2e.ts:20-45`（部分权限：客户可见、账款不可见、直达 URL 落 404）；执行记录 `admin/.harness/journal/2026-10-29-test-infra-ci.md:16`（6 例执行通过，此前 0 次执行）；后端授权由 pgTAP 证明 | 浏览器侧全部是契约桩/HTTP 回放，`e2e/http/ops-contract.ts:9` 明写「不校验鉴权、RLS、幂等与事务」；真实后端下的三类拒绝路径未在浏览器验证 |
| 9 | 132 | 真实 staging 联调与脱敏证据 | 需真跑 | 未找到。无 `.env.staging`（`find admin -name .env.staging` 为空）；`admin/.harness/journal/2026-10-30-contract-finalization.md:105` 把 `a-integrate / a-accept` 列为等 staging 的阻塞项；`udone/wrangler.toml:23-27` 有 staging worker 名但无 ALLOWED_ORIGINS 实际值；CORS 代码在 `udone/apps/api/src/middleware/cors.ts:57-70` | staging Auth/API 实跑、脱敏请求证据、CORS allowlist 实际配置、API client 联调后修订、权限规范同步全部缺失 |

## Task 4（8 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 140 | PRD→客户/产品/套餐/合同字段 | 已实现 | 后端机器可读真源 `udone/packages/contracts/src/ops/customers.ts:67-204`（客户/联系人/create）、`catalog.ts:208-348`（功能键、套餐、价格版本输入）、`contracts.ts:176-202`（合同主体+`renewedFromContractId`）、`:241-292`（变更单/附件/影响摘要）；人工契约 `admin/Docs/ops-api-contract.md:182-247`（§3.1–§3.3）；域规格 `udone/Docs/superpowers/specs/2026-10-31-catalog-domain.md`、`2026-10-31-contract-domain.md`；客户拆字段过程见 `udone/.harness/journal/2026-10-30-ops-customer-s2-s3.md:4-12` | 客户域没有独立 spec 文件（只有 journal + 契约包）；「未知字段不得猜造」靠 journal 记录，无检查项 |
| 2 | 141 | 唯一性/改价/更正失败测试 | 已实现 | 客户编号唯一 `udone/supabase/tests/ops_customer_domain.sql:1081`；重名提示（不阻断）`:370-447`；合同编号唯一 `ops_contract_domain.sql:2734-2745`（23505）；已生效合同不可改 `:1642-1661`；变更单 apply 追加第二版快照且版本号前进 `:1957-1985`；价格版本只 INSERT `udone/supabase/migrations/20261030000009_ops_catalog_domain.sql:19,87-102` | 「目录改价→旧合同金额/快照不变」没有显式跨域断言，只由「合同条目存 unit_price/item_name_snapshot」+「价格版本只追加」间接保证；建议补一条 catalog→contract 的回归断言 |
| 3 | 142 | 迁移/RLS/事务/审计/敏感字段 | 已实现 | `udone/supabase/migrations/20261030000007_ops_customer_domain.sql:38-86`（customers/contacts）、`:1166-1169`（RLS enable）、`:586-598`（`customer.sensitive.read` 决定原值键是否存在）；`20261030000009_ops_catalog_domain.sql:87-102`；`20261030000010_ops_contract_domain.sql:2328-2341`（五表 RLS）、`:418`（金额统一 SQL 重算）、`:1858-1975`（续约 RPC + 审计）；跨域拒绝 `udone/supabase/tests/ops_cross_domain_denials.sql:829-858` | 合同/目录/客户各表只 `ENABLE ROW LEVEL SECURITY`、零 policy（全仓 `CREATE POLICY` 只在 `20261030000003_ops_identity.sql:374-456` 出现 6 条，其余 ops 迁移为 0），直接表访问对 authenticated 全拒、全部走 SECURITY DEFINER RPC。这使 RLS 实际是「整表拒绝」而非计划第 19 行所说的「行级第二层隔离」；决定本身合理，但迁移与契约都没写明这条口径 |
| 4 | 143 | 端点契约与「生效不走 PATCH」 | 已实现 | `udone/packages/contracts/src/routes.ts:945-1010`（合同 list/create/transition/amendment/renewal/attachment 均登记）；`udone/apps/api/src/modules/ops/contracts/routes.ts:410-455`（PATCH 对已签署/生效返回 409 `CONTRACT_IMMUTABLE`）、`:470-520`（`POST /transition`，sign/activate/terminate/expire 归 `contract.approve`）；客户对应 `apps/api/src/modules/ops/customers/routes.ts` + 38 条单测（journal `2026-10-30-ops-customer-s2-s3.md:14-15`） | — |
| 5 | 144 | admin 客户/产品/合同页面 + 影响摘要 | 已实现 | `admin/apps/web-antd/src/views/ops/customer/list.vue:52-182`（列表+创建抽屉+停用影响预取）、`customer/detail.vue:448-449`（联系人表）、`catalog/products.vue:369`（产品表单）、`catalog/plans.vue`、`catalog/plan-detail.vue:44,374`（价格版本历史面板）、`catalog/features.vue`、`contract/list.vue:32,166`、`contract/create.vue:7-8`（草稿→提交→签署→生效）、`contract/detail.vue:167-323`（transition/renewal）、`contract/components/high-risk-confirm.vue:51-64`（原因+勾选双条件）；测试 `views/ops/contract/__tests__/high-risk-confirm.test.ts:62-125`、`high-risk-flow.test.ts:87-102`、`customer/__tests__/customer-form.test.ts:35-83` | — |
| 6 | 145 | 服务端分页筛选/五态/快照 | 已实现 | `views/ops/customer/list.vue:72`（pageSize）、`:128-139`（loading/error）、`:179-182`（服务端分页器）、`:309`（权限拒绝态）；`contract/list.vue:6,54-61`（分页/空/错误/403/409 口径）；`catalog/plan-detail.vue:6,374`（价格版本只读+追加）；`views/ops/catalog/__tests__/price-version-panel.test.ts:59-102`（当前版本 vs 历史快照、无写权限无入口）；`views/ops/contract/__tests__/amount-format.test.ts:21`（价格版本标签）；后端快照 `ops_contract_domain.sql:1576-1603` | **多选 status 筛选实际不生效（缺陷，非仅测试缺口）**：admin 以数组发 `status[]`，后端 `queries('status')` 精确匹配读不到，schema 非 strict 把它静默丢弃 → 返回全量。详见文末附录。另有：列表 loading/empty/error/permission-denied/conflict 五态无组件测试；「改价后浏览旧合同」无前端断言 |
| 7 | 146 | Vitest/组件 + Playwright + staging | 未实现 | 已有的部分：`customer/__tests__/customer-form.test.ts`、`contact-masking.test.ts`、`contract/__tests__/high-risk-confirm.test.ts`、`high-risk-flow.test.ts`、`catalog/__tests__/*`；仓库里没有客户/合同链路的 e2e：`admin/apps/web-antd/e2e/` 仅 `stub/{auth,access,governance}.e2e.ts` 与 `http/permission.e2e.ts`；`admin/.harness/journal/2026-10-29-task4-customer-contract.md:70` 明写状态机与冲突只在本地桩验证 | 缺 4 条 Playwright 链路：客户创建→合同草拟、重复合同编号拒绝、改价后的历史价格/权益快照、权限拒绝；且 staging 前后端+数据库证据全缺 |
| 8 | 147 | PRD R-ID 追踪 + 阶段 journal | 未实现 | journal 已完成：`admin/.harness/journal/2026-10-29-task4-customer-contract.md`（含验证命令与 171 条单测）；PRD 侧不存在 R-ID 体系：`admin/Docs/PRD.md` 全文只有章节号（`grep -E "R-[0-9]"` 无命中），无「R-ID → 实现/验收」表 | R-ID 本身未建立，Task 4 无法按计划要求挂实现/验收链接；Task 3–8 的 traceability 都受同一问题影响 |

## 最值得警惕的 5 处缺口

1. **Task 3/4 从未和真后端连过（132 + 146）。** admin 默认 `VITE_OPS_MOCK=false`，代码路径是真实 HTTP；但所有前端验证都停在契约桩/HTTP 回放（`e2e/http/ops-contract.ts:9` 自述不校验鉴权、RLS、幂等、事务），后端 120 端点的真实契约一致性没有一次跨仓实跑。
2. **Task 4 的浏览器验收是空的（146）。** 计划要求的「客户创建→合同草拟、重复编号拒绝、历史快照、权限拒绝」四条 Playwright 用例在仓库里不存在；现有 e2e 只有登录、权限菜单、治理页。
3. **R-ID 追踪体系不存在（147）。** PRD 没有任何 R-ID 编号，Task 4 的「更新 PRD R-ID 到实现/验收链接」无法执行；这条会连带卡住 Task 9 的发布准入表（计划 210 行）。
4. **权限码三处手工同步、无自动对账（124）。** DB seed 39 码、后端路由字面量、前端 `constants/permissions.ts` 各存一份；注释声称有前端单测对账，实际没有。新增/改名动作码时前端可能拿到后端不认的码。
5. **业务表 RLS 只有「整表拒绝」，没有行级策略（142）。** 全仓 `CREATE POLICY` 仅出现在身份迁移（6 条），客户/目录/合同/账款等业务表只有 `ENABLE ROW LEVEL SECURITY` + SECURITY DEFINER RPC。安全上可接受（默认拒绝），但与计划「RLS 提供第二层行级隔离」的表述不符，且后续任何人补一条宽 policy 就会静默改变隔离强度，现有 pgTAP 未必拦得住。
6. **多选筛选参数名前后端不一致，筛选静默失效（145，影响全部列表域）。** 详见下方附录；它正好解释了「为什么本地看起来都对」——mock 分支直接读数组，绕过了序列化。

## 附录：多选 status 筛选的参数名缺陷（2026-11-16 复核，general-purpose-3 提供线索）

结论：admin 发 `?status[]=a&status[]=b`，udone 读 `queries('status')`，Hono 精确匹配键名、不归一括号，因此后端拿不到值；查询 schema 是普通 `z.object`，未知键被 strip，不报 400，最终返回未筛选的全量列表。**不报错、只在数据上错**，与「没联调」这一总前提完全吻合。

证据链（逐段可核）：

| 环节 | 证据 |
|---|---|
| admin 用数组表达多选 | `admin/apps/web-antd/src/api/ops/customer/index.ts:88`（`status?: CustomerStatus[]`）、`:294-296`（`params: query` 原样透传）；`api/ops/contract/index.ts:92,336`；`api/ops/support/endpoints.ts:98-103` 甚至显式写 ``params['status[]']`` / ``params['priority[]']`` |
| axios 1.20 默认序列化成 `key[]=` | `admin/node_modules/.pnpm/axios@1.20.0/node_modules/axios/lib/helpers/toFormData.js:213`（`key = removeBrackets(key)`）、`:223`（`key + '[]'`）；admin 的 `RequestClient` 未设置 `paramsSerializer`（`admin/apps/web-antd/src/api/request.ts:116-121`，上游默认见 `admin/packages/effects/request/src/request-client/request-client.ts:70-72`） |
| Hono 按键名精确取多值 | `udone/node_modules/.pnpm/hono@4.13.12/node_modules/hono/dist/utils/url.js:188-193`（以原始 `name` 为键聚合，`results[key]` 精确取值）；`request.js:67-69` |
| 后端只读 `status` | `udone/apps/api/src/modules/ops/customers/routes.ts:159`、`contracts/routes.ts:159`、`tickets/routes.ts:180`、`deployment/routes.ts:181`、`entitlements/routes.ts:202`、`tenant-integration/routes.ts:169` 等 10 处（`grep queries('status')`） |
| 未知键被静默丢弃 | `udone/packages/contracts/src/pagination.ts:40-47`（`z.object`，非 strict），客户/合同查询 schema 在其上 `extend`（`ops/customers.ts:307-313`）→ `status[]` 不触发 400 |
| 为何本地没暴露 | `customer/index.ts:290-293`、`contract/index.ts` 的 `VITE_OPS_MOCK` 分支直接把 query 对象交给 mock，mock 读 `query.status` 数组（`contract/mock.ts:221`），跳过了 HTTP 序列化 |

影响面：`status`/`priority` 多选筛选在 customer、contract、billing、entitlement、tenant、deployment、support 七个域都受影响；Task 4 的「客户/合同列表按状态筛选」在真实后端下不成立。分页（`page`/`pageSize`）与排序（`sort`/`order`）是标量参数，不受影响。

两条断言式修复方向（供实施方取舍，不在本次审计范围）：前端统一 `paramsSerializer: 'repeat'` 或后端同时读 `queries('status[]')` 并做归一；无论选哪条，都应补一条「发送真实 query 串 → 后端解析出数组」的契约测试，而不是只测 mock 分支。

