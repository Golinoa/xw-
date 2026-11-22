# 项目长期记忆（D:\Coding\ERP）

## 🔴 admin 依赖红线（2026-11-17 起）
**不许在沙箱里重装 `admin/node_modules`。** 39 个 workspace 的 Vben 大仓，
在 9KiB/s 网络 + 无 TTY + 沙箱锁临时文件的环境下，中断一次就留下
「88 个半解压包（`lib/` 空）+ 4 个删不掉的 `_tmp_*`」，进而让 **admin 下所有 pnpm 命令都失败**。
需要装依赖时只给用户 PowerShell 命令，让他们在自己终端跑。
识别特征：`Cannot find module '...\.pnpm\<pkg>\...\lib\index.js'`，且该目录只有 LICENSE+package.json。

### 2026-11-18 追查结论（别再重复试）
三种手法全部失败，且**都卡在同一处**（`added` 计数停在某个数后无限期不动，
顶层 `node_modules/` 始终 0 项、`.bin` 为空）：
1. 删掉残留 `_tmp_*` 后重装 —— 不再报 EPERM，但照样卡住；
2. `--offline`（不联网，只用本地 store，`reused 1712`）—— 照样卡住；
3. 把 `node_modules` 做成指向 C 盘临时区的 junction —— **pnpm 直接报
   `ENOTDIR: not a directory, mkdir ...\node_modules`**（`lstat` 下 junction 不算目录），此路不通。

**对照探针**：同样环境里一个最小包（is-odd）`pnpm install` **11 秒成功**。
⇒ pnpm 本身、网络、registry 都没问题，**是这个 39 包大仓的链接阶段在本机会挂死**。
结论：admin 前端依赖只能由用户在自己终端装；不要再在会话里尝试。

### udone 侧的两个可用变通（已验证）
- `vitest` 起不来（缺 `@vitejs/plugin-vue` 链接）：建 junction 即可 —
  `node_modules/@vitejs/plugin-vue` → `.pnpm/@vitejs+plugin-vue@<ver>/node_modules/@vitejs/plugin-vue`。
- `pnpm` 在 udone 也会被 `_tmp_*` 卡：**用 `node node_modules/vitest/vitest.mjs run` 绕过 pnpm**，
  路径要相对仓库根传；`vitest run` 跑完不退出，必须加 `timeout`，看输出里的 `Test Files` 判结果。
- 本地 PG 的数据目录放 `C:\Users\Agust\AppData\Local\Temp\%UDONE_LOCAL_PG_HOME%`，
  否则 initdb/日志会被工作区锁卡死（`UDONE_PG_BIN` 指向 `~/.udone-local-pg/pgsql/bin`）。

## 当前主线（2026-11 起）
**`udone/`（ERP 业务端：api + web + supabase 迁移）** 的业务 backlog 收尾，
清单在 `udone/Docs/superpowers/plans/2026-10-29-business-completion-backlog.md`，
每单元记录在 `udone/.harness/journal/`。

**状态（2026-11-20 13:4x 更新）：业务 backlog 21/21 全部完成，D2 已真实全绿。**
- **D2 已勾**：GitHub Actions `run #44675102215`（提交 `9b8ffd2`）**Success 1m29s**，
  质量门禁 15 步 + Playwright E2E 7 步全过。真仓 `https://github.com/Golinoa/xw-`（public）。
  从 #1 红到 #5 绿修掉三个真缺陷：workflow 自身格式、`package.json` 里指向已不存在的
  `.github/**` glob（Prettier 不匹配路径直接报错）、Linux 可选包 LGPL 许可证例外。
  Gitee Go 侧仍未跑过（`.workflow/*.yml` 不会自注册，需网页端建流水线对象）——**别再试 API**。
- **下一步方向已变**：不再是业务卡片，而是**前端迁移到 Vben Admin**
  （用户拍板"计划 2"）。文档：`udone/.harness/docs/vben-migration-plan.md`（5 阶段）、
  `udone/.harness/docs/frontend-function-map.md`（17 页面 / 69 端点 / 14 弹窗，迁移不得丢）。

### Vben 迁移：阶段 0 已过，阶段 1 批次 A 已完成（2026-11-21）

**工作副本是 `D:\Coding\ERP\admin-clean`**（不是计划文档里写的 `udone/apps/web-vben`）：
从 `admin/` robocopy 出干净副本，用 **hoisted 模式**装依赖才绕过本机链接阶段挂死。
安装与验证命令逐条记在 `udone/.harness/docs/vben-local-setup.md`，**照抄即可**。

- 现状：ops 业务资产已清空、Supabase 认证已接、`@erp/contracts` 走 vite alias 直连
  `udone/packages/contracts/src`、五域占位路由（workbench/trade/customer/finance/
  operations/config）已建，`typecheck` 与 `build --mode production` 均通过。
- 🔴 **每次 build 前必须 `rm -rf dist/js dist/css dist/jse dist/_app.config.js dist/index.html`**：
  否则 vite 的 emptyOutDir 被 safe-delete 拦，表现为「零输出 + exit 1 + 连 echo 都不跑」。
- 🔴 **typecheck 的「零输出」要用探针证明**（写个 `const x: number='s'` 看是否报 TS2322）。
- 🔴 **Vite 配置只能有一份**：Vite 8 加载 `vite.config.ts` 而非 `.mts`，改错文件会导致
  build 正常但 dev 报 `@erp/contracts` 无法解析。已于 11-22 合并并删除 `.mts`。
- 🔴 **dev 必须 `optimizeDeps.exclude: ['zod']`**：否则预构建把 zod 4 解析成 Vben 的 zod 3，
  报 `z.email is not a function`（build 无此问题）。
- 🔴 **Vite dev 在本会话里前台能起、后台常不监听**；给用户看页面用
  `dist` + `python -m http.server`，别在后台反复重启 vite。
- 🔴 已修 Vben 上游缺陷：守卫 `redirect` 双重编码（`%252F`）→ 写入不 encode、读取不 decode。
- 🔴 已修安全缺陷：access store 曾把 accessToken 持久化到 localStorage，已从 persist.pick 移除。
- **备份**在 `.workbuddy/backups/`（改造前基线 + 批次 A 完成态，两个 tar，不入库）。
- ✅ **`admin-clean` 已独立 git init**（2026-11-22，基线 `db9726e`，1142 文件）；
  根 `.gitignore` 的 `/admin-clean/` 保持不变，两边工作树都干净。
  测试资产现状：新工程 **0 个测试文件**，`udone/apps/web/src` 有 6 个可移植测试。

### 🔴 GitHub 只读仓库根的 `.github/workflows/`（2026-11-20 踩过）
`udone/.github/workflows/ci.yml` 曾长期存在、**永远执行不到**，而
`tests/tooling/harness-config.test.ts` 断言读的正是它 ⇒「CI 覆盖了 deps:audit/licenses/secrets」
是纸面结论，门禁一次没跑过。已删，断言改指根文件 + 反向断言「子目录不得再有副本」。
**推论：任何「CI 配置」类断言，先确认文件路径是不是会被平台读取的那一条。**

### 🔴 `format:check` 在本机恒红，别当门禁信号（2026-11-19）
`core.autocrlf=true` + `.prettierrc.json` 的 `endOfLine:"lf"` ⇒ 工作区全 CRLF ⇒ **207 文件
恒报不合规**，前几轮都当环境噪音跳过。**按 CI 检出内容（LF）复验才发现 4 个文件真不合规**，
而 `quality_gate` 第一行就是 `pnpm format:check`。
复验方法（唯一可信，照抄）：
`git -c core.autocrlf=false -c core.eol=lf archive HEAD --format=tar -o "C:/.../head.tar"`
→ 解包 → 在解包目录的 `udone` 用 `udone/node_modules/prettier/bin/prettier.cjs` 跑同一组 globs。
坑：`git archive` 会吃 autocrlf（不关就还是 CRLF）、git 与 node 都要 Windows 路径
（`C:/`、`D:/`，`/c/...` 与 `/d/...` 会被拼坏）；先确认导出文件 CR 计数为 0 再谈结论。

### 🔴 `format:sql:check` 的红是真红，但它不该被「格式化抹平」（2026-11-20 纠正）
前两轮把它当 CRLF 噪音跳过，**错了**：把源文件换行归一化后仍有 **25 个文件**与
`sql-formatter` 输出不一致（唯一纯 CRLF 假红是 `20261031000011_ops_settings_dictionaries.sql`）。
但该 formatter 的输出**更差**（`count(*)` → `count (*)`、单行 `CHECK` 被拆成 4 行），
批量 `--write` 等于重排 25 个已提交迁移。**决定：存量不动，新增迁移必须能被 formatter 接受。**
它不在 `.workflow/ci.yml` 里，不影响流水线。

### 前端两条硬经验（2026-11-19）

- 🔴 **`<a-table>` 的 `title` 是渲染函数，不能传字符串**。传字符串 → 挂载时
  `TypeError: title is not a function` → **整页白屏**，而 `vue-tsc` 与生产构建都不报。
  标题写普通元素或 `#title` 插槽。（`/reports` 就是这么白屏的，E2E 才抓到。）
- **E2E 端口用 `E2E_PORT` 覆盖**：本机 4173 常被别的 dev server 占，
  `reuseExistingServer` 会把那台当自己的（现象：登录页找不到邮箱输入框）。

门禁与踩过的坑见当天日志（`.workbuddy/memory/YYYY-MM-DD.md`）。

## 项目性质
ERP 工作区，当前主线是**「云策教务」教培系统**（yunceTaro / yunce-back / yunce-admin）之外的调研项目：
**泫蜗旅行 OMS（trip.lipseo.com，飞途旅游订单系统）真实站点调研 → 一比一复刻**。
需求与口径由用户拍板，技术实现自主完成。

## 调研成果位置（只读参考，不是本系统代码）
- 主文档：`erp/docs/TRAVEL_OMS_*.md`（7 份：AI_AGENT_DESIGN / API_DRAFT / DOCS_INDEX /
  MULTITENANT_DATA_MODEL / PRODUCT_CHARACTERISTICS / REQUIREMENTS / STATE_MACHINES）
- 调研入口：`erp/docs/research/README.md`
- 证据：`research/evidence/{network_*.json, pages/*.json}`（脱敏后）
- 接口目录：`research/ACTUAL_API_CATALOG.json`、功能覆盖 `research/FUNCTION_COVERAGE.json`、
  就绪度 `research/REPLICATION_READINESS.md`、清理链 `research/TEST_CHAIN.md`

## 读证据的硬规则（踩过坑）
1. **先按 requestId 去重再谈"抓到几条"**——阶段网络文件是累加快照，同一请求会在多个文件重复出现。
2. 判断"抓到响应"要看条目有没有 `status`/`response` 字段，不能只看 URL 出现过。
3. 目录里 `capture` 字段分四档：`wire-captured` / `wire-captured-request-only` /
   `ui-submitted-not-captured` / `ui-confirmed-no-wire`，**引用前先按这个分档，别只看 evidence 里的文件名**。
4. 已经降级过的旧结论：`POST /orders/{id}/confirm-booking` 的 `status=302` 无报文支撑（只有请求侧）。

## 仍未拿到的东西（卡在外部授权，不是能力问题）
- 数据库 schema / 迁移 / 服务端代码（只读授权，最高优先）
- 第二个租户账号（做跨租户负向隔离验证）
- 导入功能入口（全站至今未发现）
- 审批**驳回/撤回**完整 UI（单账号权限不足，`/reject` 403、`/withdraw`、`/undo` 404）

## 目标站点：只读复刻参考，不再操作其数据（2026-11-20 用户明确）
`https://trip.lipseo.com/login` 是**待复刻的目标网站**，不是要维护的系统。用户明确指示：
「不要管这个里面的了，无视他」。⇒ 不再登录、不再删除/修改里面任何数据（含供应商 387、
测试用户 90、回收站订单）。证据抓取也已完成，除非用户重新点名，不再回访该站。
调研文档与证据留在 `erp/docs/`、`research/`，仅作复刻口径参考。

## 深度复刻所需资料（给了才能验，不给不阻塞已交付代码）
真实 DB schema/迁移/服务端源码、第二个授权租户+员工账号、导入功能入口、
审批驳回/撤回 UI 的账号权限。
