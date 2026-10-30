# 有单·旅游管理系统路线图

当前 MVP 与试运行上线计划见 `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md`。平台基础与权限骨架已完成，历史计划和验收记录见 `Docs/superpowers/plans/2026-10-02-platform-foundation.md`；该计划中尚未闭环的组织上下文/RLS 与工程门禁已提升为新计划首批阻断项。

业务端当前未完成项的**执行层清单**见 `Docs/superpowers/plans/2026-10-29-business-completion-backlog.md`：它不重定义需求，只把 A（验证闭环）/ B（数据完整性）/ C（需求缺口）/ D（工程债）四类未完成项拆成可验证任务，并标注每项的现状证据与验收标准。P0 架构加固见 `Docs/superpowers/plans/2026-10-29-p0-architecture-hardening.md`。

运营端（ops）后端由本仓库实现，执行层计划见 `Docs/superpowers/plans/2026-10-30-ops-backend-implementation.md`：先做 4 项前置纠正（幂等命名空间、PostgREST 暴露 `ops`、契约双注册表、认证代理），再交付 T-01/T-02/T-03 的「登录 + `/meta` + `/session`」最小闭环；字段与端点真源仍是运营端仓库的 `admin/Docs/ops-api-contract.md`，本仓库不重定义。

与运营端的**差异台账**见 `Docs/superpowers/plans/2026-10-30-ops-alignment.md`：15 条分歧逐条裁决（谁改、依据、可复核命令），并锁定执行顺序 N1~N8。两份文档冲突时以差异台账为准——它记录的是「为什么顺序是这样」。任何时候要判断「一件事到底归谁做」，先查这张表，不要按合同/报告的字面描述推。

**长任务推进计划**见 `Docs/superpowers/plans/2026-10-30-long-run.md`：把看板上 39 张可动卡切成约 76 个推进单元，排成 P1（可关桩闭环）→ P8（全量回归）串行主线 + P9（业务 backlog 填缝），并给出里程碑 M1~M8。它回答的是「接下来按什么节奏连续推」，不重定义顺序依据（那个在差异台账）也不重定义步骤（那个在实施计划）。配套约束 `.harness/LONG_RUN.md`。

复刻产品行为以 `Docs/REPLICATION_SPEC.md` 为准，技术基线以 `Docs/TECH_SELECTION.md` 为准。逐项更新计划状态与验收证据，不将历史阶段材料当作完成证明。
