# 项目长期记忆（D:\Coding\ERP）

> 索引式记忆：这里只放**跨会话仍要遵守的规则与结论**。逐日细节在
> `.workbuddy/memory/YYYY-MM-DD.md`，每个工作单元的完整证据在 `udone/.harness/journal/`。

## 1. 环境红线

### 🔴 不许在沙箱里重装 `admin/node_modules`
39 个 workspace 的 Vben 大仓，9KiB/s 网络 + 无 TTY + 沙箱锁临时文件 ⇒ 中断一次就留下
「半解压包（`lib/` 空）+ 删不掉的 `_tmp_*`」，之后 **admin 下所有 pnpm 命令都失败**。
识别特征：`Cannot find module '...\.pnpm\<pkg>\...\lib\index.js'`，且该目录只有 LICENSE+package.json。

已证伪的三条路（别再试）：删残留后重装、`--offline`、`node_modules` 做 junction
（pnpm 报 `ENOTDIR`，`lstat` 下 junction 不算目录）。对照探针：最小包 `pnpm install` 11 秒成功
⇒ pnpm/网络没问题，**是这个大仓的链接阶段在本机挂死**。需要装依赖只给用户 PowerShell 命令。

### 可用变通
- **绕开 pnpm**：`node node_modules/vitest/vitest.mjs run`（路径相对仓库根）；`vitest run` 跑完
  不退出，必须加 `timeout`，结果看 `Test Files` / `Tests` 两行。
- `vitest` 起不来（缺 `@vitejs/plugin-vue` 链接）→ 建 junction 指向 `.pnpm/@vitejs+plugin-vue@<ver>/...`。
- 本地 PG 数据目录放 `%TEMP%\%UDONE_LOCAL_PG_HOME%`，否则 initdb/日志被工作区锁卡死。
- `local-db.mjs http` 首次常「PostgREST 就绪超时」，**重跑即过**（不是回归）。
- 所有命令前加 `env -u NODE_OPTIONS`（沙箱注入的钩子会搞坏文件删除）。

## 2. 当前主线：udone 前端迁移到 Vben Admin

业务 backlog 21/21 已完成（2026-11-20，D2 由 GitHub Actions `#44675102215` 真实全绿）。
现在做**迁移**，计划见 `udone/.harness/docs/vben-migration-plan.md`，功能基线见
`udone/.harness/docs/frontend-function-map.md`（17 页面 / 69 端点 / 14 弹窗，不得丢）。

**工作副本 `D:\Coding\ERP\admin-clean`**（不是计划里写的 `udone/apps/web-vben`）：
从 `admin/` robocopy 的干净副本，hoisted 模式装依赖。装/验证命令照抄
`udone/.harness/docs/vben-local-setup.md`。已独立 `git init`（根 `.gitignore` 仍排除它）。

进度：阶段 0 ✅ → 1A 骨架+认证 ✅ → 1B E2E 基座 ✅ → 3.1 登录/工作台/通知/审计 ✅ → **3.2 公司配置/资金/报表 ✅**
→ 下一批 **3.3 客户/回收站/来源/线路/供应商**（5 页 + 6 弹窗）。

### 🔴 构建/检查的坑
- **每次 build 前 `rm -rf dist/js dist/css dist/jse dist/_app.config.js dist/index.html`**：
  否则 vite 的 emptyOutDir 被 safe-delete 拦，表现为「零输出 + exit 1 + 连 echo 都不跑」。
- **typecheck 的「零输出」要用探针证明**（`const x: number='s'` 是否报 TS2322）。
- **Vite 配置只能有一份**（Vite 8 读 `vite.config.ts`，`.mts` 不生效）。
- **dev 必须 `optimizeDeps.exclude: ['zod']`**，否则预构建把 zod 4 解析成 Vben 的 zod 3，
  报 `z.email is not a function`（build 不受影响）。
- **Vite dev 前台能起、后台常不监听**；给人看页面用 `dist` + `python -m http.server`。
- 本机 E2E：`PLAYWRIGHT_CHANNEL=chrome node node_modules/@playwright/test/cli.js test`
  （自带 chromium 没装）；端口冲突用 `E2E_PORT`。
- 已知遗留：`oxlint` 8 条既有错误（`lib/api-client.ts` 7 条非空断言 + `store/auth.ts` 冗余 return）、
  `oxfmt` 二进制本机跑不起来。

### 🔴 已修的 Vben 上游缺陷（别改回去）
- 守卫 `redirect` 双重编码（`%252F`）→ 写入不 encode、读取不 decode。
  改「登录后去哪」**只改守卫**（`guard.ts` 的 `router.resolve(from.query.redirect)`），
  `authLogin` 推哪里都不影响落点（曾误加 `resolvePostLoginPath()`，变异实验证伪后删）。
- access store 曾把 accessToken 持久化到 localStorage → 已从 `persist.pick` 移除。

### 🔴 认证三条口径（3.1 踩过）
1. **`/api/me` 无成员记录 ≠ 登录失败**：保留会话 + `sessionState='no_membership'`，
   否则 `acceptInvitation` 拿不到 token ⇒ 邀请流程彻底走不通。
2. 守卫必须放行「已登录 + `invitationId` 进登录页」。
3. `type=recovery` **必须在 `getSession()` 之前**判断，否则令牌落进 store、跳过设新密码。

### 🔴 3.2 新增的两条铁律
1. **查询串布尔值禁用 `z.coerce.boolean()`**：它走 `Boolean('false') === true`。
   用 `contracts/src/http.ts` 的 `queryBooleanSchema`（只认 `'true'/'false'/'1'/'0'`）。
   曾导致：报表「含已取消」反向、通知「只看未读」反向、线索 `inPool` 反向。三处已修 + 有用例。
2. **判断「同一错误码的不同原因」只能用 `err.details`，不能用 message**：
   `api-client` 会把 message 换成错误码对应的中文文案，按文案匹配恒为假
   （公司配置「二次确认」就是这么失效的：改审批规则永远存不进去）。`ApiClientError` 现已携带 `details`。

### E2E / 选择器经验
- Playwright glob `**/api/x*` **不匹配多一层路径**（`*` 不吃 `/`）⇒ 用 `**/api/x**`，
  否则 PATCH 漏到真网络（现象：vite 代理 ECONNREFUSED + 重试 4 次）。
- 登录提交按钮可访问名是 **`login`**（上游写死 aria-label）；登出确认按钮是 **`确 认`**（用正则）。
- `page.getByDisplayValue` **不存在**（那是 Testing Library）；用 `getByLabel`（需 FormItem 的
  `html-for` + 控件 `id`，antd 不自动生成）或 `locator('input[value=...]')`。
- 桩响应必须满足**该端点的响应契约**：`adjustAccountBalance` 返回 `{adjustmentId}`，
  喂 `{}` 会 `ContractViolationError`（错误为「页面没反应」）。
- antd `Card` 的 `title` 不是 heading 角色；`<a-table>`（旧前端）的 `title` 是渲染函数，
  传字符串会整页白屏。
- 顶栏壳层（公司切换、未读角标）挂在 `BasicLayout` 的 `#header-right-1` 插槽。

## 3. 门禁与格式化的坑

- **`format:check` 在本机恒红，别当门禁信号**：`core.autocrlf=true` + `endOfLine:'lf'` ⇒ 207 文件
  恒报错。要复验必须按 **CI 检出内容（LF）**：`git -c core.autocrlf=false -c core.eol=lf archive
  HEAD --format=tar -o "C:/x/head.tar"` → 解包 → 用 `udone/node_modules/prettier/bin/prettier.cjs`
  跑同一组 globs（git/node 都要 Windows 路径 `C:/`、`D:/`）。
- **`format:sql:check` 的红是真红，但不要批量 `--write`**：formatter 输出更差
  （`count(*)` → `count (*)`），会重排 25 个已提交迁移。**存量不动，新增迁移必须能被它接受。**
- **GitHub 只读仓库根的 `.github/workflows/`**：`udone/.github/workflows/` 里的副本永远不执行，
  而断言却读它 ⇒「CI 覆盖了 X」是纸面结论。已删，断言改指根文件 + 反向断言。

## 4. 旧项目背景（只读参考，不再是主线）

`erp/docs/TRAVEL_OMS_*.md`（7 份）与 `research/*` 是**泫蜗旅行 OMS**（trip.lipseo.com）的调研成果，
用于复刻参考。用户已明确「不要管这个里面的了，无视他」⇒ **不再登录/修改目标站任何数据**，
证据抓取已完成。

读证据的硬规则：先按 `requestId` 去重再谈「抓到几条」；判断「抓到响应」看有没有
`status`/`response` 字段；`capture` 字段分四档（`wire-captured` / `-request-only` /
`ui-submitted-not-captured` / `ui-confirmed-no-wire`），引用前先分档。

仍未拿到的：真实 DB schema/迁移/服务端源码、第二个租户账号、导入入口、审批驳回/撤回 UI 权限。
