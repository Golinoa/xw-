# 有单软件运营后台协作规则

## 项目范围

本项目是软件提供方内部运营后台，不是旅行社日常使用的 ERP/OMS。产品范围以 [Docs/PRD.md](Docs/PRD.md) 为准；`../udone` 的需求和页面不得直接当作本项目事实。

## 开始工作前

1. 阅读 [ARCHITECTURE.md](ARCHITECTURE.md)、[Docs/PRD.md](Docs/PRD.md) 和 [Docs/TECH_SELECTION.md](Docs/TECH_SELECTION.md)。
2. 阅读 `.harness/PROJECT_STRUCTURE.md` 与 `.harness/DOCUMENT_MAP.md`，遵守目录归属和文档真源规则。
3. 按任务读取相关 `.harness/` 规范；涉及页面样式、组件或主题时先读根 [DESIGN.md](DESIGN.md) 及其指向的已定稿视觉规则。
4. 涉及 `udone` 租户数据、接口或迁移时，检查 `../udone/AGENTS.md` 及对应 API/数据库真源；不得依据旧讨论稿猜表名、接口字段或状态。
5. 每项任务完成前，在 `.harness/journal/YYYY-MM-DD-short-task-summary.md` 记录完成事项、决定、问题和下一步。

## 文档真源

- [Docs/PRD.md](Docs/PRD.md)：运营后台的业务范围、规则和验收真源。
- [Docs/TECH_SELECTION.md](Docs/TECH_SELECTION.md)：技术选择及其理由。
- [ARCHITECTURE.md](ARCHITECTURE.md)：本项目与 `udone` 的运行时、模块和依赖边界。
- [DESIGN.md](DESIGN.md)：视觉规范生效入口。
- `.harness/*_STANDARDS.md`、`ENGINEERING_DESIGN.md`、`FRONTEND.md`、`SECURITY.md`、`RELIABILITY.md`：相应领域的工程约束。
- `.harness/docs/` 下索引只链接真源，不另行定义需求或技术规则；生成报告不得手工维护。

发生冲突时，按领域更新唯一真源并同步索引。运营后台文档不能改写 `udone` 的业务事实；跨系统约定必须在后端 API 的权威文档和本项目前端消费契约之间明确版本。

## 证据和变更约束

- 区分仓库已验证事实、外部参考事实、产品决策和推导方案；推导不得伪装成已实现行为。
- 先检查工作区和目标文件，保持改动范围小，保留无关 WIP。禁止清理或覆盖 `udone` 现有工作。
- 不凭空发明 Supabase 表、API 参数、租户状态或数据权限；需通过产品真源、已实现接口或迁移验证。
- 运营账号、合同、收款、退款、授权和租户命令属于高风险数据；任何写操作都需服务端授权、事务/幂等策略和审计。
- 不在日志、示例、测试数据或 journal 中写入密钥、真实客户资料、完整付款凭证或认证令牌。
- 魔法数字、无验证的类型断言、吞错、未跟踪异步任务、客户端信任权限等禁止用法遵守 `.harness/CODE_STANDARDS.md` 与安全规范。

## Superpowers 技能选择

按任务形状选择必要技能，不默认启动完整流程。小型清晰文档修改使用文档任务所需的最小流程；需要塑造行为/架构时用 `brainstorming`；跨多步实施在设计确认后再用 `writing-plans`；代码行为变更按需加入 TDD、调试或验证技能。技能触发规则优先于本条概括，已获用户授权的行动无需重复确认。

## 完成汇报

总结改动文件、实际核验的证据/命令、未完成项和下一步。不要将静态文档检查描述为代码或运行时验收。
