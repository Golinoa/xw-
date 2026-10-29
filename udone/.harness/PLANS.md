# 有单·旅游管理系统路线图

当前 MVP 与试运行上线计划见 `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md`。平台基础与权限骨架已完成，历史计划和验收记录见 `Docs/superpowers/plans/2026-10-02-platform-foundation.md`；该计划中尚未闭环的组织上下文/RLS 与工程门禁已提升为新计划首批阻断项。

业务端当前未完成项的**执行层清单**见 `Docs/superpowers/plans/2026-10-29-business-completion-backlog.md`：它不重定义需求，只把 A（验证闭环）/ B（数据完整性）/ C（需求缺口）/ D（工程债）四类未完成项拆成可验证任务，并标注每项的现状证据与验收标准。P0 架构加固见 `Docs/superpowers/plans/2026-10-29-p0-architecture-hardening.md`。

运营端（ops）后端由本仓库实现，执行层计划见 `Docs/superpowers/plans/2026-10-30-ops-backend-implementation.md`：先做 4 项前置纠正（幂等命名空间、PostgREST 暴露 `ops`、契约双注册表、认证代理），再交付 T-01/T-02/T-03 的「登录 + `/meta` + `/session`」最小闭环；字段与端点真源仍是运营端仓库的 `admin/Docs/ops-api-contract.md`，本仓库不重定义。

复刻产品行为以 `Docs/REPLICATION_SPEC.md` 为准，技术基线以 `Docs/TECH_SELECTION.md` 为准。逐项更新计划状态与验收证据，不将历史阶段材料当作完成证明。
