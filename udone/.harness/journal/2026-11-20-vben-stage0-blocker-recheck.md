# 2026-11-20 阶段 0 复核：阻塞未变，但关掉了一条假退路、纠正了一条假结论

**本轮没有迁移代码。** 业务清单（`2026-10-29-business-completion-backlog.md`）21 项全勾、
D2 已在 GitHub Actions `run #44675102215` 真实全绿，本计划内**没有任何可做卡片**。
所以本轮做的是阶段 0 的**验收性复核**，不重跑已完成的门禁。

## 做了什么

1. **复核阻塞状态**（唯一一行判据）：
   - `admin/node_modules` 顶层 = 2 项（`.pnpm` + `rolldown`），正常装好的状态应是十几个包目录；
   - `admin/node_modules/.pnpm` = **1716** 个条目（1.2G store 完整，缺的只是顶层链接）；
   - `admin/apps/web-antd/node_modules` = 10 项（含 `@vben` 4 条内部链）。
   ⇒ **install 从未执行过，阶段 0 阻塞未变。**

2. **证伪退路「独立精简 Vben 工程」**（功能地图 §7 留的那条）。这条退路一直
   挂在计划里没人验证过，而它决定了「能不能绕开 39-workspace 大仓」。结论是**不能**：
   - `apps/web-antd/package.json` 的 14 个 `@vben/*` 依赖**全部是 `workspace:*`**；
   - npm registry 实查：`@vben/common-ui`、`@vben/preferences`、`@vben/access`
     **不存在**；`@vben/layouts`、`@vben/request`、`@vben/stores`、`@vben/styles`
     只发布过 `1.0.1`（2023-11-24，Vben 2.x 时代），各 1 个版本；
   - Vben 5 底层包 `@vben-core/{shadcn-ui,composables,preferences,typography}` 也**均未发布**。
   ⇒ Vben 5 是**模板仓库**不是 npm 库。要用只能编译 `admin/` 源码 ⇒ 必须先修那 976 条链接。

3. **纠正计划里一条错误结论**。原文写「`rolldown` 软链指向了错误版本（旧 1.0.1），已用 `rm` 删除」。
   实测两点都不成立：
   - `admin/node_modules/rolldown` **还在**，是**实体目录**（非软链），版本 `1.0.1`，
     `bin/` `dist/` 齐全；
   - `pnpm-lock.yaml` 根 importer 声明 `rolldown: ^1.0.1` → 解析 `1.0.1`，
     `.pnpm/` 里同时存在 `rolldown@1.0.1` 与 `1.2.16`。
   ⇒ **1.0.1 正是根 importer 要的版本**，不是错的；也没被删。
   若照原文去「清理」它，反而可能把当前还能解析 `rolldown` 的路径弄断。**处置：不动。**

4. **在业务清单末尾加「完结后的走向」**（§9），把后续真源指向
   `vben-migration-plan.md` 与 `frontend-function-map.md`，并写明
   「看到全部已勾选就不要重复跑门禁 / 不要重做体检，只核对一行阻塞判据」。

## 为什么这么决定

- **不重跑门禁**：上一轮（2h 前）已按序回放 `.workflow/ci.yml` 全序列，HEAD 之后无代码改动；
  再跑一遍是纯浪费，且用户明确反对无信息量的重复验证。
- **不做「补 976 条软链」**：理论上可从 `pnpm-lock.yaml` + `.pnpm` 目录名推导出应建的链接
  （是确定性查找，不是瞎猜），但这等于自己写一个包链接器，风险远大于收益，
  且直接违反项目红线「admin 依赖只能由用户在自己终端装」。**列为选项，不执行。**
- **不跑 `vite build` 探针**：顶层条目数还是 2，结果必然是同一个 `@babel/runtime` 缺失失败，
  零信息量。判据已写进计划 §4，装好后由下轮自动化跑。

## 验证证据

| 项 | 命令 | 结果 |
|---|---|---|
| 仓库状态 | `git status --porcelain` | 仅本次要提交的文档/记忆文件 |
| 分支同步 | `git rev-parse HEAD / origin/main` | 均为 `3902bce` |
| admin 顶层链接 | `ls admin/node_modules` | `.pnpm`、`rolldown`（2 项） |
| pnpm store | `ls admin/node_modules/.pnpm \| wc -l` | 1716 |
| app 顶层链接 | `ls admin/apps/web-antd/node_modules` | 10 项 |
| rolldown | `node -p require('./node_modules/rolldown/package.json').version` | 1.0.1，实体目录 |
| 未勾选项扫描 | `grep "^\s*- \[ \]" Docs/superpowers/plans/` | 只剩 `2026-10-03-mvp-and-launch.md` 的过期复选框（该文件头部已声明执行态以 backlog 为准） |
| 代码 TODO 扫描 | `grep -rn "TODO\|FIXME\|未实现" apps packages supabase` | 2 条均为**已定口径的说明**，不是漏做：`CustomerDetailDrawer` 的「暂不支持自助恢复」、`finance_applications.sql` 注释里的两级审批写死 |

## 没做什么及原因

- **没有改任何迁移/契约/服务/页面代码** —— 阶段 0 未通过，计划明令「在此之前不动迁移代码」，
  带着残缺依赖写视图层等于白写（无法 typecheck、无法 build、无法跑 E2E）。
- **没有动那 976 条链接** —— 见上，红线。
- **没有把 `rolldown` 实体目录删掉/改成软链** —— 见上，它当前是对的。
- **没有勾/改任何业务卡片** —— 21 项本就全勾，无需改动。

## 下一张

**D2 之后无业务卡片。** 唯一阻塞：`cd D:\Coding\ERP\admin && pnpm install --frozen-lockfile`
（必须用户在自己终端跑）。装好后阶段 0 探针 → 阶段 1（骨架与认证）。
在此之前本自动化的产出上限就是「核对阻塞判据」这一行。
