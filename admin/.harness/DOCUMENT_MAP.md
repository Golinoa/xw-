# Harness 文档索引地图

此地图帮助定位 `~admin` 的文档真源和工程规则。索引只导航，不再定义一套平行产品/API/技术规范。

## 项目级真源

| 文档 | 真源范围 |
|---|---|
| [`Docs/PRD.md`](../Docs/PRD.md) | 软件提供方运营后台产品范围、业务规则、排除项和验收。 |
| [`Docs/TECH_SELECTION.md`](../Docs/TECH_SELECTION.md) | Vben 版本/应用、共享 API/数据库/认证和部署选型。 |
| [`Docs/superpowers/`](../Docs/superpowers/) | 设计/执行计划类资料；当前有效执行计划以 Harness active 索引为准。 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | `~admin` 与 `udone` 运行边界、模块依赖、身份/数据域和一致性。 |
| [`DESIGN.md`](../DESIGN.md) | 运营后台页面规范入口，链接到已定稿设计系统。 |
| [`../udone/AGENTS.md`](../../udone/AGENTS.md) 及 `udone` migrations/API | 共享 ERP 端的后端、数据库与 API 实现真源；运营端不得复制或猜测。 |

## Harness 导航

| 路径 | 用途 |
|---|---|
| [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) | 当前文档目录及 Vben 导入后的目录/文件归属规则。 |
| [`ENGINEERING_DESIGN.md`](ENGINEERING_DESIGN.md)、[`CODE_STANDARDS.md`](CODE_STANDARDS.md) | 分层、依赖和代码书写约束。 |
| [`API_STANDARDS.md`](API_STANDARDS.md)、[`DATABASE_STANDARDS.md`](DATABASE_STANDARDS.md) | 公开 API 消费边界与后端数据库规则；数据库实施由 `udone` 负责。 |
| [`TESTING_STANDARDS.md`](TESTING_STANDARDS.md)、[`ENGINEERING_STANDARDS.md`](ENGINEERING_STANDARDS.md) | 测试、依赖、构建、自动质量门与发布流程约束。 |
| [`FRONTEND.md`](FRONTEND.md)、[`SECURITY.md`](SECURITY.md)、[`RELIABILITY.md`](RELIABILITY.md) | 前端、安全与可靠性约束。 |
| [`docs/product-specs/`](docs/product-specs/) | PRD 检索索引；不得替代 PRD。 |
| [`docs/design-docs/`](docs/design-docs/) | 已确认设计决定和工程理由索引。 |
| [`docs/exec-plans/active/`](docs/exec-plans/active/) | 正在等待执行、集成或环境验收的计划。 |
| [`docs/exec-plans/completed/`](docs/exec-plans/completed/) | 已满足计划证据要求的历史任务索引。 |
| [`journal/`](journal/) | 按日任务记录；任务结束前按 `AGENTS.md` 写入。 |

## 文档维护规则

- PRD 变更先更新 `Docs/PRD.md` 及受影响验收；架构/技术选择先更新对应真源，再同步本索引或计划。
- 跨 `udone` 的 API 字段、状态和错误码以其真实公开契约为准；缺少契约时先在后端形成契约，不在本项目猜表名或维护竞争版本。
- 索引只提供链接和简短摘要。计划是执行路径，不覆盖需求/架构真源；移动为 completed 必须有对应验收证据。
- 新增/移动文档时修复相对链接；删除前确认其没有独有信息、有效决策、未完成任务或原始证据。
