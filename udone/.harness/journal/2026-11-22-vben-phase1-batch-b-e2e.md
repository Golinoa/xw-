# 2026-11-22 Vben 阶段 1 批次 B：E2E 基座重建

本批次不写业务页面，只把「验证手段」修好——`admin-clean` 里那套 e2e 是 ops 后台时代留下的，
依赖已经在本轮迁移里被删掉的东西，`pnpm test:e2e` 必然跑不起来。

## 1. 死件盘点（删之前先确认它真的死了）

| 文件 | 为什么必死 |
|---|---|
| `e2e/stub/{auth,access,governance}.e2e.ts` | 依赖 `src/api/ops/__stub__` 与 `VITE_OPS_MOCK=true` 的黄色条幅，两者在批次 A 清 ops 资产时已删 |
| `e2e/http/{permission.e2e.ts,ops-contract.ts}` | 回放的是 `/api/v1/ops/*` 契约，这些端点在新工程里没有 |
| `e2e/support/auth.ts` | ops 账号密码登录夹具；ERP 走 Supabase 邮箱登录 |
| `.env.e2e` | 唯一作用是设 `VITE_OPS_MOCK=true`，已无消费者 |

全仓 grep `VITE_OPS_MOCK|VITE_OPS_API_PREFIX`：命中项只剩上面这些文件与 `playwright.config.ts` 自己。
⇒ 删除，不留「以后可能有用」的空壳。

## 2. 新基座

`apps/web-antd/playwright.config.ts` 重写为单实例（原来有 5666 桩 / 5667 契约回放两个 project）：

- 端口 `E2E_PORT`，默认 **5330**（本机 4173/5666 常被别的 dev server 占着，踩过）；
- webServer **不走 `pnpm -F`**，直接 `node ../../node_modules/vite/bin/vite.js`：
  本机 pnpm 会被残留 `_tmp_*` 卡死（项目红线），而 vite bin 直调只花 3.5s 就绪；
- 凭据用 `webServer.env` 显式压成夹具（`VITE_SUPABASE_URL=http://127.0.0.1:54321`、
  `VITE_API_BASE_URL=''`）。**Vite 的 process.env 优先级最高**，所以 `.env.local` 里的
  真实地址不会漏进用例——这点必须写死，否则「本机能过、别人机器不过」；
- `testMatch: '**/*.e2e.ts'`，与 vitest 的单测目录不重叠。

`e2e/support/session.ts` 提供三件东西：Supabase 令牌响应夹具、`/api/me` 成员夹具
（**先过 `meResponseSchema.parse`**）、`installAuthStub()` + `signIn()`。
夹具一律先过契约，契约漂移时用例当场红，而不是长期绿着喂错字段。

## 3. 用例（5 条，全绿）

1. 未登录访问 `/customer/list` → `/auth/login?redirect=/customer/list`；
2. 登录后回到 `/customer/list`（不是一律回首页）；
3. 无回跳目标时落 `/workbench`；
4. 整页重载后会话从 sessionStorage 恢复，访问 `/auth/login` 被送回 `/workbench`；
5. 登出（Alt+Q → 确认）后回到干净登录页，再访问业务页重新被拦。

## 4. 关键发现：我一开始判断错了，别重复这个错

我以为 `authLogin` 的 `router.push(homePath)` 把守卫带过来的 `redirect` 丢了，
于是加了 `resolvePostLoginPath()`。**变异实验直接证伪**：

- 把落点改成 `router.push('/finance/receipts')`，探针打印登录后 URL —— 仍然是 `/customer/list`；
- 原因在 `router/guard.ts`：动态路由生成完的那一段已经 `return { ...router.resolve(from.query.redirect), replace: true }`，
  **回跳由守卫负责**，`authLogin` 推哪都不影响最终落点。

⇒ `resolvePostLoginPath()` 是重复规则，已整段删除。**保留守卫作为唯一真源**，
并在用例注释里写明「落点由守卫决定，不是 authLogin」。
教训：改之前先把「谁在决定这件事」的调用链走完；两张嘴说同一件事，改哪张都可能没用。

## 5. 顺手修掉的一处编码约定冲突（潜在缺陷）

`store/auth.ts` 的 `logout()` 里对 `redirect` 用了 `encodeURIComponent`，而守卫读端
（`from.query.redirect` → `router.resolve`）**不解码**——两边约定相反，一旦有人用默认参数
`logout()`，回跳目标会变成 `%2Fworkbench` 这种字面量。已改为不 encode。

诚实标注：**当前唯一调用方是 `layouts/basic.vue` 的 `logout(false)`**，不走这个分支，
所以这条修复现在没有用例覆盖（等阶段 3.1 有了用户菜单的真实登出路径再补）。

## 6. 验证证据

| 检查 | 结果 |
|---|---|
| `vue-tsc --noEmit` | 0 错误；**用探针证明检查生效**（写入 `const probe: number = 's'` → 报 TS2322） |
| `vite build --mode production` | ✓ 4.43s |
| `playwright test`（chrome 通道，5 条） | ✓ 5 passed 21.6s |
| 变异：`handleLogout` 改成 `return;` | ✗ 第 5 条红 —— 用例有牙 |
| 变异：删掉 `logout()` 里的 `clearLocalSession()` | ✓ 仍绿 —— 因为 `signOut()` 触发的 `SIGNED_OUT` 订阅也会清会话，两条路径互为兜底 |
| 变异：把登录落点改成 `/finance/receipts` | ✓ 仍绿 —— 证明落点由守卫决定（见 §4） |

## 7. 没做 / 做不了的

- **组织上下文头未验**：`/api/me` 本身就是「发现我属于哪些组织」的请求，按设计不带
  `X-Organization-Id`；占位页不发任何业务请求，所以头注入在本批次无法观察。
  留到阶段 3.1 工作台接真实数据时验证（那时才有业务请求可断言）。
- **`logout(true)` 分支没覆盖**：见 §5。
- **oxlint 既有 8 条错误未修**：`lib/api-client.ts` 7 条（非空断言）+ `store/auth.ts:200`
  的冗余 `return`，全部在批次 A 移植时就存在，与本批次无关；`oxfmt` 二进制在本机
  `MODULE_NOT_FOUND`，`format:check` 跑不起来。已报给用户，等指示是否一起清。
- 浏览器通道：本机 `@playwright/test@1.64.1` 期望的 chromium 版本没装，用
  `PLAYWRIGHT_CHANNEL=chrome` 复用本机 Chrome（同为 Chromium 内核，但**不是** CI 同一构建）。

## 8. 下一批

阶段 3.1：登录/工作台/通知/审计四页（约 704 行）。工作台是第一个会发业务请求的页面，
届时把「组织头注入」补上断言。
