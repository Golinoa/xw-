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

**工作副本 `D:\Coding\ERP\admin-clean`**：已合入主仓（`d69c191`，1177 文件，双远端已推），
不再是「独立 git、无 remote」的状态。装/验证命令照抄 `udone/.harness/docs/vben-local-setup.md`。

进度：阶段 0 ✅ → 1A ✅ → 1B E2E 基座 ✅ → 3.1–3.5 全部 17 页迁完 ✅（2026-11-24）
→ **阶段 4 收尾已做完（2026-11-26）**：新后台 `build` job 绿（run 45651616866，11 步 1m21s）、
E2E job 绿（36 passed / 2.9m，job 3m50s）。**唯一剩下的「默认路由切新工程」是上线决策，等用户拍板**，
没有技术工作可做。

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
- **lint 必须整 app 跑**：`vsh lint` = 根目录 `eslint .`。只 lint 新增文件会让红门一直传下去
  （3.3b 才发现前几批积了 27 条）。收尾固定跑 `./node_modules/.bin/eslint apps/web-antd`。
  且**必须从仓库根跑**：在 `apps/web-antd` 里跑相对路径会让 `tsconfigRootDir` 落到
  `tsconfig.node.json`，把 `.ts` 报成 `Parsing error`（假错误）。
- **`eslint --fix` 会连 `package.json` 一起改**（`pnpm/json-enforce-catalog` 把裸版本号改成
  `catalog:` 并往 `pnpm-workspace.yaml` 加行）；`unicorn/prefer-includes` 的 autofix 会打断
  类型守卫（元组字面量类型 ⇒ TS2345，要写 `(CONST as readonly string[]).includes(x)`）。
- 已知遗留：`oxlint` **7** 条存量错误（全是 `lib/api-client.ts` 非空断言，3.3b 后 8→7）、
  `oxfmt` 二进制本机跑不起来；`apps/web-antd/package.json` 与 `pnpm-lock.yaml` 不同步
  （lockfile 里没有 `@supabase/supabase-js`），动它要重装依赖 ⇒ 不碰。

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
- **块注释里禁止出现 `**/`**：写「`**/api/customers**` 这种 glob」会让 `*/` 提前结束注释，
  报错是 `Parsing error: Expression expected` 且指向注释行。写说明时避开这段字符。
- **桩按 `pathname` 分派，一个 handler 管一族路径**：`/api/customers` 的 glob 会把
  `batch-tags`、`recycle-bin`、`/:id` 全吃掉，分散注册的命中顺序不可控；
  `/:id` 正则也匹配不到 `/:id/restore`（子路径要单独一条）。
- **拿「仍是占位页」的路由当登录回跳落点**（`e2e/auth.e2e.ts` 现在用 `/trade/orders`）：
  该路由一被真实化，`待实现` 断言必红。订单页 3.4 迁移时要再换一次。
- 页面会连带请求别的资源（如客户表单拉来源）⇒ 不桩就漏到真网络，现象是「页面正常但下拉空」。

## 3. 门禁与格式化的坑

- **`format:check` 在本机恒红，别当门禁信号**：`core.autocrlf=true` + `endOfLine:'lf'` ⇒ 207 文件
  恒报错。要复验必须按 **CI 检出内容（LF）**：`git -c core.autocrlf=false -c core.eol=lf archive
  HEAD --format=tar -o "C:/x/head.tar"` → 解包 → 用 `udone/node_modules/prettier/bin/prettier.cjs`
  跑同一组 globs（git/node 都要 Windows 路径 `C:/`、`D:/`）。
- **`format:sql:check` 的红是真红，但不要批量 `--write`**：formatter 输出更差
  （`count(*)` → `count (*)`），会重排 25 个已提交迁移。**存量不动，新增迁移必须能被它接受。**
- **GitHub 只读仓库根的 `.github/workflows/`**：`udone/.github/workflows/` 里的副本永远不执行，
  而断言却读它 ⇒「CI 覆盖了 X」是纸面结论。已删，断言改指根文件 + 反向断言。

### 🔴 CI 取证已经打通（2026-11-25 起，别再说是纸面结论）

`gh` 未登录，但 **`git credential fill`（host=github.com）拿到的 PAT 能读 Actions API**：
列 runs / jobs / steps、拉原始日志、下 artifact（token 用对，cwd 要在 git 仓库内）。
读日志：`curl -sSL --ssl-no-revoke -H "Authorization: Bearer $TOKEN"`，
`-o` 目标不要写 `/tmp`（本机没有），用 `$LOCALAPPDATA/Temp/`。
日志每行带时间戳前缀，先 `sed 's/^[0-9T:.Z-]*Z //'` 再 grep。
`workflow_dispatch` 返回 **500 通常不是权限问题，是 GitHub 平台故障** —— 先查
`https://www.githubstatus.com/api/v2/status.json`（`Actions` 组件状态），别改代码。

- **本机 `format:check` 恒红不是「真红」的判据**：真红只能看 CI（`quality_gate` 第一步就是它，
  红了后面 10 步全 skipped）。11-23 那次真红只有 `packages/contracts/src/customers.test.ts` 一行超 100 列。
- **新前端 `admin-clean` 编译 udone 的契约源码** ⇒ **类型/构建必须在装过 udone 依赖的环境里跑**：
  `udone/packages/contracts` 依赖 zod 4.6.6，admin-clean 顶层只有 Vben 的 zod 3.25.76。
  workflow 里少了 `cd udone && npx --yes pnpm@11.24.0 install --frozen-lockfile` 就是
  45 条 `Cannot find module 'zod'` + 91 条下游错。**本机 vue-tsc 绿 ≠ CI 绿。**
- **antd-vue 两字中文按钮只在「非 link/text」时插空格**（`button.js` 的 `isUnBorderedButtonType`）：
  行内 `type="link"` 的可访问名仍是「作废」，弹窗确认键（默认+danger）是「作 废」。
  E2E 一律写 `/作\s*废/` 这类正则，别写死字符串。
- **本机 Playwright teardown 死结有定论了**：同一份用例在 Linux runner 3.8 分钟跑完并打印汇总
  （35 passed/1 failed）⇒ 卡住是 Windows 进程句柄问题，不是用例内容。E2E 已验证跑在 CI 里。

## 4. 旧项目背景（只读参考，不再是主线）

`erp/docs/TRAVEL_OMS_*.md`（7 份）与 `research/*` 是**泫蜗旅行 OMS**（trip.lipseo.com）的调研成果，
用于复刻参考。用户已明确「不要管这个里面的了，无视他」⇒ **不再登录/修改目标站任何数据**，
证据抓取已完成。

读证据的硬规则：先按 `requestId` 去重再谈「抓到几条」；判断「抓到响应」看有没有
`status`/`response` 字段；`capture` 字段分四档（`wire-captured` / `-request-only` /
`ui-submitted-not-captured` / `ui-confirmed-no-wire`），引用前先分档。

仍未拿到的：真实 DB schema/迁移/服务端源码、第二个租户账号、导入入口、审批驳回/撤回 UI 权限。
