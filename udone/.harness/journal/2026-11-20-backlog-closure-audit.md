# 2026-11-20 收尾核查：backlog 21 项的产物是否真在 HEAD 上

**为什么做这次核查**

计划内只剩 D2 一格，而 D2 卡在平台动作（Gitee Go 里还没有流水线对象），本机无法代办。
前几轮已经把 CI 的 goals 按序回放过了，再回放一次没有新信息。所以这一轮换问题：
**把 20 个已打勾的卡当成「别人的声明」重新体检一遍**——卡片打勾只代表当时跑过，
不代表 HEAD 上产物没被后续改动弄丢（删文件、漏注册、页面没接到路由都算）。

做法：只做静态取证（文件/路由/注册），**不重跑测试**（2 小时前刚回放过，全绿），
避免把「核查」变成又一次全量门禁。

**核查结果（HEAD `b1b973b`）**

| 层 | 数字 | 与卡片声明的对比 |
|---|---|---|
| supabase 迁移 | 61 | 与 `schema:check` 的 61 一致 |
| pgTAP 文件 | 50 | 卡片收官时 49（C11 之后），只增不减 |
| HTTP 集成测试 | 34 个文件 | 收官时 31 个（C11），只增不减 |
| 单测文件（apps+packages） | 68 | 74 文件/925 用例是 vitest 口径（含 tests/ 与 ops 子目录），不矛盾 |
| E2E spec | 7 个 | 收官时 6 个（A1 + admin-surfaces），多出 `master-data` 与 `order-permission-guards` |

三处「产物是否接上」的抽查，全部接上了：

1. **前端页面**：`views/` 下 30 个 `.vue`，其中 17 个页面级组件全部挂在路由上
   （登录 + 首页 + 15 个业务页），剩下 13 个是表单弹窗/详情抽屉，按设计不占路由；
   不在左侧导航的 `/customers/recycle-bin` 由客户列表的「回收站」按钮进入
   （`canRestore` 权限门），属有意设计，不是死链。
2. **API 装配**：`index.ts` 里 35 条 `app.route`，其中 16 个业务模块 + 17 个 ops 模块
   全部挂上，`modules/` 目录无孤儿模块。
3. **C6–C12 七个卡**：每张卡的 api 模块（3 文件：service/routes/test）、web 视图、
   pgTAP 断言文件（`settlement_batches.sql` / `tenant_reports.sql` / `route_master.sql` /
   `tourist_roster.sql` / `restore_permissions.sql` …）都在。

**结论**：20 个已打勾的卡在 HEAD 上站得住，没有「勾了但东西没了」的情况。
计划内唯一未完成项仍是 **D2**，且卡点与上一轮记录一致（平台侧没有流水线对象，
本机凭据无法通过 Gitee OpenAPI 认证）。

**这轮没做什么，以及原因**

- 没重跑测试套件：2 小时前刚做完 `ci.yml` 全序列回放（74 文件 925 用例、E2E 24 通过 1 跳过），
  期间没有任何代码提交（HEAD 仍是 `b1b973b`），重复跑只消耗时间。
- 没动「`updated_by` 列无人写入」这个范围外缺陷：它是审计字段，改动会波及
  routes/customers/sources/tags 四个模块的写路径，属于新范围，等用户点头。
- 没清理 `udone/.worktrees/` 下 9 个历史 worktree 目录：已被根 `.gitignore` 忽略，
  与 git 无冲突，但占磁盘，是否删由用户定。
