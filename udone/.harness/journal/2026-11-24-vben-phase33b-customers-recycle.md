# 阶段 3.3b：客户列表 / 回收站 / 4 个弹窗迁移

日期：2026-11-24 03:5x · 工作副本：`D:\Coding\ERP\admin-clean`（独立 git，无 remote）
基线：`frontend-function-map.md` 第 3、4 行与弹窗清单（`CustomerFormModal` 359 行 /
`CustomerDetailDrawer` 226 / `CustomerTagManagerModal` 277 / `CustomerBatchTagModal` 131）

## 1. 做了什么

| 页面 | 新文件 | 旧文件（行数） |
|---|---|---|
| `/customer/list` | `views/customer/list/index.vue` 367 行 | `CustomerListView.vue` 667 |
| `/customer/recycle` | `views/customer/recycle/index.vue` 271 行 | `CustomerRecycleBinView.vue` 326 |
| 客户表单 | `views/customer/list/customer-form-modal.vue` 375 行 | `CustomerFormModal.vue` 359 |
| 客户详情 | `views/customer/list/customer-detail-drawer.vue` 246 行 | `CustomerDetailDrawer.vue` 226 |
| 标签管理 | `views/customer/list/customer-tag-manager-modal.vue` 232 行 | `CustomerTagManagerModal.vue` 277 |
| 批量打标 | `views/customer/list/customer-batch-tag-modal.vue` 148 行 | `CustomerBatchTagModal.vue` 131 |

配套：
- `views/customer/display.ts`：证件类型 → 文案键映射（值只在这一处维护）。
- `lib/format.ts` 新增 `displayText`，`views/trade/display.ts` 改为**转出**它：
  同一个「字段没填显示 —」的规则原来在 trade 里，客户页再抄一份就是第三份副本。
- 路由：`customer.ts` 的两个占位改为真实组件。
- 语言包：`shell.customers`（119 键）/ `shell.customerRecycle`（24 键），zh / en 逐键对齐。
- 端点 key 一个没改：`listCustomers` / `createCustomer` / `getCustomer` / `updateCustomer` /
  `deleteCustomer` / `listDeletedCustomers` / `restoreCustomer` / `listCustomerTags` /
  `createCustomerTag` / `updateCustomerTag` / `deleteCustomerTag` / `batchTagCustomers` /
  `listCustomerSources`。
- E2E：`e2e/customer-list.e2e.ts` 6 条。

## 2. 为什么这么决定

### 2.1 URL 仍是列表状态的唯一来源（但顺手治了它的副作用）

旧页面把 `page/pageSize/sort/order/keyword/tagId` 写进查询串，刷新、前进后退、
把链接发给同事都能还原同一页——这是功能，不能因为迁移顺手丢掉。

代价是 Vben 的页签默认按 `fullPath` 去重（`packages/stores/src/modules/tabbar.ts`
的 `getTabKey`），每翻一页就会多开一个页签。上游给了正解：
路由 `meta.fullPathKey: false` 让页签按 `path` 去重（该分支有单测
`tabbar.test.ts` 覆盖）。所以「客户列表」这一条路由显式标了这个 meta，
其余路由不动。

### 2.2 修掉旧页面一句**过期**的文案（真缺陷）

`CustomerDetailDrawer.vue` 的删除确认框写着「当前版本暂不支持自助恢复」。
但 B2 之后删除是软删除、`customer.restore` 的同事能在回收站还原，回收站页面
自己就写着「恢复后客户会重新出现在客户列表里」。两句口径互相矛盾，
一句让用户以为删了就没了 —— 这种文案会直接改变用户点不点「删除」。
新页面改成：数据进回收站、有恢复权限的人可还原、历史单据仍保留引用。

### 2.3 搜索关键字超过 100 字会让整页「加载失败」

`customerListQuerySchema.keyword` 上限 100。旧输入框没有 `maxlength`，
`readState()` 只在**读 URL 时**裁到 100，用户在框里打 101 个字照样发出去 ⇒
客户端契约校验抛 `ContractViolationError`（`api-client` 双向校验）⇒ 页面进错误态，
提示「客户列表加载失败」。用户根本猜不到是自己输入太长。

处理：输入框 `:maxlength="100"`，提交时再 `slice(0, 100)` 兜一层
（粘贴、IME、脚本赋值都可能绕过 maxlength），E2E 用 120 个字钉住。

### 2.4 停用的来源不能掉出下拉（否则编辑表单显示 UUID）

客户表单原来调 `listCustomerSources()` 且只留 `isActive` 的项。服务端默认只回启用项，
所以「客户挂着一个后来被停用的来源」时，选项表里没有它，`Select` 就把
**原始 UUID** 直接显示在来源框里。用户看到一坨 UUID，以为数据坏了。

处理：改成 `{ includeInactive: '1' }` 全量取，停用项标注「（已停用）」并 `disabled`。
停用项只用于展示既有值，不能再被选中。E2E 断言编辑时能看到「门店到访（已停用）」。

### 2.5 换公司要清掉跨租户的界面状态

旧页面只重拉列表：勾选行、打开的详情抽屉、重复提示都会留着。切公司后这些
指向的是上一家的客户 ID，批量打标一旦点到就打到不存在的数据上。新页面在
组织切换时一起清掉（列表页：选择 + 抽屉 + 重复提示；回收站：关键字 + 页码）。

### 2.6 敏感字段的三条规则（逐条对照旧的实现，未改语义）

1. 列表只渲染 `*Masked`，原值不上列表。
2. 详情：服务端给了原值才显示原值，否则显示掩码并**明确标注「（掩码）」**——
   让掩码冒充原值比不显示更危险。
3. 编辑：只有「有原值」或「压根没有掩码」才允许编辑证件/电话；读不到原值时
   请求体里**连键都不出现**（契约里缺失=不修改、null=清空，发错就是抹掉数据）。
   E2E 断言 `'phone' in body === false`。

### 2.7 批量打标走一个端点（旧的决策继续沿用）

`batchTagCustomers` 一次提交 `customerIds + addTagIds/removeTagIds`，不循环 PATCH：
循环会在第 N 个失败时留下「前 N-1 个已改」的中间态，用户重试还会重复打标。
勾选状态在换页/换筛选/换公司时一律清空，避免作用到看不见的行。

## 3. 顺手修掉的既有问题（范围外，已在交付时报给用户）

跑 `eslint apps/web-antd`（= 项目 `pnpm lint` 的实际入口 `eslint .` 的同一套配置）时，
发现前几批交付的文件里**积了 27 条 lint 错误**，也就是说仓库 lint 门一直是红的：

- 4 个 e2e 文件 `@erp/contracts` 排在 `@playwright/test` 之后（`perfectionist/sort-imports`）；
- `lib/api-client.ts` / `store/auth.ts` 的 `catch (cause)` 命名、联合类型顺序、
  `.replace(/g)` → `.replaceAll`；
- `views/config/company`、`finance/balances` 的具名 import 顺序；
- `operations/reports` 的 `\ufeff` 大小写；
- `apps/web-antd/package.json` 里 `@supabase/supabase-js` 是裸版本号，
  `pnpm/json-enforce-catalog` 要求走 `catalog:`（版本号不变，1 行）。

全部按 eslint 自身的 autofix 处理，随后用「`vue-tsc` 0 + 全量 E2E 27 通过」证明
没有行为改变。**为什么必须现在修**：这批之前每轮只 lint「本次新增文件」，
所以门一直是红的却没人发现；只修自己那 6 个文件等于继续把红门传下去。

顺带：`oxlint` 从 8 条降到 7 条（`store/auth.ts` 的冗余 return 被 eslint 一并修掉），
剩余 7 条全是 `lib/api-client.ts` 的既有非空断言。

## 4. 验证证据

| 门禁 | 结果 |
|---|---|
| `vue-tsc --noEmit`（admin-clean） | 0 错误（探针 `const x: number='s'` 报 TS2322，证明检查真的在跑） |
| `vite build --mode production` | ✓ 4.77s，7328 模块，弹窗各自独立 chunk |
| `playwright test`（全量） | **27 passed / 1.7m**（原 21 + 新增 6） |
| `playwright test e2e/customer-list.e2e.ts` | 6 passed / 36.2s |
| `eslint apps/web-antd`（整 app） | **0 问题** |
| `oxlint apps/web-antd` | 7 errors（全部为 `lib/api-client.ts` 既有非空断言，未新增） |
| i18n 键对齐 | `customers` 119/119、`customerRecycle` 24/24，代码里 144 个 `$t` 键全部命中 |
| 变异验证 | `clearPhone` 改成恒 true + `includeIdentity` 改成 true ⇒ 客户 spec **1 failed**（恢复后全绿） |

新增 E2E 6 条（`e2e/customer-list.e2e.ts`）：
1. 列表只渲染掩码（原文号码 0 次出现）+ 勾选后批量打标请求体精确等于选中行。
2. 无 sensitive 权限时编辑：请求体不带 `phone/email/idNumber` 键；抽屉显示「（掩码）」；
   停用来源显示「门店到访（已停用）」而不是 UUID。
3. 列表状态来自 URL（page/sort/order/keyword），120 字关键字被截到 100。
4. 新建客户只发填过的字段（`{name, tagIds: []}`）。
5. 财务角色：无新建/标签管理/回收站入口；直接访问回收站显示无权限。
6. 回收站列表 + 恢复打对端点 + 提示。

## 5. 踩到的坑（下次直接用）

1. **块注释里不能出现 `**/`**：`**/api/customers**` 里的 `*/` 会提前结束注释，
   报错是 `Parsing error: Expression expected`，位置还指在注释行上。
   写 glob 说明时避开 `**/`。
2. **`eslint` 必须从仓库根跑**：`vsh lint` 实际执行的是根目录的 `eslint .`。
   在 `apps/web-antd` 里直接跑 `eslint <相对路径>` 会因为 `tsconfigRootDir` 落到
   `tsconfig.node.json`，把 `.ts` 文件报成 `Parsing error`（假错误）。
3. **`eslint --fix` 会连 `package.json` 一起改**：antfu 配置带 `eslint-plugin-pnpm`，
   `pnpm/json-enforce-catalog` 会把裸版本号改写成 `catalog:` 并往
   `pnpm-workspace.yaml` 加一行。这是仓库自己的规则，不是意外，但要知道它在改依赖声明。
4. **`unicorn/prefer-includes` 的 autofix 会打断类型守卫**：
   `CUSTOMER_SORT_FIELDS.some(f => f === value)` 被改成 `.includes(value)` 后，
   元组的字面量类型让参数收窄，`vue-tsc` 立刻报 TS2345。守卫里要写
   `(CONST as readonly string[]).includes(value)`。
5. **占位页被真实化会打破别人的用例**：`auth.e2e.ts` 用 `/customer/list` 当「登录后回跳」
   的落点并断言 `待实现`。客户列表真实化后该断言必红。已把落点换成仍是占位的
   `/trade/orders`，并在注释里写明「订单页 3.4 迁移后要再换」。
6. **E2E 桩按 `pathname` 分派，不要按 glob 分散注册**：一条 `/api/customers` 的 glob 会把
   `batch-tags`、`recycle-bin`、`/:id` 一起吃掉，谁先命中取决于注册顺序；
   `/:id` 的正则也不会匹配 `/:id/restore`（子路径要单独一条）。
7. 客户表单打开时会拉来源，不放 `/api/customer-sources` 的桩会漏到真网络
   （vite 代理 ECONNREFUSED），页面看起来正常、下拉其实是空的。

## 6. 没做什么及原因

- **udone 侧没跑 pgTAP / vitest / `db:local.mjs http`**：本批没有数据库迁移、没有服务端
  代码、没有契约改动（`customers.ts` 一行没动），也没有改动 `udone` 源码（只写了文档与本
  journal）。按门禁分级，跑这三项只是烧时间。
- **订单页的客户下拉 / 订单详情里的客户信息**：订单页在阶段 3.4，接线在那一批。
- **`ok-text` 等按钮的 i18n 之外的语言包**（zh-TW 等）：仓库只有 zh-CN / en-US 两套。
- **`admin-clean` 仍无 remote**：结构性遗留未变，源码只在本机工作树 + tar 快照里
  （已第三次报给用户）。
- **`pnpm-lock.yaml` 与 `apps/web-antd/package.json` 不同步**：lockfile 里根本没有
  `@supabase/supabase-js` 条目（`grep -c` 为 0），这份工作副本的 lockfile 早就不是
  可 `--frozen-lockfile` 的状态。不在本批修（要重装依赖，触碰环境红线）。
