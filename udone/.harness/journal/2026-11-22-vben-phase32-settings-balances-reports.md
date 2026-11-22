# 阶段 3.2：公司配置 / 资金账户 / 经营报表 迁移完成

日期：2026-11-22　工作副本：`D:\Coding\ERP\admin-clean`（Vben 5 骨架）
上一批：`2026-11-22-vben-phase31-auth-workbench-notify-audit.md`

## 做了什么

### 1. 三页迁移（端点 key 一个没改）

| 页面 | 路由 | 端点 |
|---|---|---|
| 公司配置 + 审批流 | `/config/company` | `getCompanySettings` / `updateCompanySettings` / `getApprovalFlow` / `updateApprovalFlow` |
| 资金账户 | `/finance/balances` | `listAccountBalances` / `createFundAccount` / `adjustAccountBalance` |
| 经营报表 | `/operations/reports` | `getTenantReport` / `getSupplierReport` |

- 三条占位路由（config / finance.balances / ops.reports）换成真实页面，占位只剩
  `/finance/receipts`、`/finance/applications`、`/finance/settlements`（阶段 3.5）。
- `lib/format.ts` 补 `formatMoney`（千分位 + 两位小数，负号在符号前）与 `formatRatio`
  （比值 ×100 保留一位，`null` 显示 `—` 而不是 `0.0%`）。金额一律服务端算，页面只格式化。
- 语言包 zh-CN / en-US 各加 `companySettings` / `balances` / `reports` 三个命名空间。
- 权限口径沿用旧前端：建账户 `settings.manage`、调余额 `finance.approve`
  （这两个**不是同一个权限**，财务能调余额但改不了公司配置）。

### 2. 修掉两个真缺陷（都不是我引入的，都已加闸）

**(a) 查询串布尔值 `'false'` 被解析成 `true`（后端）**

`reportQuerySchema.includeCancelled`、`notificationListQuerySchema.unreadOnly`、
`leadListQuerySchema.inPool` 都用了 `z.coerce.boolean()`。它走 `Boolean(value)`，
而查询串里的值永远是字符串 ⇒ `'false'` → `true`。三处实际后果：

- 报表：取消勾选「含已取消」，已取消订单照样算进应收/应付/利润；
- 通知：关掉「只看未读」，列表还是只剩未读；
- 线索：`inPool` 反过来。

`ops/catalog.ts` 的 `isActive` 早就在注释里写明「不能用 `z.coerce.boolean()`」，
所以这是同一规则在业务侧漏用。新增 `packages/contracts/src/http.ts` 的
`queryBooleanSchema`（只认 `'true'/'false'/'1'/'0'` 与真布尔，其余报 400），三处替换，
三条 route 测试各加一条 `=false` 用例。变异验证：把 reports 改回 `z.coerce.boolean()`，
新用例 1 failed。

**(b) 「二次确认」分支永远不触发（前端，旧前端同样中招）**

`api-client` 对错误体做的是 `ERROR_MESSAGES[code] ?? message` —— `VALIDATION_ERROR`
有条目，于是服务端文案被替换成「提交的内容不合法」。旧页面判断
`message.includes('confirmation')` 因此**恒为假**：改审批规则/订单规则只会看到
「提交的内容不合法」，怎么都存不进去。

修法不是改文案匹配，而是让 `ApiClientError` 带上服务端 `details`（第 5 个只读字段），
页面按契约里的 `details.field === 'confirmed'` 判定。这样以后同类「一个错误码多种原因」
都能靠 details 区分，不用猜文案。

### 3. E2E 覆盖（新增 2 个 spec / 4 条用例）

- `company-settings.e2e.ts`：①admin 勾上「下单必须收定金」→ 保存 → 断言弹确认框 →
  点确认 → 断言两次 PATCH 的 `confirmed` 分别是 false/true、`expectedVersion` 是 3、
  第二次请求里 `requireDeposit` 真的是 true；②operator 看得到配置但两个保存按钮都不存在、
  公司名输入框 disabled。
- `finance-reports.e2e.ts`：①资金账户展示服务端余额 `¥1,290.50`，调整弹窗提交体
  精确等于 `{accountId, amount, reason}`；②报表取数断言**发出去的 `includeCancelled`
  首次是 `'false'`**、勾上「含已取消」后是 `'true'`（前端侧能守的那一半）。

契约桩一律先过 schema：`adjustAccountBalance` 的响应是 `{adjustmentId}` 而不是 `{}`，
喂空对象会直接 `ContractViolationError`（第一版就这么翻的）。

## 为什么这么决定

- **不新增权限码**：沿用 `settings.manage` / `finance.approve`，与后端 `requirePermission`
  一一对应，避免出现「界面能点、服务端拒绝」的假授权。
- **审批流单独一块卡片**：它没有版本号语义（`set_approval_flow` 覆盖写），
  塞进公司配置表单会让「保存」按钮含义变模糊。级次增删后统一重排，不让用户填数字。
- **报表导出用页面已拿到的数据**：与页面同源，不再单独算一遍，避免两份口径。
- **公司配置是「整块替换」不是「局部合并」**：`update_company_settings` 做的是
  `data = excluded.data`，所以提交时**省略某个字段 = 删掉它**。这正好让「清空字典项」
  与「清空公司名」能生效，也意味着 payload 不能只发改动字段——本页每次发全量。
  空字典项必须就地剔除：契约里 `key/label` 都非空，否则整次保存被 400 拒掉。
- **`dist.zip` / `test-results/` 未提交**（构建后处理产物，已在 `.gitignore` 覆盖范围）。

## 验证证据

| 门禁 | 结果 |
|---|---|
| `vue-tsc --noEmit`（admin-clean） | 0 错误；错误探针 `const x: number = 's'` 报 TS2322，证明检查真的在跑 |
| `vite build --mode production` | ✓ 5.33s |
| `playwright test`（全量） | **16 passed / 56.9s**（含新增 4 条） |
| `pnpm typecheck`（udone） | api + web 通过 |
| `pnpm lint`（udone） | eslint + CSS token 通过 |
| vitest（udone 全量） | **74 文件 / 928 用例**（原 925，+3 条 =false 用例） |
| `local-db.mjs http`（udone） | **34 文件 / 455 用例**（首次 PostgREST 启动超时，重跑即过——老毛病） |
| 变异验证 | 报表改回 `z.coerce.boolean()` → 新用例 1 failed |

pgTAP 未跑：本批无数据库改动。

## 没做什么及原因

- **`/finance/receipts`、`/finance/applications`、`/finance/settlements`**：属阶段 3.5，
  仍是占位。
- **旧前端 `udone/apps/web` 的同一处 confirmation 缺陷没改**：它有自己的 `api-client` 副本。
  旧前端只保留到阶段 4 切换，改它等于给即将下线的代码加负担；已在回复中告知用户。
- **`z.coerce.boolean()` 的 ops 侧同名用法**（`ops/receivables`、`ops/tickets`）没动：
  ops 路由自己按字面量解析（`routes.ts:173` 有注释），不依赖 coerce。
- **公司配置表单的 Select 未做 label 关联**：断言只需要三个文本输入，多改无益。

## 范围外发现（已报用户，未改）

1. 旧前端 `CustomerRecycleBinView` 等 4 个文件的旧口径与本批无关，但提醒一句：
   `format:check` 在本机因 CRLF 恒红，**别当门禁信号**（按 LF 导出复验才可信）。
2. `admin-clean` 仍不在任何远端仓库，也不在 CI 覆盖范围，只有本机工作树 + tar 备份。
