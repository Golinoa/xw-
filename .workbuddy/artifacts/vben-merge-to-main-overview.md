# Vben 新后台合入主仓 — 交付说明

## 做了什么

用户指出根仓本来就有 GitHub remote（`Golinoa/xw-`），纠正了"需建独立仓库"的判断。
按用户选择「合入主分支目录」，把 Vben 新后台从独立副本合入主仓 `admin-clean/` 子目录，并提交到本地主仓。

## 关键决策与改动

| 项 | 处理 |
|---|---|
| 提交 | 主仓 `d69c191`，1177 文件 / 117259 行 |
| `.gitignore` | 去掉 `/admin-clean/` 排除；子目录自身继续排除 node_modules/dist/test-results/.turbo |
| 内嵌 `.git` | 从 `admin-clean/` 移走并备份，避免被当成 submodule（gitlink）导致源码不入仓 |
| 上游死 workflow | 子目录排除 14 个（12 个被 `vbenjs/vue-vben-admin` 守卫锁死，`build.yml` 有 `pull_request_target` 权限风险） |
| CI workflow | 迁到根 `.github/workflows/web-antd-build.yml`，所有路径适配子目录，pnpm 命令加 `working-directory: admin-clean`，加 `paths` 过滤 |

## 验证

- typecheck（新子目录位置）：EXIT=0，零错误
- workflow YAML 可解析，引用路径全部存在
- 暂存区 1175 个源码文件，gitlink=0，无 node_modules/dist/test-results 混入
- `.env*` 全是占位值，无真实密钥

## 备份

- `admin-clean/.git` → `.workbuddy/backups/admin-clean-git-backup-20261125/`
- 原 workflow → `.workbuddy/backups/web-antd-build.yml.bak`

## 后续事项

1. **尚未 push**：提交只在本地，需 `git push github main` 才会进 GitHub、触发 CI。
2. **CI 未实跑**：workflow 结构验证通过，但 GitHub Actions 未实际运行过；且 workflow 不含 E2E job。
3. **本机 E2E teardown 卡死**：9 条用例执行完无失败，但拿不到 passed 汇总，属本机 Chrome/Vite 进程句柄问题，非页面代码。
4. **范围外遗留**：合入带入 upstream ops 时代 `.harness/` 历史文档约 40 篇（不影响构建）；
   用户原有的 `scripts/`（16 个预览工具）、两篇 journal、memory 改动仍未提交，本次未动。
