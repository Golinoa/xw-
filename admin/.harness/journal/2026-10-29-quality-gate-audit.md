# 2026-10-29 前端质量门与测试基建实测审计

## 0. 结论速览

- 当前 worktree 的本地质量门 **不可运行**：`corepack pnpm run quality:check` 在链式第一步即退出 1，11 个分段门禁中只有 4 个能真实跑通（`quality:toolchain`、`test:unit`、`quality:licenses`、`quality:secret-scan`）。
- 失败不是"门禁逻辑写错"，而是**交付环境不完整**，两条根因（均有实测证据）：
  1. 所有 workspace 包的 `dist/` 构建产物为 0，`oxfmt.config.ts` / `oxlint.config.ts` / `eslint.config.mjs` 无法加载配置；
  2. corepack 子进程内 `pnpm` 解析为 **11.24.0**，与 `packageManager: pnpm@10.33.4` 冲突，脚本里的 `pnpm --filter` / `pnpm exec` 全部硬失败。
- Task 2 遗留的 2 条 high advisory 结论已被时间推翻，需更新：
  - `braces` GHSA-vfj7-8cjw-p6xm **已于 2026-10-23 撤回**，今日全锁文件审计中不再出现；
  - `node-forge` GHSA-86w9-cpqp-85rv 仍命中 1.4.0，但 **1.4.2 已于 2026-10-27 发布**，npm 公告接口对该版本不再返回该公告（即存在可清除路径）。
- 但同期审计结果显著恶化：今日 50 条记录 = 7 low / 21 moderate / **20 high / 2 critical**（新增 `tinypool` 2 条 critical、`vite`/`happy-dom`/`vue-i18n`/`@intlify/*`/`zod` 等 high）。Task 2 "绿色 quality:check" 目标在当前锁文件下仍不可能达成。
- 测试基建缺口集中在三处：`apps/web-antd` 0 个测试文件且无 `@vue/test-utils` 依赖；`test:e2e` 是**空跑且 exit 0** 的假绿；无 `playwright.config.*`、无 `@playwright/test`、无浏览器二进制。

## 1. 执行环境

| 项 | 值 | 证据 |
| --- | --- | --- |
| 工作树 | `D:/MYC/Coding/ERP-ops/admin` | 独立 worktree |
| 分支 / HEAD | `feat/ops-console` / `c6facfe9a25d33800bdb898a04f05aa0acad0338` | `git rev-parse --abbrev-ref HEAD`、`git rev-parse HEAD` |
| 工作树状态 | 仅 2 个既有未跟踪文档（`2026-10-29-ops-shell-design.md`、`Docs/ops-api-contract.md`），审计未新增脏文件 | `git status --short` |
| Node | `v24.20.0`（`export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"` 后） | `node -v` |
| 默认 PATH 的 Node | `v22.22.2` | `node -v`（未提升 PATH 时） |
| pnpm（项目内） | `10.33.4`（`corepack pnpm --version`） | 见 §2 负面结论 |
| pnpm（corepack 子进程内） | **`11.24.0`** ← 阻断项 | `corepack pnpm exec sh -c 'pnpm --version'` |
| corepack | `0.35.0` | `corepack --version` |
| OS | Windows 10 Pro，Git Bash | — |
| 实测日期 | 2026-10-29 | — |
| 远端 | `origin https://gitee.com/rainy_morningh/ERP.git`，仅 `refs/heads/main`（`9537579e…`） | `git remote -v`、`GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin` |

审计过程中**未修改任何源码、配置或 lockfile**，未执行 `pnpm install`。唯一写入为本 journal。

## 2. 门禁实测结果表

统一执行形式：

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH" && cd "D:/MYC/Coding/ERP-ops/admin" && corepack pnpm run <script>
```

| # | 检查项 | 命令 | 结果 | 耗时 | 关键输出摘要 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | toolchain（正向） | `corepack pnpm run quality:toolchain` | **通过** | 0.5s | `Toolchain matches Node.js 24.20.0 and pnpm 10.33.4.` |
| 2 | toolchain（负向·Node 22 直跑脚本） | `node scripts/quality/check-toolchain.mjs`（Node 22.22.2） | **按设计硬失败** | 0.4s | stderr：`Node.js 24.20.0 is required; found 22.22.2.`，`EXIT=1` |
| 3 | toolchain（负向·Node 22 + pnpm） | `corepack pnpm run quality:toolchain`（Node 22.22.2） | **按设计硬失败** | <1s | `ERR_PNPM_UNSUPPORTED_ENGINE … Expected version: 24.20.0 / Got: v22.22.2`，`EXIT=1`（`engine-strict=true` 生效） |
| 4 | format:check | `corepack pnpm run format:check` | **失败（环境）** | 1s | `Failed to load configuration file. … Cannot find module '…node_modules\@vben\oxfmt-config\dist\index.mjs'` |
| 5 | lint:check | `corepack pnpm run lint:check` | **失败（环境）** | 1s | `Failed to parse oxlint configuration file. … Cannot find module '…@vben\oxlint-config\dist\index.mjs'` |
| 6 | check:type | `corepack pnpm run check:type` | **失败（环境）** | 1s | `[ERROR] This project is configured to use 10.33.4 of pnpm. Your current pnpm is v11.24.0` |
| 6b | check:type 底层命令（诊断） | `corepack pnpm --filter @vben/web-antd typecheck` | **通过** | 14s | `vue-tsc --noEmit --skipLibCheck` 无错误输出，exit 0 → 证明类型门逻辑本身可用 |
| 7 | test:unit | `corepack pnpm run test:unit` | **通过** | 18s | `Test Files 35 passed (35)` / `Tests 309 passed (309)`，`Duration 14.88s`（另有 1 条 `vi.mock` 非顶层提升警告，非致命） |
| 8 | build:antd | `corepack pnpm run build:antd` | **失败（环境）** | <1s | 同 #6 的 pnpm 版本错误 |
| 8b | build 底层命令（诊断） | `corepack pnpm run build --filter=@vben/web-antd` | **失败（环境）** | 1s | turbo：`@vben-core/design#build: … Corepack invoked pnpm with this version…`，`Failed: @vben-core/design#build`，`0 successful, 4 total` |
| 9 | quality:licenses | `corepack pnpm run quality:licenses` | **通过** | 36s | `License policy passed for 1533 installed packages; 16 exact-version exceptions.` |
| 10 | quality:secret-scan | `corepack pnpm run quality:secret-scan` | **通过** | 3s | 无任何命中输出，exit 0 |
| 11 | quality:bundle-secrets | `corepack pnpm run quality:bundle-secrets` | **失败（无产物）** | 1s | `Cannot inspect web-antd build output at …\apps\web-antd\dist\: ENOENT` |
| 12 | quality:negative | `corepack pnpm run quality:negative` | **失败（环境）** | 4s | `AssertionError: ESLint failed for an unexpected reason`，实际错误为 `Cannot find module '…@vben\eslint-config\dist\index.mjs'`（期望 `/Parsing error | Unexpected token/`）；脚本仍在 `finally` 中清理，`git status` 无 canary 残留 |
| 13 | quality:dependencies | `corepack pnpm run quality:dependencies` | **失败（环境）** | ~1s | 同 #6 pnpm 版本错误，**未真正执行 audit** |
| 13b | audit 底层命令（诊断） | `corepack pnpm --registry=https://registry.npmjs.org audit --audit-level high` | **失败（真实审计结论）** | 未单独计时 | `50 vulnerabilities found` / `Severity: 7 low \| 21 moderate \| 20 high \| 2 critical`，`AUDIT_EXIT=1` |
| 14 | 聚合门禁 | `corepack pnpm run quality:check` | **失败** | 1s | 停在链式第一步 `pnpm run quality:toolchain`，输出即 #6 的 pnpm 版本错误，`QUALITY_CHECK_EXIT=1` |

### 2.1 关于第 3 问：test:unit 到底跑了什么

- 全仓（排除 `node_modules`/`dist`）`*.test.ts` / `*.spec.ts` 共 **35 个**，分布：`packages/@core` 21、`packages/effects` 5、`packages/utils` 4、`packages/stores` 3、`internal/node-utils` 2。
- `apps/web-antd` 下 `*.test.*` / `*.spec.*`：**0 个**（`find apps/web-antd -type f \( -name "*.test.*" -o -name "*.spec.*" \) | wc -l` → `0`）。
- 因此 `test:unit` 跑的是 **shared packages 的上游 Vben 用例**，不是空跑：35 文件 / 309 用例全部通过（与 2026-10-05 记录一致）。

## 3. 环境阻断根因（本次审计最重要的发现）

### 3.1 根因 A：workspace 包 `dist/` 全部缺失（0 个）

```bash
for d in internal/lint-configs/oxfmt-config internal/lint-configs/oxlint-config \
         internal/lint-configs/eslint-config internal/lint-configs/stylelint-config \
         internal/vite-config internal/node-utils internal/tailwind-config \
         packages/utils packages/@core/base/shared packages/effects/request; do
  [ -d "$d/dist" ] && echo "OK $d/dist" || echo "MISS $d/dist"; done
find . -maxdepth 4 -type d -name dist -not -path "./node_modules/*" -not -path "./apps/*" | wc -l
```

输出：上述 10 个抽样包**全部 `MISS`**；包级 `dist` 目录总数 **`0`**。

`node_modules/@vben/oxfmt-config` 等软链接已建立（指向 `internal/lint-configs/*`），但 `dist/index.mjs` 不存在 → 所有 `.config.ts` 加载即失败。根包 `stub` 脚本为 `pnpm exec tsdown`（`internal/lint-configs/oxfmt-config/package.json`），同样受 §3.2 影响。

影响面：`format:check`、`lint:check`、`quality:negative`（ESLint canary）、`build:antd`（vite-config 依赖）、`quality:bundle-secrets`（无 dist）。

### 3.2 根因 B：corepack 子进程内 pnpm 解析为 11.24.0

```bash
corepack pnpm --version                 # 10.33.4  （顶层正常）
corepack pnpm exec sh -c 'pnpm --version'
# [ERROR] This project is configured to use 10.33.4 of pnpm. Your current pnpm is v11.24.0
# Corepack invoked pnpm with this version, and pnpm does not switch versions when running under corepack.
corepack pnpm exec sh -c 'echo $COREPACK_ROOT'
# D:\MYC\A.soft\nodejs-24.20.0\node_modules\corepack
corepack pnpm exec sh -c 'unset COREPACK_ROOT; pnpm --version'
# 10.33.4   ← 反向验证：变量去掉即恢复
```

即：顶层 corepack 会按 `packageManager` 切到 10.33.4；一旦进入 pnpm 生命周期，`COREPACK_ROOT` 使 shim 复用其缓存默认版本 11.24.0，而 pnpm 11 发现 `packageManager: 10.33.4` 不一致后直接拒绝执行。

影响面：`check:type`、`build:antd`、`quality:dependencies`、`quality:check`（全部因嵌套 `pnpm …` 失败），以及 `postinstall` 的 `stub` 步骤（大概率是 §3.1 的成因）。

幂等复现命令：

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"
cd "D:/MYC/Coding/ERP-ops/admin"
corepack pnpm exec sh -c 'pnpm --version'   # 期望 10.33.4，实际报错
```

建议修复（**本次未执行**，仅记录）：`corepack install --global pnpm@10.33.4` 让 shim 默认版本与 `packageManager` 对齐，或改用与声明一致的全局 pnpm 直连（不经 corepack），或在 CI/脚本入口统一 `unset COREPACK_ROOT`；随后重跑 `corepack pnpm install` 让 `stub` 生成各包 `dist/`。

### 3.3 文档与实现不一致（需纠正）

exec-plan 第 241 行记载"Task 2 的本地 `quality:check` 后续在负责人批准的两个精确 dev-only high advisory 临时例外下通过"。实测在 `package.json`、`.npmrc`、`scripts/quality/*` 中**不存在任何 advisory 例外/ignore 机制**：

- `quality:dependencies` = `pnpm --registry=https://registry.npmjs.org audit --audit-level high`（无 `--ignore`、无 audit 配置节）；
- `.npmrc` 仅 `registry` 与 `engine-strict`。

结论：该"通过"在当前代码状态下**不可复现**，应视为记录错误或依赖了未提交的本地配置。

## 4. Task 2 两项遗留的最新事实

### 4.1 advisory 状态（查询日期 2026-10-29）

| 包 | 公告 | GitHub 页面（今日抓取） | npm registry dist-tags | 今日审计是否命中 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `node-forge` | [GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | High（8.7），`Affected <= 1.4.0`，**`Patched versions: None`**，Published 2026-09-03，Reviewed/Updated 2026-10-01 | `{"latest":"1.4.2"}` | 命中（路径 `internal__vite-config>nitropack>listhen>node-forge`，锁定 1.4.0，npm 侧 `patched <0.0.0`） | **有新的干净版本 1.4.2**（`node-forge@1.4.2` 元数据发布时间 `2026-10-27T14:09:15Z`）。公告页仍写 `Patched None`，但受影响区间不含 1.4.2 |
| `braces` | [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | **Withdrawn Advisory —— 2026-10-23 撤回**（原文："withdrawn because it's not a practically exploitable vulnerability"），Updated 2026-10-23 | `{"latest":"3.0.3"}` | **不再命中**（今日审计输出中已无 `braces`） | 遗留项自然消解，无需升级（3.0.3 仍是最新版） |

交叉验证（直接问 npm 公告接口，返回即为"受影响"）：

```bash
curl -s -X POST "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk" \
  -H "Content-Type: application/json" \
  -d '{"node-forge":["1.4.0","1.4.2"],"braces":["3.0.3"]}'
# → 仅返回 node-forge 一条，vulnerable_versions "<=1.4.0"；1.4.2 与 braces 3.0.3 均无返回
```

即：两条 high 中，`braces` 已撤回；`node-forge` 可通过升级到 1.4.2 清除（`pnpm why -r node-forge` 显示依赖链仅 `@vben/vite-config → nitropack@2.13.4 → listhen@1.10.0`，属开发 mock 工具链，`^1.x` 范围内可升级）。

**但 Task 2 的"绿色 `quality:check`"依然不成立**，因为同一份今日审计新增了更严重的问题（50 条记录）：

| 严重度 | 包（示例路径） | 受影响的锁定版本 | 已发布修复 |
| --- | --- | --- | --- |
| critical ×2 | `tinypool`（`.>oxfmt>tinypool`） | 2.1.0 | `>=2.1.1` / `>=2.1.2` |
| high | `vite`（`.>vite`） | 8.3.2 | `>=8.3.3` |
| high | `happy-dom`（`.>happy-dom`） | 20.9.0 | `>=21.0.4` |
| high | `vue-i18n` / `@intlify/core-base` / `@intlify/shared`（`packages__locales`） | 11.4.4 | `>=11.4.14` |
| high | `follow-redirects`（`packages__effects__request>axios>…`） | — | `>=1.16.1` |
| high | `source-map-js`、`undici`、`@vue/server-renderer`、`zod` | — | `>=1.2.2` / `>=7.30.1` / `>=3.5.42` / `>=4.6.6` |
| high | `node-forge` | 1.4.0 | 公告记 `None`，实际可用 1.4.2 |

版本取自 `pnpm-lock.yaml`（`vite@8.3.2`、`happy-dom@20.9.0`、`vue-i18n@11.4.4`、`tinypool@2.1.0`、`node-forge@1.4.0`、`braces@3.0.3`、`zod@3.25.76` / `4.4.3`）。

### 4.2 第 5 问：`--audit-level high` 会让 `quality:check` 整体失败吗

- 结构上会：`quality:check` 用 `&&` 串联，最后一段是 `pnpm run quality:dependencies`，任何非零退出都会使整体退出非零。
- 实测：`corepack pnpm --registry=https://registry.npmjs.org audit --audit-level high` → `AUDIT_EXIT=1`（20 high + 2 critical），确实触发失败语义。
- 但当前实际现象更早失败：`corepack pnpm run quality:dependencies` 根本没跑到 audit，先被 §3.2 的 pnpm 版本冲突挡下；`quality:check` 更是停在第一步。**"audit 失败是否会拖垮整体"这一因果链在当前环境无法端到端观察，只能凭脚本结构 + 单独 audit 退出码推断**，已如实标注（见 §7）。

### 4.3 第 6 问：托管 CI 与分支保护在 Gitee 上的可行性

- 远端实测可达：`GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin` → `9537579e… refs/heads/main`，即远端只有 `main`，`feat/ops-console` 未推送，也无任何 PR 记录可查。
- `.github/workflows/frontend-quality.yml` 是**纯 GitHub Actions 描述**：`on: pull_request / workflow_dispatch`、`permissions`、`concurrency`、`actions/checkout@v6`、`pnpm/action-setup@v6`、`actions/setup-node@v6`、`actions/upload-artifact@v4`、`${{ github.event.pull_request.number }}`。Gitee 不会执行 `.github/workflows`，这些 action 在 Gitee 侧也不可用。
- Gitee 的等价能力是 **Gitee Go 流水线**，配置文件位于仓库 `.workflow/` 目录、使用自有 YAML schema（`stages`/`step`/`task` 等），字段与 GitHub Actions 不兼容；仓库中当前**没有 `.workflow` 目录**（`ls -d .workflow` → 无）。
- 等价方案（需在 Gitee 侧实施，本次未做）：
  1. 新建 `.workflow/frontend-quality.yml`，把步骤改写为 Gitee Go 的 task（Node 环境准备 → `corepack enable` → `pnpm install --frozen-lockfile` → `node scripts/quality/check-toolchain.mjs` → `pnpm run quality:check`），产物改用 Gitee Go 的 `artifact` 上传；
  2. 或在 Gitee 仓库挂接外部 CI（自建 runner/Jenkins）跑同一 `quality:check` 命令，Gitee 只负责触发与回写状态。
- "workflow 文件存在 ≠ 分支保护已启用"的验证方式：
  - 文件层面只能证明配置文本存在（本仓库已用 `verify-quality-gates.mjs` 校验其无 `secrets.*` 与额外 env）；
  - 生效层面必须登录 Gitee 仓库 →「管理 / 设置 → 分支设置（保护分支）」确认 `main` 已开启保护并勾选对应的检查/审查要求，然后**发起一次真实 PR**，观察该检查是否作为必需项阻断合并；
  - 这一步需要仓库管理权限与网络写操作，本次**未验证**（见 §7）。

## 5. 测试基建缺口清单（支撑 Task 3+）

### 5.1 第 7 问：组件测试

现状：

- `apps/web-antd`：`*.test.*` / `*.spec.*` **0 个**；`package.json` 只有 `build` / `build:analyze` / `dev` / `preview` / `typecheck`，**没有 `test` / `test:unit` 脚本**。
- 根 `vitest.config.ts` 已具备：`@vitejs/plugin-vue`、`@vitejs/plugin-vue-jsx`、`environment: 'happy-dom'`、`happyDOM.settings.handleDisabledFileLoadingAsSuccess`，`exclude` 仅排除 `e2e`、`dist`、IDE 临时目录、`node_modules`、各 lint/formatter 配置。
- 依赖现状：`@vitejs/plugin-vue`（根 devDeps，catalog `^6.0.7`）✅；`happy-dom`（根 devDeps）✅；`@vue/test-utils`（catalog `^2.4.10`）**仅被 `packages/effects/common-ui` 引用**，`apps/web-antd` 无法解析（根 `node_modules/@vue` 为空目录）。

缺口与动作：

| 缺什么 | 具体内容 | 是否必需 |
| --- | --- | --- |
| 依赖 | 在 `apps/web-antd/package.json` devDependencies 增加 `"@vue/test-utils": "catalog:"` | 组件挂载测试必需 |
| 脚本 | 在 `apps/web-antd/package.json` 增加 `"test:unit": "vitest run --dom"`（可选，便于单包运行） | 建议 |
| 测试文件 | `apps/web-antd/src/**/*.test.ts`（如 `api/__tests__/`、`store/__tests__/`、`views/**/__tests__/`） | 必需 |
| 配置 | **无需新增**：根 `vitest.config.ts` 已含 Vue 插件与 happy-dom，且未限定 `root`/`include`，可覆盖 app | — |

### 5.2 第 8 问：Playwright e2e

现状实测：

- `playwright.config.*`：**不存在**（根与 `apps/*` 均无）。
- 已安装：`node_modules/playwright@1.60.0`（库，不是测试运行器）；**`@playwright/test` 未安装**（`ls node_modules/@playwright` → 不存在）；`@playwright/test` 仅作为 catalog 条目 `^1.60.0` 存在，无任何 `package.json` 引用。
- 浏览器二进制：`~/AppData/Local/ms-playwright` 为空 → 未下载。
- `turbo.json` 有 `"test:e2e": {}` 任务定义，但**没有任何包定义 `test:e2e` 脚本**。实测：

```bash
corepack pnpm run test:e2e
# • turbo 2.9.14
# • Running test:e2e in 38 packages
#  WARNING  No tasks were executed as part of this run.
#  Tasks:    0 successful, 0 total
# TURBO_EXIT=0
```

**这是一个假绿陷阱：命令 exit 0、0 个任务被执行**。若未来把 `test:e2e` 接进 `quality:check` 或 CI，会得到"通过"的假象。Task 3 的"Playwright 验证登录允许/拒绝"目前完全不可执行。

达到可执行的缺口：

| 类别 | 缺什么 |
| --- | --- |
| 包 | `@playwright/test`（catalog 已有 `^1.60.0`，需在根或 `apps/web-antd` devDependencies 落地）；浏览器二进制（`pnpm exec playwright install --with-deps chromium`） |
| 配置文件 | 根或应用级 `playwright.config.ts`：`testDir: './e2e'`、`use.baseURL: 'http://localhost:5666'`（`apps/web-antd/.env.development` 中 `VITE_PORT=5666`）、`webServer: { command: 'pnpm -F @vben/web-antd dev', url: 'http://localhost:5666', reuseExistingServer: !process.env.CI }`、`trace/screenshot` 策略、CI 下 `retries` |
| 用例目录 | `apps/web-antd/e2e/`（或根 `e2e/`）。注意根 `vitest.config.ts` 已 `exclude: ['**/e2e/**']`，不会与 Vitest 冲突 |
| 脚本 | `apps/web-antd/package.json` 增加 `"test:e2e": "playwright test"`，`turbo run test:e2e` 才会真正调度；建议同时给根加 `"test:e2e:antd": "pnpm -F @vben/web-antd test:e2e"` |
| 被测前置 | 登录用例需要真实/契约化的认证后端；当前 `.env.development` 指向 `VITE_NITRO_MOCK=true` 且 `vite.config.ts` 代理 `/api → http://localhost:5320/api`，而 `@vben/backend-mock` 未在工作区中（见 Task 2 journal 记录）→ 需 Task 3 的 API adapter/登录流程就位 |
| 数据 | 依 `.harness/TESTING_STANDARDS.md` 使用虚构客户/合同/收款 fixture，禁止真实凭证 |

### 5.3 第 9 问：`quality:check` 是否覆盖 `apps/web-antd` 的测试

- 覆盖判定的依据：`quality:check` → 根 `test:unit` = `vitest run --dom`，工作目录为仓库根，`vitest.config.ts` 未设置 `root` 或 `include`，因此沿用 Vitest 默认 `include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)']`；`exclude` 明确排除的只有 `e2e`、`dist`、`{idea,git,cache,output,temp}`、`node_modules`、`{stylelint,eslint}.config.*`、`{oxfmt,oxlint}.config.*`——**`apps/` 不在排除项内**。
- 实测佐证：`vitest list --dom` 收集到的文件跨越 `packages/` 与 `internal/` 两个顶层目录（`packages/@core/...`、`packages/utils/...`、`internal/node-utils/...`），说明扫描根确为仓库根而非某个子包。
- 结论：**结构上覆盖 `apps/web-antd`，但当前实际覆盖为 0**（无测试文件）。本项未通过"新增一个 app 测试文件观察是否被收集"来实证——审计为只读，不得向工作树写入文件（见 §7）。

## 6. 阻断项与建议（按严重度）

| 级别 | 问题 | 影响 | 建议（未执行） |
| --- | --- | --- | --- |
| **P0** | corepack 子进程 pnpm = 11.24.0，与 `packageManager 10.33.4` 冲突 | `quality:check`、`check:type`、`build:antd`、`quality:dependencies` 全部无法运行；`postinstall` stub 失败 | `corepack install --global pnpm@10.33.4` 或改用匹配的全局 pnpm；在 CI 脚本入口规避 `COREPACK_ROOT` 污染；修复后 `pnpm install` 重生成 `dist/` |
| **P0** | workspace 包 `dist/` 为 0 个 | `format:check`、`lint:check`、`quality:negative`、`build` 无法运行 | 修好 pnpm 后执行 `pnpm -r --filter './internal/**' --filter './packages/**' run stub --if-present`（即 `postinstall` 等价步骤），并纳入安装验收 |
| **P1** | 全锁文件审计 20 high + 2 critical（`tinypool`、`vite`、`happy-dom`、`vue-i18n`/`@intlify/*`、`follow-redirects`、`source-map-js`、`undici`、`@vue/server-renderer`、`zod`、`node-forge`） | Task 2 的绿色目标不可达 | 按 `patched versions` 逐项升级；`node-forge` 升 1.4.2 可清除本条；`braces` 无需处理（公告已撤回）；升级后重跑 audit 与完整门禁 |
| **P1** | `test:e2e` 空跑且 exit 0 | 假绿，CI 会显示通过但零覆盖 | 补 `@playwright/test` + `playwright.config.ts` + `e2e/` + 包级 `test:e2e`；在 `turbo.json` 给该任务加 `outputs`/`cache` 策略，并在 CI 中显式断言执行了 ≥1 个用例 |
| **P1** | `apps/web-antd` 0 测试、缺 `@vue/test-utils` | 组件测试无法起步 | 加依赖 + 建测试目录；先在根 `vitest.config.ts` 保持现状即可 |
| **P2** | `.github/workflows/frontend-quality.yml` 在 Gitee 不执行 | 无托管门禁，无分支保护 | 迁移为 `.workflow/*.yml`（Gitee Go schema）或接外部 CI；在 Gitee 设置里启用保护分支并用真实 PR 验证 |
| **P2** | exec-plan 第 241 行"临时例外已通过"与代码不一致 | 记录不可复现 | 修正文档，或把例外机制（如需）显式落到 `scripts/quality/` 并留审计痕迹 |
| **P3** | `quality:dependencies` 强制走官方 registry，未跟随 `.npmrc` 镜像 | 内网/镜像环境可能的网络失败 | 保持现状（设计如此），但在 CI 文档中写明出网要求 |

## 7. 未验证项（明确"没跑"，不得视为通过）

1. **`build:antd` 的真实构建结果**：被 §3.2 阻断；底层 `turbo build --filter=@vben/web-antd` 也在 `@vben-core/design#build` 因 pnpm 版本失败（`0 successful, 4 total`），未产出 `apps/web-antd/dist`。
2. **`quality:bundle-secrets` 的真实扫描结论**：无 `dist/`，脚本以 `ENOENT` 失败，未扫描任何文件。
3. **`format:check` / `lint:check` 的真实格式与规则结论**：配置包 `dist` 缺失导致**配置加载阶段**即失败，未对任何源码做出判定。
4. **`quality:negative` 的完整通过**：ESLint canary 因配置缺失而"以错误的原因失败"，脚本断言未通过；typecheck / secretlint / license / toolchain / workflow 五项 canary 在此次运行中**未被执行到**（脚本在第 76 行抛出）。历史上（2026-10-05）该项曾完整通过，但那是另一环境状态。
5. **`quality:dependencies` 作为 npm script 的退出码语义**：脚本形式被 pnpm 版本冲突拦截；audit 结论来自等价的直接命令 `corepack pnpm --registry=… audit --audit-level high`，两者命令体一致但**不是同一次进程**。
6. **`quality:check` 端到端串联**：未观察到"逐个门禁顺序执行后由 audit 决定最终退出码"的完整链路。
7. **托管 CI 与分支保护**：Gitee 侧未创建 `.workflow`、未触发流水线、未在仓库设置中开启保护分支、未发起真实 PR。`git ls-remote` 只能证明远端存在且仅有 `main`。
8. **Playwright 实际执行**：无配置、无 `@playwright/test`、无浏览器二进制，未运行任何 e2e 用例。
9. **组件测试可运行性**：未创建任何 app 测试文件（只读约束），因此"根 vitest 会收集 `apps/web-antd`"仅由配置与扫描范围推断，未以真实用例实证。
10. **`pnpm why` 之外的依赖树细节**：`braces` 仍存在于 `micromatch` 依赖树中（`pnpm why -r braces` 输出多条路径），只是不再被审计报告。

## 8. 复现命令清单

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"
cd "D:/MYC/Coding/ERP-ops/admin"

# 工具链正向 / 负向
corepack pnpm run quality:toolchain
node scripts/quality/check-toolchain.mjs        # 在 Node 22 下运行 → exit 1

# 逐项门禁（当前环境的真实结果见 §2）
corepack pnpm run format:check
corepack pnpm run lint:check
corepack pnpm run check:type
corepack pnpm run test:unit
corepack pnpm run build:antd
corepack pnpm run quality:licenses
corepack pnpm run quality:secret-scan
corepack pnpm run quality:bundle-secrets
corepack pnpm run quality:negative
corepack pnpm run quality:dependencies
corepack pnpm run quality:check

# 诊断（绕过嵌套 pnpm）
corepack pnpm --filter @vben/web-antd typecheck
corepack pnpm exec sh -c 'pnpm --version'
corepack pnpm --registry=https://registry.npmjs.org audit --audit-level high

# 公告状态
curl -s -X POST "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk" \
  -H "Content-Type: application/json" \
  -d '{"node-forge":["1.4.0","1.4.2"],"braces":["3.0.3"]}'
```

## 9. 与 2026-10-05 记录的差异

| 项 | 2026-10-05 记录 | 2026-10-29 实测 |
| --- | --- | --- |
| 审计结果 | 4 moderate / 2 high / 0 critical（6 条） | **7 low / 21 moderate / 20 high / 2 critical（50 条记录）** |
| `braces` high | 存在，无修复版本 | **公告 2026-10-23 撤回，不再命中** |
| `node-forge` high | 存在，latest = 1.4.0，无可用修复 | 仍命中 1.4.0；**1.4.2 已于 2026-10-27 发布，可清除** |
| `quality:check` | 前 10 段通过，最终 audit 失败 | **第 1 段即失败（pnpm 版本冲突）**，前 10 段无法串联执行 |
| Vitest | 35 files / 309 tests | 一致（35 / 309），但**其中 app 用例为 0** |
| 托管 CI | 无 remote，未验证 | 有 Gitee remote（仅 `main`），但 `.github/workflows` 在 Gitee 不执行，**仍未验证** |
| 依赖安装状态 | 假定 `stub` 已生成各包 `dist` | **实测 0 个包有 `dist`**，安装未完成 |
