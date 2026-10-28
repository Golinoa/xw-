# 项目目录与文件归属

本图描述 `udone` 当前仓库真实结构及新增文件放置约束。根目录是产品、应用和文档根；新增目录优先归入已有职责，不因“未来可能复用”新建空泛层或第二套文档真源。

## 根目录结构

| 路径 | 职责与约束 |
|---|---|
| `apps/web/` | Vue 3 用户界面。路由/布局、视图、组件、状态、API client 等前端代码归此处；不承载服务端授权或财务真值。 |
| `apps/api/` | Hono Worker API。`src/routes/` 负责 HTTP 边界，`src/middleware/` 放鉴权/上下文等 middleware，`src/services/` 放现有应用服务/适配职责。新增业务域按实际结构和架构约束扩展；不得把 UI、SQL 或领域业务塞进 route。 |
| `packages/contracts/` | 前后端共享的公开 DTO、权限、状态和错误契约；跨包只依赖公开 export，不引用私有源码路径。 |
| `supabase/migrations/` | PostgreSQL schema、grants、RLS、约束和 RPC 的权威变更源；按 Supabase CLI 迁移规则新增。 |
| `supabase/tests/` | pgTAP 数据库策略、事务、RLS 和约束测试；数据库事实必须来自 migration/schema，不从研究概念猜造。 |
| `supabase/` | Supabase CLI 配置及虚构 seed。禁止把生产数据/凭证放入配置、seed 或本地样例。 |
| `tests/database/` | Worker/应用与本地数据库组合的集成测试。 |
| `tests/e2e/` | 本地、可重复的浏览器端到端流程。 |
| `tests/smoke/` | Worker/部署边界 smoke 测试；按授权环境运行。 |
| `tests/tooling/` | 工程配置、验证脚本和 harness 工具的回归测试。 |
| `scripts/` | 可重复的仓库级开发、生成、配置校验脚本；不可把一次性临时代码留在此处。 |
| `Docs/` | 产品需求、目标站研究/证据、技术选型和计划。文档真源见 `.harness/DOCUMENT_MAP.md`。 |
| `.harness/` | 项目约束、目录/文档地图、设计系统、索引、执行计划、生成报告与 journal；各来源分工见文档地图。 |
| `tests/` | 跨包测试入口；按数据库、E2E、smoke、tooling 类型归位，不在根目录散放未分类测试。 |

根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`vitest.config.ts`、Playwright 配置和 `wrangler.toml` 分别维护 workspace 命令/依赖、TypeScript、测试及 Worker 部署配置。脚本只放在 `scripts/` 或实际 workspace package 中。

`node_modules/`、`dist/`、`test-results/`、`.wrangler/`、`.worktrees/` 和本地环境文件是依赖、构建、测试、部署或隔离工作区产物，不作为源码放置区；按 `.gitignore` 和命令输出管理。

## 放置规则

- Web、API、共享契约和 SQL 迁移分别放在上述所有者目录；禁止前端直接写数据库表或把权限业务放进菜单/UI。
- 单元测试贴近被测源码并采用 `*.test.ts`；跨层数据库/browser/smoke 测试放对应 `tests/` 子目录。
- 新增 root 目录或改变目录职责前，先核对 `ARCHITECTURE.md` 与 `.harness/ENGINEERING_DESIGN.md`；稳定边界变化时同步架构真源及本图。
- 不因模块名在架构图中出现就预先创建空目录；有实际实现文件时再建目录。
- `.harness/docs/generated/` 只能由可重复生成流程更新；`.harness/design-drafts/` 只存当前讨论稿，定稿后移入对应真源并清理被取代稿。
