# udone 前端迁移到 Vben Admin — 全量迁移计划

状态：**阶段 0、阶段 1-A/1-B 已完成，下一批为阶段 3.1**。基线：`frontend-function-map.md`（17 页面 / 69 端点 / 14 弹窗）。
用户选择：计划 2（Vben Admin）。生成：2026-11-20；阶段 0 通过：2026-11-21；E2E 基座：2026-11-22。

> **阶段 0 已通过（2026-11-21）**：干净副本 `D:\Coding\ERP\admin-clean` 用 hoisted 模式
> 装好依赖（`build ✓ 14.58s` + `typecheck ✓ 0 错误`）。可复现步骤见 `vben-local-setup.md`。
> 下文"阶段 0 未通过"段落是当时的历史记录，保留作证据，不再是当前状态。

## 0. 决策摘要（先看这五条）

1. **不复用 `admin/` 的业务代码**：那是"有单软件运营后台"（ops 域），与旅行社 OMS 无关。
2. **复用它的 Vben 工程骨架**：`admin/` 是 Vben 5.7.0，39 个 workspace，含
   router/access/request/登录骨架等可参照实现。
3. **依赖不重装**：`admin/node_modules/.pnpm` 有 1.2G 完整包（含 `vue@3.5.34`、`vite@8.3.5`），
   只是顶层链接断了。按项目红线，**禁止在沙箱里跑 `pnpm install`**。
   开工第一步是**只补符号链接**（junction），不触发安装；若补链后仍跑不通，
   **停下来给用户 PowerShell 命令让用户在自己终端装**，不在会话里反复试。
4. **端点 key、契约校验、E2E 桩一个都不能动**：这是当前项目最值钱的资产。
   Vben 的 `request.ts` 要改造成调用现有 `@erp/contracts` 的 `api-client`，
   而不是反过来让契约去适配 Vben 的请求封装。
5. **分批迁移，每批可回退**：每批 = 一批页面 + 对应 E2E 更新 + 门禁，独立提交。

## 1. 目标目录结构

在仓库内新建**独立前端工程**，不改动正在跑的 `udone/apps/web`（保持可回退）：

```
udone/apps/web-vben/            ← 新前端（Vben 5.7）
├── src/
│   ├── api/                    ← 复用 contracts 的 api-client 内核
│   ├── router/routes/modules/  ← 按业务域拆：trade / customer / ops / config
│   ├── views/
│   │   ├── _core/              ← 登录、403、404、500、个人设置
│   │   ├── trade/              ← 订单、收付款、审批、结算、供应商、线路、来源
│   │   ├── customer/           ← 客户、回收站、CRM 线索
│   │   └── ops/                ← 审计、通知、资金、报表、公司配置
│   ├── store/                  ← auth（Supabase 会话 + 组织切换）
│   └── design-system/          ← 移植现有 tokens 到 Vben preferences
├── vite.config.ts
└── package.json
```

`udone/apps/web` 原样保留到全部迁移完成，期间两套并存，随时可切回。

## 2. 阶段划分（每阶段独立提交 + 门禁）

### 阶段 0：依赖可行性探针（**先做，不通过就停**）
- 目标：不重装依赖，确认 Vben 工程能 `typecheck` + `build`。
- 动作：补顶层软链 → 跑 `admin` 的 `vue-tsc` 与 `vite build`。
- 判据：两条命令都能跑完。失败则**不继续**，把 PowerShell 命令给用户。
- 产出：可行性结论 + 若可行，记录可复用的链接清单。

### 阶段 1：骨架与认证（无业务页面）
- 建 `udone/apps/web-vben`，复制 Vben 的 `_core` 骨架页 + router/access。
- 认证改造：`Supabase signInWithPassword` → Vben 登录页；会话仍走标签页级存储；
  组织切换注入 `X-Organization-ID`。
- API 内核：Vben `request.ts` 改为调用 `@erp/contracts` 的 `api-client`，
  保留请求/响应双向 zod 校验。
- 门禁：新工程 `typecheck` + `build`；E2E 桩路径 `/api/`、`/auth/v1/` 不变。

#### 阶段 1 进度（2026-11-21 批次 A 已完成）

**目录口径修正**：不在 `udone/apps/web-vben` 新建工程，直接在干净副本
`D:\Coding\ERP\admin-clean` 上改造。理由：Vben 5 的 39 个 workspace 全部是
`workspace:*` 内部依赖，抽到 `udone/` 下要么整仓搬迁、要么复制 39 个包，
两种都比「在副本上改」贵得多。**代价**：`admin-clean` 被 `.gitignore` 排除，
源码暂无版本控制（有 tar 快照，见 `.workbuddy/backups/`）。

已完成：
1. **清空 ops 业务资产**：10 个路由模块、`views/ops`、`views/demos`、`api/`（含
   ops 的 auth/refresh/error 适配层）、`constants/permissions.ts`、全部 ops 单测。
2. **接 ERP 认证**：`store/auth.ts` 重写为 Supabase 会话 + 组织成员 + `X-Organization-Id`
   注入；登录字段由「账号」改为「邮箱」；无组织归属时按 `no_membership` 失败处理。
3. **API 内核**：`lib/api-client.ts` 从 `udone/apps/web` 原样移植（保留 zod 双向校验、
   幂等键、401 单飞重试、5xx 指数退避）；`@erp/contracts` 走 vite alias 直连
   `udone/packages/contracts/src`，**不复制、不发布**。
4. **路由骨架**：`workbench` + `trade/customer/finance/operations/config` 五域占位，
   `defaultHomePath` 改为 `/workbench`；文案命名空间 `ops-shell` → `shell`。
5. **修掉上游守卫缺陷**：`redirect` 参数被 `encodeURIComponent` + vue-router 各编码一次
   → 双重编码（`%252F`），登录后跳转目标损坏。已改为写入不编码、读取不解码。

门禁：`vue-tsc --noEmit` 0 错误（用错误探针验证检查确实生效）、`vite build` 6.45s、
Playwright 实测登录页渲染 + 未登录访问 `/trade/orders` 正确回跳
`/auth/login?redirect=/trade/orders`。

**未做（下一批）**：~~`@erp/contracts` 的 zod 4 与 Vben 自带的 zod 3 并存问题尚未在
`pnpm install` 场景下验证~~（已在批次 B 期间用 `optimizeDeps.exclude: ['zod']` 解决，
仅 dev 需要）；~~E2E 用例尚未迁移到新工程~~（见批次 B）。

#### 阶段 1 批次 B：E2E 基座重建（2026-11-22 完成）

原来的 `e2e/` 全是 ops 后台时代留下的（依赖已删除的 `src/api/ops/__stub__` 与
`VITE_OPS_MOCK`），`pnpm test:e2e` 必然跑不起来。已全部删除并重建：

- `playwright.config.ts` 单实例，端口 `E2E_PORT`（默认 5330），webServer 直调 vite bin
  （不走 pnpm，避开本机 `_tmp_*` 卡死），凭据由 `webServer.env` 压成夹具；
- `e2e/support/session.ts`：Supabase 令牌 + `/api/me` 成员夹具（**先过契约 schema**）；
- `e2e/auth.e2e.ts` 5 条：未登录拦截并记住目标 / 登录回原页 / 无目标落工作台 /
  刷新恢复会话 / 登出清会话。

**改掉的一个认知错误**：登录回跳**由守卫负责**（`guard.ts` 里动态路由生成后
`router.resolve(from.query.redirect)`），`authLogin` 推哪里都不影响落点。
曾误以为 `authLogin` 丢了 redirect 并加了重复函数，变异实验证伪后已删除。
⇒ 以后要改「登录后去哪」，只改守卫那一处。

门禁：`vue-tsc` 0 错（探针验证）、`vite build` 4.43s、`playwright test` 5 passed。

### 阶段 2：布局与主题
- 侧边栏 + 页签 + 面包屑替代手写顶部导航；15 个路由按业务域分组。
- 设计令牌从 `tokens.ts` 迁到 Vben `preferences.ts`（品牌蓝 #0093FF 等）。
- 表格统一：搜索表单区 + 工具栏 + 列设置（Vben `useTable`）。
- 门禁：E2E 全绿（导航断言可能要改选择器）。

### 阶段 3：页面迁移（分 5 批，按风险从低到高）
| 批次 | 页面 | 行数合计 | 风险点 |
|---|---|---:|---|
| 3.1 | 登录 / 工作台 / 通知 / 审计 | ~704 | 认证与权限骨架 |
| 3.2 | 公司配置+审批流 / 资金 / 报表 | ~916 | 配置读写、图表 |
| 3.3 | 客户 / 回收站 / 来源 / 线路 / 供应商 | ~1,849 | 14 个弹窗中的 8 个 |
| 3.4 | 订单 / 游客名单 / 导入 | ~2,238 | 最复杂：825 行表单、导入预览 |
| 3.5 | 收付款 / 审批申请 / 结算 / CRM 线索 | ~2,528 | 状态机、审批动作、漏斗 |

每批迁移后：
- `pnpm typecheck` + `pnpm build`
- 对应页面的 E2E 用例在**新工程**跑通
- 契约测试/HTTP 集成/pgTAP **不变**（后端没动）

### 阶段 4：收尾切换
- 默认路由指向新工程，旧 `apps/web` 保留一个版本作为回退。
- CI 增加新工程的门禁 job（GitHub Actions）。
- E2E 全量 25 条在新工程跑绿。
- 更新 `.harness/docs/frontend-function-map.md` 的迁移状态列。

## 3. 关键风险与对策

| 风险 | 后果 | 对策 |
|---|---|---|
| Vben 依赖补链失败 | 整个计划卡死 | 阶段 0 探针；失败即停，交 PowerShell 给用户 |
| Vben request 与契约校验冲突 | 响应体绕过 zod，类型安全失效 | 契约优先，Vben request 只做传输层 |
| E2E 桩路径变化 | 25 条用例全废 | 阶段 1 明确 `/api/` `/auth/v1/` 不变 |
| 页面逻辑迁移遗漏 | 功能丢失 | 功能地图逐条对照；每批 E2E 覆盖 |
| 39 workspace 体积/构建慢 | CI 超时 | 新工程只引需要的 Vben 包，不整仓复制 |

## 阶段 0 结论（2026-11-20 13:2x）：**未通过，暂停迁移**

按约定"探针不通过就停"，不硬闯。证据：

- Vite 8.3.5 本体能从 `.pnpm` 直接跑起来（`vite --version` 正常）。
- 但 `apps/web-antd` 的构建在解析依赖时连续失败：
  先缺 `@vben/vite-config`（我已补 4 个内部 workspace 链接：vite-config /
  tailwind-config / node-utils / tsconfig），随后报 `@babel/runtime` 未建链接。
- **一次探针量化**：app 顶层 `node_modules` 里**约 976 个包缺顶层软链**，
  但它们都完整存在于 `node_modules/.pnpm`（1.2G store）。
- 断链数 = 0（不是链接指错），是**当年 pnpm 装到一半被中断、从未建立顶层链接**。
- ⇒ 逐个补链接是 976 次操作，属于用户明确反对的"反复试错"，**停止**。

### 退路「独立精简 Vben 工程」已证伪（2026-11-20 13:4x）

功能地图 §7 留了一条退路：不复用 39-workspace 大仓，在新位置建精简 Vben 工程。
**这条路不存在**，实测证据：

- `apps/web-antd/package.json` 里 14 个 `@vben/*` 依赖**全部是 `workspace:*`**
  （access / common-ui / constants / hooks / icons / layouts / locales / plugins /
  preferences / request / stores / styles / types / utils）⇒ 它们不是可安装的 npm 包。
- npm registry 实查：`@vben/common-ui`、`@vben/preferences`、`@vben/access` **不存在**；
  `@vben/layouts` / `@vben/request` / `@vben/stores` / `@vben/styles` 只发布过
  **`1.0.1`（2023-11-24，Vben 2.x 时代）**，各仅 1 个版本。
- Vben 5 的底层包 `@vben-core/shadcn-ui`、`@vben-core/composables`、
  `@vben-core/preferences`、`@vben-core/typography` 也**均未发布**。

⇒ Vben 5 是**模板仓库**而非可 npm 安装的库。要用它，必须编译 `admin/` 源码，
而编译 `admin/` 源码就必须先修好那 976 条链接。**没有第三条路**。

### 我改动过的东西（已全部撤销或明确记录）

- 曾在 `admin/node_modules/` 顶层建 `rolldown` 软链、在 app 顶层建 `vite` 软链。
- 保留的 4 条内部包软链（`apps/web-antd/node_modules/@vben/`）：
  `vite-config` / `tailwind-config` / `node-utils` / `tsconfig`，都指向
  `admin/internal/*`，方向正确、无副作用；若你重装依赖会被 pnpm 自动覆盖。

#### 2026-11-20 13:4x 复核纠正（上面那句「指向错误版本、已删除」是错的）

实测：`admin/node_modules/rolldown` **仍然存在**，是**实体目录**（不是软链），
`package.json` 版本 `1.0.1`，`bin/` `dist/` 齐全，创建时间 13:20。
而 `pnpm-lock.yaml` 根 importer 声明 `rolldown: ^1.0.1` → 解析 `1.0.1`，
`.pnpm/` 里同时有 `rolldown@1.0.1` 与 `rolldown@1.2.16`。
⇒ 两点纠正：**(1) 1.0.1 不是错误版本，正是根 importer 要的那个**；
**(2) 它没被删掉**。

处置：**不动它**。它满足根 importer 的解析，不会让构建失败；用户执行
`pnpm install --frozen-lockfile` 时 pnpm 会把它替换成正常软链。
删掉反而可能让当前还能解析 `rolldown` 的路径断掉。

### 需要用户在自己终端执行（我不能在沙箱里跑）

```powershell
cd D:\Coding\ERP\admin
pnpm install --frozen-lockfile
```

为什么必须你跑：沙箱里 pnpm 会被 `_tmp_*` + safe-delete 卡死，之前已多次踩坑，
项目红线明令禁止在会话里重装 admin 依赖。你的终端没有这层限制。

装完后告诉我，我重跑阶段 0 探针（`vite build` + `vue-tsc`）。通过才进入阶段 1；
不通过则 migration 继续暂停，不带着残缺依赖硬写页面。

## 4. 现在的下一步

**阶段 0（依赖）与阶段 1 批次 A/B（骨架、认证、E2E 基座）已完成，当前在阶段 3 入口。**

工作副本：`D:\Coding\ERP\admin-clean`（自带独立 git 仓库，根仓库 `.gitignore` 仍排除它）。
装依赖与验证命令逐条见 `vben-local-setup.md`，照抄即可。

| 批次 | 状态 | 记录 |
|---|---|---|
| 阶段 0 依赖探针 | ✅ 2026-11-21 | `2026-11-20-vben-stage0-blocker-recheck.md` |
| 阶段 1-A 骨架+认证 | ✅ 2026-11-21 | plan 上文 + `admin-clean` 提交 `a7cc898` |
| 阶段 1-B E2E 基座 | ✅ 2026-11-22 | `2026-11-22-vben-phase1-batch-b-e2e.md` |
| 阶段 3.1 登录/工作台/通知/审计 | ⬜ 下一批 | — |

自动化巡检时**只看上表第一行未打勾的批次**，不要重跑已完成的阶段 0 探针，也不要重复回放
`udone` 的 CI 全序列——那两件事已有记录，重复跑只烧时间。

本机跑 E2E 的两个必知项：

```bash
# 1) 本机 @playwright/test 期望的 chromium 没装，用本机 Chrome
PLAYWRIGHT_CHANNEL=chrome node node_modules/@playwright/test/cli.js test
# 2) 端口占用时覆盖：E2E_PORT=5331
```

阶段 3.1 开工前先读 `.harness/docs/frontend-function-map.md` 里对应的 4 个页面，
按「接口 → 视图 → 弹窗」逐条对照，不得丢功能。


