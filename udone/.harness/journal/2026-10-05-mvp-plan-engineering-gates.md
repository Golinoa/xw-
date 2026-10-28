# 2026-10-05-mvp-plan-engineering-gates

## 今日完成
- 更新 MVP 与试运行上线执行计划，将工程约束和可执行门禁纳入 Task 2 与 Task 9。
- 为 PR 质量门补充 Node/pnpm 与锁文件、format/lint/typecheck/unit/build、部署配置、secret scan、依赖漏洞/许可证、schema inventory 和隔离数据库测试要求。
- 明确规范需要有命令、阻断条件和失败证据；CI 工作流与 Git 分支保护需分别验证。
- 明确 `~admin` 是并列项目，Vben 导入和独立工程门禁另在其项目计划管理，不混入旅行社 ERP 的 MVP 业务任务。

## 关键决策
- 本地可复现的 PR 门禁与真实 staging/生产验收分开；不让 CI 连接可写生产或共享 staging。
- 覆盖率不设未经批准的数字阈值；数据库/RLS 变更必须通过隔离 PostgreSQL/pgTAP，真实运行链路仍以 staging 证据为准。
- schema 报告继续作为生成物，只修复生成流程，不手工补写报告。

## 遇到的问题
- 本次仅更新计划和 journal，未实施 CI、质量工具或运行测试；原工作区存在其他未提交/未跟踪文件，未触碰。

## 下一步计划
- 按计划先完成组织上下文/RLS 阻断项与 Task 2 工程门禁，再启动 Task 3–8 的业务开发。
- 实施 Task 2 时确定并锁定依赖漏洞/许可证扫描工具、策略阈值和 Node 版本，并验证各门禁正向/负向行为。
