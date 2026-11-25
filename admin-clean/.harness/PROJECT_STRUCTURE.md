# 项目目录与文件归属

本文记录文档基线及已导入 Vben workspace 的实际目录。上游基线为 `vbenjs/vue-vben-admin@63a38dce49ba109f61607994e21ba921d8e970e9`（v5.7.0）。

## 当前目录

| 路径 | 当前职责/约束 |
| --- | --- |
| `AGENTS.md` | 协作、启动顺序、文档真源和安全约束入口。 |
| `ARCHITECTURE.md` | 前端/API/运营数据边界、领域依赖和一致性架构。 |
| `DESIGN.md` | 页面视觉规范入口。 |
| `Docs/PRD.md` | 运营后台需求与验收真源。 |
| `Docs/TECH_SELECTION.md` | Vben、共享 Hono API、Supabase 与部署的技术选型真源。 |
| `Docs/README.md` | `Docs/` 文档快速导航。 |
| `Docs/superpowers/` | 设计/执行计划类资料；当前有效计划以 Harness active 索引为准。 |
| `.harness/` | 工程规范、目录/文档地图、索引、执行计划和 journal。 |
| `apps/web-antd/` | 唯一导入的产品应用；Vue Vben Admin Ant Design Vue 前端。 |
| `packages/` | Vben 共享 UI、访问控制、状态、请求、工具和类型包。 |
| `internal/` | Vben 构建、lint、tsconfig 与开发工具共享包。 |
| `scripts/` | Vben workspace 开发和检查脚本。 |
| `pnpm-workspace.yaml`、`pnpm-lock.yaml` | 唯一 pnpm workspace 声明和锁文件。 |
| `LICENSE` | 上游 Vben MIT 许可及版权声明。 |
| `.harness/docs/product-specs/` | 产品规格索引，不复制 PRD。 |
| `.harness/docs/design-docs/` | 架构决策与工程理由索引。 |
| `.harness/docs/exec-plans/active/` | 未完成或需外部验收的实施计划。 |
| `.harness/docs/exec-plans/completed/` | 有验收证据的历史计划索引。 |
| `.harness/journal/` | 每任务日记，按 `AGENTS.md` 的精确章节要求记录。 |

未导入其它产品应用、独立 playground 或上游 `docs/`。上游 `docs/` 与项目既有 `Docs/` 在 Windows 文件系统大小写不敏感，无法同时存在；为保留 PRD/技术选型等真源，本仓库保留原 `Docs/` 路径，上游文档由锁定 commit 查阅。完整 `pnpm-lock.yaml` 来自同一上游 commit；安装通过 filter 只选择 `apps/web-antd` 及其 workspace 依赖和根工具。

## Vben 导入后的结构规则

- 按 [TECH_SELECTION.md](../Docs/TECH_SELECTION.md) 保留完整共享 workspace 和上游根配置；仅纳入 `apps/web-antd` 产品应用。实际目录以导入并锁定的 commit 为准。
- 页面业务模块归入 Vben 应用的实际 feature/view 组织方式；可复用组件、API adapter、路由/权限集成按上游现有包边界放置。不得将业务页散放在模板 demo 中，不复制整个公共组件库。
- `~admin` 仅含浏览器前端和前端构建/发布配置。Hono API、Supabase migrations/schema/RLS/pgTAP 由相邻 `../udone` 项目维护；禁止在此创建第二份后端、迁移或受保护表访问层。
- 前端只通过公开、版本化运营 API 契约访问业务；不直接用 Supabase client 查询受保护的运营表，不从 `../udone` 导入私有源码。
- 新增依赖放入实际使用该依赖的 Vben workspace package，并同步唯一 lockfile；新增顶层目录或改变 workspace 边界前先更新架构决策与本图。
- 上游 Vben 更新后核实 package/workspace 结构并更新本图；不按旧 commit 目录推测当前结构。
- 根 workspace manifests、唯一 pnpm lockfile、TypeScript/构建/测试和部署配置按锁定 Vben workspace 的实际位置维护；不要另建第二个 lockfile 或平行构建配置。

## 文件归位规则

- 组件单元测试遵循导入模板当前约定；业务流程 E2E 放在模板认可的应用测试目录，安全/RLS 测试只能在 `udone` 数据库测试路径。
- 仅面向 `~admin` 的 API schema/client 可以是由后端公开契约生成的前端产物；源契约必须留在 `udone`，不可维护手写镜像字段。
- 构建产物、`node_modules`、本地 `.env`/secret、Playwright 输出和临时截图不属于源代码归档目录，按 Vben `.gitignore` 与项目 secret 约束处理。
- 目录图描述实际所有权，不要求预建空目录；创建新的根职责或模块边界时同步本文件和 `ARCHITECTURE.md`。
