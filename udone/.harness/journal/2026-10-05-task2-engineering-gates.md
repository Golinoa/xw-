# 2026-10-05 Task 2：Harness 代码风格、依赖和 CI 门禁

## 今日完成

- 复核计划、最近提交与现存 WIP；Task 1 以 `3e268c6` 为最新完成提交，Task 2 已开始。保留未提交的 Ant Design Vue、页面、设计规范和 lockfile 改动。
- 基线盘点：42 个 TypeScript 文件、3 个 Vue SFC、4 个 SQL migrations；没有 formatter/linter 配置和脚本。
- 新增 `tests/tooling/harness-config.test.ts`，首次运行 `pnpm vitest run tests/tooling/harness-config.test.ts`，观察到 3/3 预期失败：缺少工程 scripts、Prettier ignore 与 CI workflow。
- 对当前工作树的 `pnpm-lock.yaml` 运行 `pnpm audit --registry=https://registry.npmjs.org --json`。npm 官方 registry 报告 `vitest@3.2.7` / `@vitest/mocker` 同一个 GHSA-82fw-gwwq-j7x9 moderate advisory；当前 lockfile 不含 `braces` 或 `node-forge`。默认镜像 registry 的 audit endpoint 不兼容，因此明确改用官方 registry。

## 关键决策

- 保留当前 Ant Design Vue/lockfile WIP，只叠加 Task 2 工具依赖，不用 Git 回滚或全量格式化改写它。
- 不添加 `braces`、`node-forge` overrides：fresh lockfile/advisory scan 中这两个包不存在；Vitest advisory 有官方修复版本 4.1.11，先验证兼容性并考虑升级工具版本。
- 计划 Step 1–2 已按基线与 RED 证据勾选。CI 分支保护配置属于仓库 hosting 设置，不由 YAML 自动启用；需记录精确推荐与未核实的 owner 设置。

## 遇到的问题

- `pnpm audit` 默认走当前配置的 npm 镜像，返回 audit endpoint 不存在；指定 `--registry=https://registry.npmjs.org` 后得到官方审计结果。
- 当前 lockfile 基线和历史已知“4 moderate + 2 high including braces/node-forge”的报告不一致。该旧汇总不能视作本次当前状态；本轮的审计结果和已验证 advisory 链接优先。

## 下一步计划

- 取得负责人对 `scripts/license-policy.json` 六组 pending 许可证表达式的逐项意见；未获批准前策略保持阻断。
- 由仓库负责人启用并读取回 `main` 的 PR、CI required checks、分支最新、禁止 force-push/bypass 规则；GitHub Actions 实际成功/失败日志仍需远端验收。
- 满足以上门禁后完成 Task 2 Step 8；在此之前不提交本批、不进入 Task 3。

## 续记（2026-10-05）

### 今日完成

- 完成并本地验证 formatter/linter/SQL formatter、Zod、依赖审计、许可证门禁、Secretlint 与 canary、CSS token 校验、schema inventory 生成器及 CI workflow。冻结安装、format/SQL format、lint、typecheck、62 项测试、build、deploy config、依赖审计、secret scan/canary、schema check 均通过；本地 Supabase pgTAP 3 个文件、35 项测试通过。
- Schema inventory 包含 4 migrations、4 tables、5 functions、2 indexes、14 policies、0 triggers；连续生成的 SHA256 均为 `7367220B4B2CF9A7BCE9B39D5DA08036E1242724BC5C99AC247DF1323AC77D43`。
- 当前锁文件审计为 0 advisories；Vitest 更新到官方修复版本 4.1.11。当前锁文件不包含历史报告中的 `braces` 和 `node-forge`，未加 overrides。
- 将 Task 2 Step 3–8 的完成证据写回活跃计划，并创建 SDD progress ledger。对预先存在的 Ant Design Vue 页面、组件、package manifest 与 lockfile WIP 做临时快照；本次 Task 2 暂存内容使用 Element Plus 基线上的格式化版本和独立 Task 2 依赖变更，未暂存 Ant Design 页面或依赖切换。
- Task 1 记录更正已单独提交（`fd83b39`）；Task 2 门禁已单独提交。提交前核对 staged path 和 lockfile 不含 Ant Design Vue 依赖或页面实现；提交后恢复的 11 个前端/lockfile WIP 文件与快照 SHA256 一致。

### 关键决策

- 按用户明确委托，仅批准 `scripts/license-policy.json` 中当前 11 个精确 dev-tool package/version/license 组合，均限定在原记录的开发工具用途；未把这些表达式加入全局 allowlist。批准人记为 Project owner（explicit user delegation），日期 2026-10-05。策略把 package/version/license 变化、其他同许可证包及任何进入 production dependency tree 的例外视为失败；批准是窄范围工程依赖策略，不是法律意见。
- 再分发义务逐例记录：保留上游 license text/notices；CC-BY 需 attribution 与许可声明；包含 LGPL 的 sharp optional package 在任何打包/再分发前单独审查 source/relinking/notices 要求。本任务未将这些工具依赖纳入应用打包批准。
- `main` 推荐要求 PR、CI required checks 成功、分支保持最新，并禁止 force-push 与 bypass。远端设置未读回，GitHub Actions workflow 未实际运行；本计划只要求记录设置方案，因此远端状态作为环境限制记录，不阻断本地验收。
- Task 2 基线构建主 JavaScript chunk 约 1.25 MB（约 397 KB gzip）；恢复 Ant Design Vue WIP 后重新构建主 chunk 约 1.75 MB（约 532 KB gzip），均有 500 KB 提示。作为后续 bundle 优化事项记录，不扩展为本任务重构。
- Task 2 期间未对 staging/production 执行写入；WSL 本地 Supabase 仅启动临时 Postgres/Auth，pgTAP 通过后正常停止并保留 Docker volume。

### 遇到的问题

- 在收到明确委托前，`pnpm licenses:check` 因六组 pending 许可证表达式退出失败；收到委托后将其更新为精确 package/version exceptions，并验证 current inventory 全部通过。负向回归确认未知包、版本变化及生产依赖树使用都会失败。
- Task 2 工作中启动 Supabase CLI 状态检查时，CLI 在工具输出中打印了共享本地开发栈默认凭证。它们不是 staging/production 凭证，未保存进文件、提交或此日志；但这不符合最初“凭证不进工具输出”的要求，因此本续记不重跑会展示该值的命令，也不复述凭证。
- GitHub Actions 远端执行记录和实际 branch protection readback 不可用；活跃计划 Step 7 要求配置 CI workflow 并记录 branch protection 设置建议，已由本地命令复跑、workflow regression test 和本日志覆盖。远端状态仍明确记为未核实。

### 下一步计划

- Task 2 精确范围已提交；Task 1 记录修正单独提交为 `fd83b39`。
- 临时隔离的前端 package、lockfile、页面和 token 文件均已恢复；11 个文件快照 hash 一致；重新冻结安装后 Ant Design Vue 工作区依赖正常。
- Task 2 Step 1–8 验收通过后停止；Task 3 尚未开始。
