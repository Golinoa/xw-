# 工程工作流约束

- `~admin` 保留 Vben 官方 workspace 结构和 pnpm lockfile；按 `Docs/TECH_SELECTION.md` 锁定运行时版本和上游 commit。
- `~admin` 与 `udone` 是并列工程，不假设共享 package workspace；依赖放在实际使用它的应用包，避免第二份锁文件和不必要的工具链。
- 新依赖先核对用途、维护状况、许可证、包体/运行时影响和安全公告。MIT 上游许可保留在代码副本中；不因模板 MIT 推断其所有间接依赖均是 MIT。
- 本地环境、staging、production 明确区分；构建时公开配置与 Worker secrets 分离。不得在前端 bundle 暴露 service key 或存储凭证。
- 前端独立部署，API/DB 改动在 `udone` 仓库由其迁移/发布流程维护；上线前核对 CORS origin、Auth 配置、API 环境和数据库迁移目标。
- 对改动执行适用 typecheck、测试和构建；涉及权限/RLS/迁移执行数据库测试；涉及实际 Worker 集成需要真实环境验收并报告。
- 只有存在无生产凭证可运行的自动化时，才宣称 CI 强制执行质量门；lint、格式、依赖安全或迁移门未安装时不得写成已自动执行。
- 保留无关工作区 WIP；不批量格式化、不改写上游模板历史，不未经授权重置远程环境。

## 前端可复现门禁

- 本仓库只接受 `.node-version`、根 `packageManager` 与 `engines` 声明的 Node.js `24.20.0` 和 pnpm `10.33.4`。`.npmrc` 启用 `engine-strict`；`preinstall` 与 CI 安装前都运行 `scripts/quality/check-toolchain.mjs`。
- 从干净 checkout 使用已记录的 workspace filter 和 `--frozen-lockfile` 安装。根入口 `pnpm run quality:check` 顺序运行格式、应用 lint、类型、单测、`web-antd` 构建、许可证、secret、构建产物检查、负向门禁验证及锁文件依赖审计。
- 依赖审计以官方 npm audit endpoint 查询完整锁文件；达到 high 或 critical 即失败，不忽略 registry 错误、不自动升级。镜像源缺少 audit endpoint 时通过命令级 registry 覆盖运行，保留原 `.npmrc` 镜像配置。
- 许可证 allowlist 与精确版本例外保存在 `license-policy.json`。拒绝项、未知项、许可证变化、例外版本变化或失效例外都会失败；新增例外必须记录许可证、审阅日期和适用原因，不使用全局包名豁免。
- Secretlint 扫描仓库含隐藏文件的文本内容，忽略依赖、构建产物和 lockfile；另检查 `web-antd` 构建文件及 source map 的服务端凭证标记。PR workflow 不引用 `secrets.*`，不声明额外环境变量，不执行数据库或部署写入，只在全门禁通过后上传短期预览 artifact。
- GitHub 分支保护的 required check 名称为 `Frontend Quality / frontend-quality`。workflow 文件不会自动启用分支保护；须在代码托管设置中单独启用并用真实 PR run 验证。
- Lefthook pre-commit 运行 app 范围的 lint、格式和 typecheck；不要让已知全仓 Markdown 格式基线阻断前端源文件提交。
- 当前 PR workflow 尚无托管平台执行记录；锁文件含 high/critical advisories 时，CI 必须保持失败，不得以跳过检查或静态 workflow 文件存在宣称通过。

## CI 平台说明（2026-10-29）

- 远端是 Gitee（`https://gitee.com/rainy_morningh/ERP.git`）。**Gitee 不执行 `.github/workflows/`**：该目录下的 GitHub Actions 文件只作为 GitHub 侧资产保留（若仓库将来镜像到 GitHub 仍可复用），在 Gitee 上既不会触发，其中的 `actions/*`、`pnpm/action-setup`、`${{ github.* }}` 表达式也不可用。
- 等价流程写在**仓库根** `.workflow/frontend-quality.yml`，用 Gitee Go 的 schema（`version` / `triggers` / `stages` / `step: npmbuild@1` + `inputs.goals`），与同目录既有 `ci.yml`（udone 门禁）、`release-udone.yml`、`release-admin.yml`（tag 发布）并列，互不重叠。
- 位置是硬约束：Gitee Go 只读取仓库根目录的 `.workflow/`，放在 `admin/.workflow/` 等子目录等于没有流水线。若将来前端拆成独立仓库，该文件需随之落到新仓库根。
- 本仓库为单仓双组件（`admin/` + `udone/`），因此前端流水线的 `cd admin` 与 `pnpm install` 作用域都指向 `admin`，不要把它误当成仓库根依赖清单。
- 两条流水线的边界：`.github/workflows/frontend-quality.yml`（GitHub 语法，不被 Gitee 执行）与 `.workflow/frontend-quality.yml`（Gitee Go 语法，实际生效路径）。改动门禁步骤时**两处都需要同步**，否则会出现「Gitee 绿 / GitHub 红」或反之的假象。
- 文件存在 ≠ 门禁生效：分支保护与必需检查必须在 Gitee 仓库设置里单独启用，并用真实 PR 验证；在此之前不得声称"CI 已强制"。
