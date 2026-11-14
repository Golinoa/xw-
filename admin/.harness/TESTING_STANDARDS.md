# 测试约束

- 纯领域规则、格式化、状态转换、API 输入映射和 UI 单元逻辑用快速单元/契约测试。
- Hono 鉴权、运营权限、接口错误和命令幂等在后端集成测试；RLS、grants、约束和事务必须使用 PostgreSQL 数据库测试验证，mock 不能证明 RLS。
- Playwright 覆盖关键用户流程：运营登录拒绝/允许、客户合同、分次收款、授权审批和同步、私有化台账、售后工单。
- 每个变更按风险覆盖正常、非法输入、缺失/过期身份、权限拒绝、冲突/重复提交和依赖失败场景。
- 前端测试显式验证 loading、empty、error、validation、permission-denied 和 destructive-confirm 状态。
- 使用可重复的虚构客户、合同、授权和收款数据；禁止真实个人/支付/生产信息进入 fixture。
- 测试应断言外部可见行为和安全不变量，不依赖 arbitrary sleep；用可控时钟或明确状态等待。
- 报告具体运行命令、环境和结果。构建/typecheck 不等于运行时验收；mock API 不等于真实 Supabase/RLS 验收。
- 不设置未经同意的全仓覆盖率百分比；变化风险由测试矩阵说明，后续如新增阈值需说明口径与执行命令。
- 前端静态门禁使用固定 Node/pnpm 版本，运行 `pnpm run quality:check`：含 `web-antd` 格式、Oxlint/ESLint/Stylelint、Vue typecheck、Vitest、生产构建、许可证、secret、构建产物和完整 lockfile audit。
- `pnpm run quality:negative` 临时制造 lint 解析错误、TypeScript 类型错误、虚构 secret 与未批准许可证，并断言各自命令非零退出；同时验证不兼容 Node/pnpm 版本及 PR workflow secret/environment 白名单会被拒绝。canary 在 `finally` 中清理，不留在仓库。
- P0 业务流程 Playwright、真实 Auth/API、PostgreSQL/RLS 和 staging 验收属于后续业务任务；本地前端质量门与 Vben 模板单测不替代这些证据。

## e2e 基建与 CI（2026-10-29 补齐）

### 本地怎么跑

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"
cd admin

# 单测（Vitest，当前 23 个文件 / 171 个用例，全部为 app 内 src/**）
corepack pnpm --filter @vben/web-antd test:unit

# e2e（turbo → @vben/web-antd → playwright test；会自己拉起两个 dev server）
corepack pnpm run test:e2e

# 静态门禁
corepack pnpm run lint:check
```

- e2e 配置在 `apps/web-antd/playwright.config.ts`，用例在 `apps/web-antd/e2e/`。
- 浏览器二进制不在 npm 包里：**首次需** `corepack pnpm exec playwright install chromium`。本机若下载受限（实测限速到 ~13 KB/s），可用 `PLAYWRIGHT_CHANNEL=chrome` 复用本机已装 Chrome；这仍是 Chromium 内核，但**不是 CI 使用的那份构建**，结论里必须标明。
- 端口：5666（契约桩实例）与 5667（契约回放实例）。`reuseExistingServer` 在本地为 true，因此跑 e2e 前应先停掉手工起的 `dev`（否则 Playwright 会复用那个实例，它很可能没开 `VITE_OPS_MOCK`）。
- 环境设置了 `HTTP(S)_PROXY` 时，配置已为回环地址设置 `NO_PROXY`：否则 webServer 探活会走代理，把「端口无人监听」误判成「已就绪」，随后用例报 `ERR_CONNECTION_REFUSED`。
- 用例文件必须命名 `*.e2e.ts`：`--filter @vben/web-antd test:unit` 在包目录内启动 vitest 时读不到根 `vitest.config.ts` 的 `exclude: ['**/e2e/**']`，`*.spec.ts` 会被单测收集并失败。

### 两条执行通道（都是契约验证，不是后端集成）

| project | 端口 | 数据来源 | 覆盖 |
| --- | --- | --- | --- |
| `chromium-stub` | 5666 | `VITE_OPS_MOCK=true` → `src/api/ops/__stub__`（全量动作码） | 登录允许 / 登录拒绝 / 未登录守卫 / 登出 / 有权限域菜单与页面 |
| `chromium-http-contract` | 5667 | `VITE_OPS_MOCK=false` + `page.route` 回放 `Docs/ops-api-contract.md` 形状 | 权限子集：菜单不可见 + 直达 URL 落 404 |

第二条通道存在的原因：应用内契约桩固定授予全部动作码（`STUB_SESSION.permissions = OPS_PERMISSION_CODES`），无法构造「无权限」场景，而 `src/**` 已冻结。它验证的是 axios 真实 HTTP 路径 + 前端呈现，仍**不**证明后端鉴权。

### 当前覆盖（6 例）

1. 正确凭据 → `/overview`（含桩条幅可见）；
2. 错误凭据 → 登录页 `[data-testid="login-error"]` 可读错误，且不产生会话；
3. 未登录访问 `/customers/list` → 重定向登录并携带可解码的 `redirect`；
4. 登出 → 会话清理，再访问受保护路由被拦；
5. 具备 `customer.read` → 客户菜单可见、列表页可进入、写入按钮可见；
6. 仅 `customer.read` → 账款菜单不可见、直达 `/billing/receivables` 落 404（文案不区分「不存在/无权限」）。

### `test:e2e` 假绿的排除

- 机制：`turbo run test:e2e` 只调度**声明了同名脚本**的包。此前全仓没有任何包声明 `test:e2e`，turbo 输出 `0 total` 却 `exit 0`，是纯假绿。
- 现在 `apps/web-antd` 的 `test:e2e`（`playwright test`）存在，且 `turbo.json` 为该任务声明了 `cache: false` 与 `env: ["CI", "PLAYWRIGHT_CHANNEL"]`（turbo 2 严格环境模式下，未声明的环境变量不会传给任务）。
- 判定标准：输出必须是 `Tasks: 1 successful, 1 total`（失败则为 `0 successful, 1 total` 且退出码非 0），只要出现 `0 total` 就说明包脚本被删或改名，属于回归。
- 未安装浏览器时的行为已实测：`Tasks: 0 successful, 1 total`、`Exit status 1`——**会红，不会假绿**。

### Gitee CI 阶段与门禁

- 文件：**仓库根** `.workflow/frontend-quality.yml`（Gitee Go 只读仓库根的 `.workflow/`）。 `.github/workflows/frontend-quality.yml` 保留为 GitHub 侧资产，Gitee **不执行**它。
- 触发：`main` 分支的 push 与 PR。
- `quality` 阶段（顺序固定）：Node 24.20.0 → `corepack enable` + pnpm 10.33.4 → 版本精确校验 → `pnpm install --frozen-lockfile` → `node scripts/quality/check-toolchain.mjs` → `pnpm run quality:check`。
- `e2e` 阶段（可选，可整段删除）：同样的工具链安装 → `playwright install --with-deps chromium` → `pnpm -F @vben/web-antd test:e2e`。
- 不注入任何 secrets，不部署，不写外部数据库；PR 阶段只读仓库、只跑检查，不保留可部署构件。
- **已知会红**：`quality:check` 末尾的 `quality:dependencies`（`npm audit --audit-level high`）在当前锁文件下仍有未升级的高危 advisory。这是真实失败，不得通过跳过检查来变绿；见 `journal/2026-10-29-quality-gate-audit.md` §4.1。

### 待人工验证项（未验证，不得视为通过）

1. **分支保护未启用**：workflow 文件存在 ≠ 分支保护生效。需在 Gitee 仓库「管理 → 分支设置」为 `main` 启用保护分支并勾选该流水线的检查项，再发起真实 PR 观察其是否阻断合并。
2. **Gitee Go 从未实际执行过本流水线**：YAML 按仓库内既有 `ci.yml` / `release-*.yml` 的 schema 书写，但 `corepack enable` 在 Gitee 镜像内的权限、`playwright install --with-deps` 的镜像依赖、Node 24.20.0 镜像是否存在，均未验证。
3. **Playwright 自带 chromium 未在本机跑通**（下载限速中断），本地 e2e 结论来自 `PLAYWRIGHT_CHANNEL=chrome`；CI 路径（`playwright install chromium`）未验证。
4. **e2e 未对接真实后端**：登录/会话/权限均为契约桩与契约回放，不构成后端鉴权、RLS、幂等验收。
5. **`quality:check` 端到端未跑通**（卡在 audit），只有 `lint:check`、`test:unit`、`test:e2e`、 `build` 四条分项实测通过。
