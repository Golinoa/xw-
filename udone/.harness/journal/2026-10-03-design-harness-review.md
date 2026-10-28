# 2026-10-03 — 需求与 harness 设计审阅

## 今日完成

- 审阅 `Docs/REQUIREMENTS.md`、`Docs/REPLICATION_SPEC.md`、`Docs/TECH_SELECTION.md`、`ARCHITECTURE.md`、平台基础计划及 `.harness` 的设计、安全、可靠性、质量和产品约束。
- 对照现有 workspace、Worker 鉴权/组织上下文实现和 Supabase RLS migration，检查文档约束是否能映射到工程基线。
- 记录主要设计判断：业务需求覆盖较全；真实组织上下文与 RLS claim 的传递机制尚未闭环；harness 有原则约束，但格式/lint/命名/测试门槛尚未自动化。
- 只新增本审阅记录，没有修改已有文档、代码或用户现有 WIP。

## 关键决策

- 将目标站观测事实、产品需求和工程方案分开评价；不把复刻规格中的未验证事实当作产品承诺。
- 发现 RLS helper 依赖 `auth.jwt() ->> 'organization_id'`，而 Worker 使用 `X-Organization-ID` 校验成员后转发原 bearer JWT。仓库尚无 JWT custom access token hook 或同事务数据库上下文注入方案；现有数据库测试设置了带 `organization_id` 的模拟 claims，不能单独证明真实登录切换组织的 RLS 链路。
- 发现 `TECH_SELECTION.md` 指定 ESLint 并列出 Pinia、TanStack Query 等候选/组件，但当前包脚本和依赖没有 ESLint、Pinia 或 TanStack Query；未据此推断其必须立刻安装，建议先明确决策和阶段门槛。
- 当前审阅只读；工作树已有用户修改和未跟踪文件，均保留。

## 遇到的问题

- 未做外部生产环境测试或运行测试；结论来自静态文档与代码对照。
- Canvas skill 的本地 SDK 声明目录不可用，本轮未生成 canvas 文件。

## 下一步计划

- 由项目负责人确定可验证的租户上下文到 PostgreSQL RLS 传递设计，并增加真实 Supabase JWT + 多租户切换的部署链路验收。
- 明确服务端/前端格式化、lint、命名、错误处理和覆盖率门槛，令 package scripts/CI 与 harness 保持一致。
- 收敛用户规模、数据保留、服务可用性/延迟、RPO/RTO、备份责任和七牛费用等待决策项；修正文档重复段落并同步候选栈实际决策。
