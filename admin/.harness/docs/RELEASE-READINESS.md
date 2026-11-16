# 运营后台发布准入表

- 生成日期：2026-11-16
- 骨架来源：`admin/.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` **Task 9 第 1–9 条**（第 210–218 行）
- 上游需求编号：本表引用的 `R-xx-yy` 全部来自 [`REQUIREMENT-TRACE.md`](./REQUIREMENT-TRACE.md)（99 条，2026-11-16 建立）
- 验收出口：PRD §11.1（12 条核心流程）、§11.2（首期完成定义，PRD:388–394）

> **本表只做一件事：说清楚「现在能不能发」。** 因此每条都落到「具体文件 / 具体命令 / 具体缺什么」。凡是本地无法取证的，一律标 `需环境`，不拿「本地跑过」冒充「环境验过」。

## 0. 状态与责任口径

| 字段 | 取值 |
| --- | --- |
| 状态 | `就绪`（证据齐全且可复核）/ `缺证据`（能力在，证据不在）/ `需环境`（必须有 staging 或组织动作） |
| 责任 | `admin 前端` / `udone 后端` / `发布协调` / `业务负责人`（对应计划第 208 行：前端归 `~admin`，Worker/迁移/后端发布归 `udone`） |
| 证据 | 必须是仓库内路径、可执行命令或平台侧记录；不接受「已实现」这种无指向描述 |

## 1. 发布准入表（9 项）

| # | 准入项 | 证据类型 | 当前证据 | 状态 | 责任 | 阻塞原因 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 建立发布准入表，把 PRD §11.2 与 P0 R-ID 映射到页面/API/迁移/RLS/审计/测试/环境 | 文档 | 本文件 + `REQUIREMENT-TRACE.md`（99 条 R-ID，87 有测试 / 5 无测试 / 3 未实现 / 4 需环境）；逐域落点已到 `文件:行` | 就绪 | 发布协调 | 无。但它是活文档：Task 3–8 每批次关闭时须同步更新，否则第二天就过期 |
| 2 | 干净 checkout 跑完 Vben frozen install、format/lint/typecheck/tests/build、dependency/license/secret scan；确认分支保护已启用 | CI 运行记录 | 本地 11 步已绿：仓库根 `.workflow/frontend-quality.yml`（Gitee Go 只读仓库根 `.workflow/`，不是 `admin/.workflow/`）（Node 24.20.0 / pnpm 10.33.4，`pnpm run quality:check`）；依赖门 `admin/scripts/quality/check-deps-audit.mjs` 白名单 critical 0 / high 2（`node-forge`、`braces`，到期 2027-01-28，退出码 0）；同一流程另有 `admin/.github/workflows/frontend-quality.yml` 作为 GitHub 侧资产 | 缺证据 | admin 前端 | ① 缺 **Gitee 网页侧执行记录**——本地绿不等于流水线跑过；② `Frontend Quality / frontend-quality` required check 未在托管平台启用/验证；③ 本轮 `admin` 依赖正在重装，本次未复跑 `quality:check`；④ 上述结果取自工作树，未从**干净 checkout** 复现 |
| 3 | 空隔离 Supabase 重放全量 migration 并跑 pgTAP；验证 `ops` grants/RLS 对匿名、普通租户、失效运营员、未授权角色均拒绝，授权角色允许 | 迁移 + pgTAP | 45 个迁移 / 37 个 pgTAP 全绿（`cd udone && pnpm db:local:verify`，即 `node scripts/db/local-db.mjs verify`）；反向拒绝：`supabase/tests/ops_cross_domain_denials.sql`、`tests/integration/ops-denials.test.ts:93`（401）、`:132`（403）；正向允许：各 `ops_*_domain.sql` | 缺证据 | udone 后端 | ① 本地验证 ≠ **空隔离 Supabase 项目**重放；② 计划第 241 行记录的「空库重放发现迁移版本重复」需在空库再验一次（当前 45 个文件名前缀无重复，疑似已修，但未复跑）；③ 未记录 `ops` schema 的 grants 显式清单核对结果 |
| 4 | 前端 API contract 生成结果与 `udone` 权威契约做差异检查；版本不兼容时前端安全失败，不回退 mock 或直连库 | 契约测试 | 唯一契约源：`udone/packages/contracts/src/routes.ts`（1480 行，`OPS_ROUTES` 自 696 行起）；后端侧 `apps/api/src/contracts/route-parity.test.ts`（前缀 `/api/v1/ops`、重复键检查）；前端侧 `admin/apps/web-antd/src/api/__tests__/stub-contract.test.ts`、`api/__tests__/request.test.ts` | 就绪 | 发布协调 | 无硬阻塞。软缺口：缺一条「契约版本不兼容 → 前端明确失败」的负向用例（当前只做路由/形状对账） |
| 5 | 部署 staging 前核对环境名、API URL、CORS、Auth、Supabase project ref、pending migration、secrets 名称；先迁移/发 Worker，再发兼容前端 | 环境记录 | **staging 未搭建**。仓库内可见的只有 `udone/wrangler.toml` 的 `[env.staging]`（第 24–31 行）与 `[env.production]`（第 33–40 行）；**二者均未设置 `ALLOWED_ORIGINS`**，而 `apps/api/src/middleware/cors.ts:37` 明确「未配置即拒绝所有跨域」——运营前端是独立部署域，按现状会被 CORS 拦死 | 需环境 | 发布协调 | 环境四件套（project ref / API URL / Auth 回调 / ALLOWED_ORIGINS）与 secrets 清单全部为空；顺序演练未开始 |
| 6 | 用 ≥2 个虚构客户/租户和全部首期角色跑 UAT：客户→合同、分次收款/核销/退款、授权审批与 SaaS 开通/重试、部署台账、售后、审计、总览/导出 | UAT 记录 | 无 UAT 记录。前端 e2e 仅 4 个 spec：`e2e/stub/auth.e2e.ts`、`e2e/stub/access.e2e.ts`、`e2e/stub/governance.e2e.ts`、`e2e/http/permission.e2e.ts`——覆盖登录/守卫/菜单/治理，**没有任何业务流程 e2e**（客户→合同、账款、权益、租户、工单均无 Playwright） | 需环境 | 业务负责人 + admin 前端 | ① 无 staging；② 业务流程 e2e 缺失——计划 Task 4 第 7 条、Task 5 第 6 条、Task 6 第 7 条、Task 7 第 6 条都明确要求 Playwright 覆盖，当前只有组件测试 |
| 7 | 性能测试 + 并发核销/幂等命令测试；备份/恢复与 Worker/API 依赖失败演练 | 压测报告 + 演练记录 | 并发与幂等**有**库级证据：`supabase/tests/ops_receipt_domain.sql`（超额/重复/并发）、`ops_tenant_integration_domain.sql:463`（同幂等键重放返回同一 command id）。性能**无**：仓库内无压测脚本、无 10k/100k 合成数据生成器、无 p95 报告（R-10-01 判 `未实现`）。备份恢复无演练记录 | 缺证据 | udone 后端 + 发布协调 | ① PRD §10.1 四项 p95 基线全部未测；② 无恢复/回滚演练；③ 依赖失败（Supabase/GoTrue/远端租户 API 不可用）只有错误映射单测，无演练 |
| 8 | 复核日志脱敏、构建产物、权限/跨域拒绝、导出数据、错误关联 ID、恢复证据、前后端回滚步骤 | 静态检查 + 演练记录 | 产物/密钥：`quality:check` 含 secret scan 与 bundle secret 检查（负向 canary 已通过）；跨域拒绝：`ops_cross_domain_denials.sql`、`ops-denials.test.ts`；导出审计：`ops_exports_domain.sql`、`20261031000013_ops_exports.sql:92`（按类型映射权限）；错误关联：`apps/api/src/middleware/request-id.ts` + `index.ts:43`（requestId 最先挂） | 缺证据 | admin 前端 + udone 后端 | ① 无前后端回滚步骤文档与演练；② HTTPS 强制无仓库内证据（R-10-04）；③ 日志脱敏只做了「不写敏感字段」的代码约定，无抽样验证 |
| 9 | 业务负责人按 PRD 签收已交付功能、环境限制、未纳入范围 | 签收文件 | 无 | 需环境 | 业务负责人 | 前置 1–8 未全部就绪；且第 6 项 UAT 未跑，签收没有事实基础 |

## 2. 本地可补 vs 必须等环境

这是本表最实用的部分：**先做不依赖环境的事，别把「等环境」当唯一理由。**

### 2.1 完全可以在本地收口（3 条）

| # | 准入项 | 具体动作 |
| --- | --- | --- |
| 1 | 发布准入表 | 已产出。后续只需在每批次关闭时更新 `REQUIREMENT-TRACE.md` 状态与证据列。 |
| 4 | 契约差异检查 | 已就绪。补一条负向用例即可闭环（契约版本不匹配 → 前端明确报错，不回退 mock）。 |
| 8（静态部分） | 日志/产物/拒绝/导出静态检查 | secret scan、bundle 检查、拒绝用例、导出权限映射都可在本地跑；只剩「回滚步骤」需写文档，也是本地动作。 |

### 2.2 本地能补一半，另一半必须等环境（2 条）

| # | 准入项 | 本地可补 | 只能等环境 |
| --- | --- | --- | --- |
| 2 | 前端全量门禁 + 分支保护 | 11 步本地绿（已有）；依赖白名单到期复核（2027-01-28）可本地核 | Gitee 网页侧执行记录、required check 启用 |
| 3 | 空库重放 + RLS 正反向 | `pnpm db:local:verify` 已覆盖 45 迁移 + 37 pgTAP；本地空库重放也能再跑一次 | 空**隔离 Supabase 项目**的真实 grants/RLS 行为、JWT 签名链、GoTrue 真实会话 |

### 2.3 必须等环境或组织动作（4 条）

| # | 准入项 | 为什么本地做不了 |
| --- | --- | --- |
| 5 | staging 部署核对与顺序 | 没有环境。且 `ALLOWED_ORIGINS` 未配置这一点，本地永远测不出（本地同源） |
| 6 | UAT | 需要真实 staging + 虚构但完整的两租户数据集 + 各角色账号 |
| 7 | 性能与恢复演练 | 需要可压测环境与可回滚的部署；本地单机数据不能代表 Worker/DB 行为 |
| 9 | 业务签收 | 组织动作 |

**比例：9 条中 3 条完全本地可收口、2 条半本地、4 条必须等环境。**

## 3. 现在就能判定为「红」的项（不需要环境）

以下问题**在本地读代码就能确认**，与 staging 无关。它们会直接卡住第 6、7、9 项：

| # | 问题 | 证据 | 影响的准入项 |
| --- | --- | --- | --- |
| 1 | 登录结果没有审计事件 | `20261030000006_ops_identity_alignment.sql:62` 只更新 `last_login_at`；`ops.audit_events` 无登录 action | 第 6（审计验收）、第 9（签收） |
| 2 | MFA/二次认证只有字段没有执行 | `20261030000003_ops_identity.sql:43`（`mfa_required`），无读取/强制代码 | 第 6、第 9 |
| 3 | 性能基线零证据 | 无压测脚本/报告（R-10-01） | 第 7、第 9 |
| 4 | 无业务流程 e2e | `e2e/` 只有 auth/access/governance/permission 四个 spec | 第 6 |
| 5 | 导出不是后台任务 | `apps/api/src/modules/ops/exports/runner.ts:16` 懒执行挂在 `GET /exports` 上，一次读请求最多推进 1 条 | 第 7（超时验证） |
| 6 | 总览下钻不继承筛选 | `views/ops/identity-audit/overview.vue:204` 只 `router.push({name})` | 第 6（口径一致性） |
| 7 | staging/production 未配 `ALLOWED_ORIGINS` | `udone/wrangler.toml:24-40`；`apps/api/src/middleware/cors.ts:37` 失败即关闭 | 第 5 |

## 4. 建议收口顺序

1. **先补本地能补的**：第 1 项维护、第 4 项负向用例、第 8 项回滚文档。这些不依赖任何人。
2. **同步补 §3 的红项 1–6**：登录审计、MFA 决策（要么做要么明确移出首期）、性能脚本、业务流程 e2e、导出执行模型、下钻传参。这些是代码/文档工作，不需要环境审批。
3. **再搭 staging**：先把第 5 项的七要素写成清单（环境名、API URL、CORS、Auth 回调、project ref、pending migration、secrets 名），再谈部署——否则部署完也是被 CORS 挡住的状态。
4. **最后跑 UAT 与压测，再签收**。顺序颠倒（先签收后补证据）会让第 9 项变成形式。

## 5. 与 PRD §11.2 完成定义的对照

| PRD §11.2 要求（PRD:390–394） | 本表对应 | 当前是否满足 |
| --- | --- | --- |
| P0 流程均有页面、API、迁移、RLS、审计、自动化验收 | 第 1、3、6 项 + 追踪表全表 | 页面/API/迁移/RLS/审计基本齐；**自动化验收缺业务流程 e2e** → 否 |
| 授权矩阵、数据边界、同步契约可追溯到技术设计 | 第 1 项 + 追踪表 R-4-*、R-9-* | 是（R-ID 已可追到 `文件:行`） |
| 使用纯虚构数据完成端到端验收 | 第 6 项 | 否（未做） |
| 性能、安全、RLS 跨域拒绝、幂等重试有可复核结果 | 第 3、7、8 项 | 部分：RLS 拒绝与幂等有；性能无 → 否 |
| 不存在绕过审批/客户端改核心状态/以 UI 隐藏替代授权 | 第 3、4、8 项 + R-6-37、R-4-06 | 是（审批分离有 pgTAP，前端隐藏有 e2e 反证） |

**结论：§11.2 五条中 2 条满足、3 条不满足。首期不能宣布完成。**

## 6. 本表的失效条件

出现下列任一情况，本表结论作废，须重新取证：

1. `admin` 或 `udone` 任一侧依赖升级、lockfile 变更。
2. 新增迁移或修改 RLS/grant。
3. 契约源 `udone/packages/contracts/src/routes.ts` 变更。
4. 依赖白名单到期（2027-01-28）后未复审。
