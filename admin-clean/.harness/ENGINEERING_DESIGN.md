# 架构设计约束

- 业务需求以 `Docs/PRD.md` 为准，技术与模块边界以 `ARCHITECTURE.md`、`Docs/TECH_SELECTION.md` 为准。
- `~admin` 独立维护 Vben 前端；Hono API、Supabase 迁移和 RLS 由相邻 `udone` 后端仓库唯一维护。
- 页面只负责交互和呈现；HTTP 边界负责校验/鉴权；应用服务编排业务；领域规则不得依赖 Vue、Hono、Supabase SDK 或 provider SDK。
- 新抽象必须对应真实重复行为或稳定边界；禁止为设想中的未来拆出空泛层、通用框架或微服务。
- 跨系统交互使用版本化 API 契约和稳定标识，不导入 `udone` 私有源码路径，不直接写对方数据库表。
- 运营、财务、授权和租户状态变化必须可归因、可审计；多对象变更要有事务或幂等命令边界。
- 任何架构例外写入 `Docs/TECH_SELECTION.md` 或架构决策文档并说明迁移条件，不在代码中隐式形成第二套规则。
