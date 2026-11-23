# 阶段 3.3a：来源 / 线路 / 供应商三页迁移

日期：2026-11-24 01:4x · 工作副本：`D:\Coding\ERP\admin-clean`（独立 git，无 remote）
基线：`frontend-function-map.md` 第 4、6、15、16 行；卡片：`vben-migration-plan.md` 阶段 3.3（拆成 3.3a / 3.3b）

## 1. 做了什么

| 页面 | 新文件 | 旧文件（行数） |
|---|---|---|
| `/trade/suppliers` | `views/trade/suppliers/index.vue` + `supplier-form-modal.vue` | `SupplierListView.vue` 392 + `SupplierFormModal.vue` 196 |
| `/trade/routes` | `views/trade/routes/index.vue` + `route-form-modal.vue` | `RouteListView.vue` 208 + `RouteFormModal.vue` 204 |
| `/customer/sources` | `views/customer/sources/index.vue`（弹窗内联，与旧前端一致） | `CustomerSourceListView.vue` 256 |

配套：
- `views/trade/display.ts`：供应商类型/结算方式的**文案键**表 + 枚举顺序 + `displayText`。
  旧前端把中文写死在 `supplier-display.ts` 里，新版必须走语言包（en-US 才有意义）。
- 路由模块：`trade.ts` / `customer.ts` 的两个/一个占位项改为真实组件。
- 语言包：`shell.suppliers` / `shell.tourRoutes` / `shell.customerSources`，
  zh-CN 与 en-US **逐键对齐**（各 76 行，纯新增，没动既有键）。

端点 key 一个没改：`listSuppliers` / `createSupplier` / `updateSupplier` / `deleteSupplier` /
`listRoutes` / `createRoute` / `updateRoute` / `deleteRoute` /
`listCustomerSources` / `createCustomerSource` / `updateCustomerSource` / `deleteCustomerSource`。

## 2. 为什么这么决定

### 2.1 为什么拆成 3.3a / 3.3b

原 3.3 是「5 页 + 8 个弹窗 ≈ 1,849 行」，一次做完的质量风险集中在客户页
（667 行 + 4 个弹窗 + 掩码 + 批量打标 + 回收站恢复）。按「字典页 / 客户页」切开后，
3.3a 是无跨行状态的纯主数据 CRUD，可以先锁住这三张字典的语义；客户那批留给下一个单元，
注意力全在敏感字段与跨行勾选上。

### 2.2 修掉一个既有真缺陷：客户来源「停用即失踪」

服务端 `/api/customer-sources` 默认只回启用项（`includeInactive !== '1'` 时追加
`is_active=is.true`），而旧前端调 `listCustomerSources()` **不带任何参数** ⇒
用户在来源管理页点一次「停用」，这一行从列表里消失，**再也没有地方点「启用」**。
页面自己的说明文字还写着「停用后…仍可在这里恢复」，实际做不到。

处理：
- `contracts/src/customers.ts` 新增 `customerSourceListQuerySchema`
  （`{ includeInactive?: '0' | '1' }.default({})`），`ROUTES.listCustomerSources` 挂上 `request`。
  用 `.default({})` 而不是必填对象：客户表单只要启用项，**不传参数是正常用法**，
  不能让旧前端的 `call('listCustomerSources')` 变成契约违例。
- 新页面显式传 `{ includeInactive: '1' }`。
- 单测 `contracts/src/customers.test.ts`（3 条）：不传合法 / `'1'` 合法 /
  `'true' | 'yes' | true` 必须被拒（服务端只认 `=== '1'`，其余静默当 false，这种歧义要在契约里挡住）。
- E2E 断言列表请求 URL 必带 `includeInactive=1`，且停用项以「停用」标签渲染出来。

### 2.3 线路页补分页器（有意的小改动）

旧页面固定 `page: 1, pageSize: 50` 且没有翻页控件 ⇒ 第 51 条之后的线路在界面上**根本不存在**，
只能靠搜索碰运气。契约本来就有分页，新页面用 `Pagination` 接上（默认 15 条，与全站一致）。

### 2.4 表单控件补 `id` + `html-for`

旧页面的 `label` 与控件之间没有任何 `for/id` 关联（antd-vue 不会自动生成），
键盘与读屏都用不了，E2E 也只能靠 DOM 结构猜。新页面统一 `html-for="xxx"` + 控件 `id`，
`getByLabel('线路名称')` 直接可用。

### 2.5 语义对齐的两处「不能合并」

- 新建：省略空可选字段（`...(x.trim() ? { x } : {})`）。
- 编辑：空值发 `null`（表示清空），否则「清掉一个填错的手机号」永远改不回去。
  两个弹窗都按这个规则写，与旧前端一致。

### 2.6 删除语义：供应商与线路相反，这是设计要求

- 供应商被应付行引用时服务端回 409 `OBJECT_REFERENCED` ⇒ 页面必须提示**「改为停用」**
  而不是通用「删除失败，请重试」（后者会让用户反复点删除）。
- 线路删除不阻断：订单存的是线路名称快照，删主数据不影响历史单。

## 3. 验证证据

| 门禁 | 结果 |
|---|---|
| `vue-tsc --noEmit`（admin-clean） | 0 错误 |
| `vite build --mode production` | ✓ 10.91s / 复跑 12.15s |
| `playwright test`（全量） | **21 passed / 1.8m**（新增 5 条） |
| `playwright test e2e/trade-master-data.e2e.ts` | 5 passed / 36.7s |
| `eslint`（新增/改动文件） | 0 问题 |
| `pnpm typecheck`（udone，api+web） | 通过 |
| `pnpm lint`（udone，eslint + CSS token） | 通过 |
| `vitest run`（udone） | **75 文件 / 931 用例通过**（原 74/928 + 新增 3 条契约用例） |

新增 E2E（`e2e/trade-master-data.e2e.ts`，5 条）：
1. 供应商列表渲染 + 新建请求体严格等于 `{name, settlement:'per_trip', type:'restaurant'}`
   （证明默认结算方式与「省略空字段」都对）。
2. 删除被引用供应商 ⇒ 提示「已被应付单据引用，不能删除；可以改为停用」。
3. 线路新建：自组团进 `isSelfGroup`、天数进 `days`；列表把「自组」标在类型列。
4. 客户来源：编辑时上级下拉 `disabled` + 提示语；新建可挂上级；列表请求带 `includeInactive=1`。
5. 财务角色（只有 `supplier.read`）看得到列表，但「新建/编辑/删除」一个都不渲染。

## 4. 踩到的坑（下次直接用）

1. **antd 会给两个汉字的中文按钮自动插空格**：`保存` → `保 存`、`删除` → `删 除`。
   `getByRole('button', { name: '保存' })` 直接超时，必须用 `/保\s*存/`。四个字以上不插。
2. **下拉选项不能用 `getByRole('option')`**：antd 在 combobox 里塞了一个 a11y 镜像 listbox，
   选项名是原始枚举值（`hotel`），点它没反应。正确做法是从 `.ant-select-dropdown` 里
   按可见文案点（`getByText('餐厅', { exact: true })`）。
3. **Playwright glob：`**/api/routes?**` 与 `**/api/routes` 是两个坑**。列表请求带查询串，
   只注册无查询串的那条会漏到真网络（现象：列表空白，看起来像页面没渲染）。
   本批统一用 `**/api/x**` 一个 handler 同时管 GET/POST。
4. **`Select` / `InputNumber` 的 `modelValue` 不接受 `null`**（vue-tsc 报
   `Type 'string | null' is not assignable to 'SelectValue'`）。表单内部一律用 `undefined`
   表示「未选」，提交时再映射成 `null` 或省略。
5. `perfectionist/sort-imports` 要求 `@erp/contracts` 排在 `@playwright/test` **之前**；
   `unicorn/no-await-expression-member` 禁止 `(await call(...)).sources`。

## 5. 没做什么及原因

- **客户列表 / 回收站 / 4 个弹窗**：下一批（3.3b）。这批刻意不碰，避免和掩码、批量打标、
  恢复端点混在一起。
- **订单页的线路/供应商下拉**：订单页还没迁移（阶段 3.4），下拉接线在那一批做；
  本批只保证这三个字典的列表与写入正确。
- **pgTAP / `db:local.mjs http` 没跑**：本批无数据库迁移、无服务端代码改动
  （`includeInactive` 服务端早就支持，`routes.test.ts:735` 已有用例）。只改了契约 + 前端。
- **`format:check` 没跑**：本机 CRLF 恒红（已知），新增文件按 LF 手写；`eslint`/`vue-tsc` 已过。
- **`admin-clean` 仍无 remote**：结构性遗留未变，源码只在本机工作树 + tar 快照里。
