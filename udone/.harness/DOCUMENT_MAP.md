# Harness 文档索引地图

本文件是 `udone` 文档和工程资料的导航，不另建需求、证据或工程规范副本。修改文档时先编辑唯一真源，再更新受影响的索引链接。

## 产品与研究真源

| 文档/目录 | 权威范围 |
|---|---|
| [`Docs/REQUIREMENTS.md`](../Docs/REQUIREMENTS.md) | 本项目产品范围、业务规则与验收；标为方案/默认值的内容不代表目标站事实。 |
| [`Docs/REPLICATION_SPEC.md`](../Docs/REPLICATION_SPEC.md) | 目标站行为与复刻证据唯一口径，保留证据等级、观察范围和研究缺口。 |
| [`Docs/research/evidence/`](../Docs/research/evidence/) | 原始脱敏研究证据；引用时保留来源、日期和证据级别。 |
| [`Docs/TECH_SELECTION.md`](../Docs/TECH_SELECTION.md) | 技术选择及理由。 |
| [`Docs/superpowers/plans/`](../Docs/superpowers/plans/) | 分阶段实施计划；活跃/完成状态以 Harness 执行计划索引和验收证据核对。 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 仓库/运行结构、分层、依赖方向和安全边界。 |
| [`DESIGN.md`](../DESIGN.md) 与 [`Design-system/`](Design-system/) | 生效的视觉规范入口和已定稿规则；Markdown 是规则正文，HTML 仅作预览。 |

## Harness 导航

| 路径 | 用途 |
|---|---|
| [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) | 当前目录图、文件归属和新增目录规则。 |
| [`ENGINEERING_DESIGN.md`](ENGINEERING_DESIGN.md)、[`CODE_STANDARDS.md`](CODE_STANDARDS.md) | 架构和代码约束。 |
| [`CONTRACTS.md`](CONTRACTS.md)、[`API_STANDARDS.md`](API_STANDARDS.md)、[`DATABASE_STANDARDS.md`](DATABASE_STANDARDS.md) | 跨端契约与类型一致性、API、权限、迁移、RLS 与数据库访问约束。 |
| [`TESTING_STANDARDS.md`](TESTING_STANDARDS.md)、[`ENGINEERING_STANDARDS.md`](ENGINEERING_STANDARDS.md) | 测试策略与工具链/依赖/CI/发布门禁。 |
| [`FRONTEND.md`](FRONTEND.md)、[`SECURITY.md`](SECURITY.md)、[`RELIABILITY.md`](RELIABILITY.md)、[`QUALITY_SCORE.md`](QUALITY_SCORE.md) | 前端、安全、可靠性和质量评审补充规则。 |
| [`REPORTING.md`](REPORTING.md) | 状态/进度汇报的约束：分端内联图、四态、数字取自当次观测输出。 |
| [`docs/product-specs/`](docs/product-specs/) | 产品规格检索索引；需求真源仍在 `Docs/REQUIREMENTS.md`。 |
| [`docs/design-docs/`](docs/design-docs/) | 已确认的架构理由和专题设计。 |
| [`docs/exec-plans/active/`](docs/exec-plans/active/) | 尚待执行/外部验收的计划；完成必须具备计划要求的证据。 |
| [`docs/exec-plans/completed/`](docs/exec-plans/completed/) | 历史执行记录，不代表当前生产已验收。 |
| [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md) | 指向源需求/计划的未完成项。 |
| [`docs/references/`](docs/references/) | 外部资料检索摘要，保留原文来源，不作为产品/技术真源。 |
| [`docs/generated/`](docs/generated/) | 可重复生成的清单/报告，不手工编辑。 |
| [`design-drafts/`](design-drafts/) | 当前讨论稿；定稿/否决/替代后依规则迁移或删除，不作历史库。 |
| [`journal/`](journal/) | 按日任务记录；遵守 `AGENTS.md` 的模板要求。 |

## 文档冲突与生命周期

- 按上表找到唯一真源。索引只链接/概括，不重定义来源；技术、运行架构、视觉规则分别归 `TECH_SELECTION.md`、`ARCHITECTURE.md`、`DESIGN.md` 与定稿设计系统。
- 来源冲突时修正权威文档并同步索引，保留证据级别和原始日期；不保留两个竞争的当前版本。
- 修改/移动文档时修复相对链接；清理前确认材料不再承载唯一信息、有效决策、原始证据或仍在执行的任务。
- 研究结论区分仓库事实、目标站网络证据、界面/回读证据、提案和未决问题。`-llms.txt` 是检索辅助，不代替原始来源。
- 计划移动至 `completed/` 不等于完成；真实环境证据未取得时保持未验证/活跃状态。
- Schema 文档只能从 migration/schema 真源生成；过期时修复生成器，不手写猜测表结构。
