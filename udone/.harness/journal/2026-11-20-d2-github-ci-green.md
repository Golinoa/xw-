# 2026-11-20 D2 收官：GitHub Actions 首次真跑，全绿

**验收条件**：D2 卡片写的是「必须看到流水线真实跑过并留下结果」，不是「写完 yml」。

## 证据

- 仓库：`https://github.com/Golinoa/xw-`（用户新建，public，默认分支 main）
- 工作流：`.github/workflows/ci.yml`，GitHub 自动识别（API 显示 1 条 active workflow）
- 运行：**#5 / `44675102215`**，提交 `9b8ffd2`，**Success，1m29s**
  - 质量门禁：1m21s，通过（含 format / lint / typecheck / test / build / schema:check /
    check:deploy / deps:audit / licenses:check / secrets:check / secrets:canary:check）
  - 前端 E2E（Playwright）：1m25s，通过
  - 链接：https://github.com/Golinoa/xw-/actions/runs/44675102215
- 仅剩两条 warning：actions 内部 target Node 20，被 runner 强制 Node 24 运行，不影响结论。

## 从 #1 红到 #5 绿，三次真实缺陷

1. **#2 格式检查 exit 2**：`.github/workflows/ci.yml` 自身三处单引号不符合 Prettier → `56d45ca`
2. **#3/#4 格式检查 exit 2**：`udone/package.json` 里残留 `".github/**/*.{yml,yaml}"`，
   但 `udone/.github/` 早已不存在；Prettier 对不匹配路径直接报错，本地一直没跑过
   `pnpm format:check` 所以没暴露 → `a2d54cd`
3. **#4 许可证策略 exit 1**：Linux 专用可选包 `@img/sharp-libvips-linux-x64@1.3.4`
   是 `LGPL-3.0-or-later`，白名单没有；Sharp 经 miniflare 进入，属开发构建工具链。
   **用户明确批准**精确开发期例外（不随应用分发）→ `9b8ffd2`

## 关键机制差异（以后别再踩）

- Gitee Go：`.workflow/*.yml` 只是描述，不会自行注册；必须网页端手动建流水线对象。
  该仓库开通后仍没生成对象，所以 Gitee 侧从未跑过。
- GitHub Actions：`.github/workflows/*.yml` 随 push 自动发现并触发，无需网页操作。
- GitHub 匿名 API 60 次/小时，查状态改用网页版 WebFetch + cachebust 查询参数。
- 本机 pnpm 被 `_tmp_*` 残片卡住，`pnpm format:check` / `deps:audit` / `licenses:check`
  无法本地直跑；判 CI 格式问题必须按 `git -c core.autocrlf=false -c core.eol=lf archive HEAD`
  解包后跑 Prettier（解包用 `tar --force-local`）。

**结论：D2 勾选成立。业务端 15 项计划全部完成。**
