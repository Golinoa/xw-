# 阶段 3.4 + 3.5：订单 / 游客名单 / 导入 / 收付款 / 审批申请 / 结算 / 线索

日期：2026-11-25 21:4x（收编当天工作树，补门禁与记录） · 工作副本：`D:\Coding\ERP\admin-clean`（独立 git，无 remote）
基线：`frontend-function-map.md` 第 5、7、8、9、17 行 + 弹窗清单（`OrderFormModal` 825 行 /
`OrderDetailDrawer` 562 / `TouristImportModal` 317 / `TouristRosterSection` 266 /
`TouristFormModal` 240 / `FinanceApplicationFormModal` 218 / `SettlementCreateModal` 281）

## 1. 做了什么

这一批把阶段 3.4 与 3.5 一起做完了（原本计划分两批）。工作树里六页全部落地，
占位路由归零，端点 key 一个没改。

| 路由 | 新文件（行数） | 旧文件（行数） |
|---|---|---|
| `/trade/orders` | `trade/order/index.vue` 525 | `orders/OrderListView.vue` 784 |
| 订单表单 | `trade/order/order-form-modal.vue` 511 | `OrderFormModal.vue` 825 |
| 订单详情 | `trade/order/order-detail-drawer.vue` 487 | `OrderDetailDrawer.vue` 562 |
| 订单内名单区 | `trade/order/tourist-roster-section.vue` 292 | `TouristRosterSection.vue` 266 |
| `/trade/tourists`（**新增页**） | `trade/tourists/index.vue` 128 | —（旧版名单只在订单详情里） |
| 游客表单 / 导入 | `tourist-form-modal.vue` 233 / `tourist-import-modal.vue` 280 | 240 / 317 |
| `/finance/receipts` | `finance/receipts/index.vue` 364 | `FinanceListView.vue` 559 |
| `/finance/applications` | `finance/applications/index.vue` 501 | `FinanceApplicationListView.vue` 749 |
| 申请表单 | `finance/finance-application-form-modal.vue` 203 | `FinanceApplicationFormModal.vue` 218 |
| `/finance/settlements` | `finance/settlements/index.vue` 391 | `SettlementListView.vue` 546 |
| 结算新建 | `settlements/settlement-create-modal.vue` 228 | `SettlementCreateModal.vue` 281 |
| `/customer/leads` | `crm/leads/index.vue` 410 | `crm/LeadListView.vue` 464 |

配套：
- 路由模块 `trade.ts` / `finance.ts` / `customer.ts` 的 `placeholder` 常量整块删除；
  六个列表路由补 `meta.fullPathKey: false`（理由同 3.3b：不然翻页就多开页签）。
- 语言包 `shell.{orders,tourists,receipts,applications,settlements,crmLeads}`，
  zh / en 各 420 行新增，逐键对齐。
- 展示层纯函数拆在 `order-display.ts` / `tourist-display.ts` / `receipts/finance-display.ts` /
  `applications/finance-application-display.ts` / `settlements/settlement-display.ts`，
  其中审批申请的文案/筛选/禁自审规则有 `finance-application-display.test.ts` 10 条单测。
- E2E：`e2e/phase3-final-pages.e2e.ts` 9 条（渲染 + 三个写端点/状态机：锁团必带原因、
  禁自审、作废必填原因）。
- `e2e/auth.e2e.ts` 的回跳落点从 `/trade/orders`（当时的占位页）换成 `/customer/list`
  并补三个业务桩——占位路由已归零，`待实现` 断言不再成立。
- `.github/workflows/web-antd-build.yml`：为 `apps/web-antd` 单独建 job（typecheck → lint →
  build → 校验 `dist/index.html` / `_app.config.js` / `dist/js` → 上传 artifact）。
- `pnpm-lock.yaml` 补上 `@supabase/supabase-js`（79 行）：`apps/web-antd/package.json` 早就
  声明了它，lockfile 里 0 处 ⇒ CI `--frozen-lockfile` 必挂。

## 2. 为什么这么决定

### 2.1 端点覆盖面按「旧页面调用了哪些 key」逐条对账，而不是按感觉

| 页面 | 旧页面/弹窗端点 | 新代码是否全有 |
|---|---|---|
| 订单 | `listOrders` `createOrder` `updateOrder` `getOrder` `transitionOrder` `getOrderFinance` | ✅ 全有，另加表单下拉用的 `listCustomers` `listRoutes` `listSuppliers` `getCustomer` |
| 游客名单 | `listTourists` `createTourist` `updateTourist` `deleteTourist` | ✅ |
| 导入 | `getTouristImportTemplate` `previewTouristImport` `importTourists` | ✅ |
| 收付款 | `listPayables` `listReceivables` | ✅ |
| 审批申请 | `listFinanceApplications` `decideFinanceApplication` `undoFinanceApplication` `withdrawFinanceApplication` `createFinanceApplication` | ✅（最后一个在申请表单弹窗里，挂在**订单详情金额行**，与旧版一致） |
| 结算 | `listSettlements` `getSettlement` `confirmSettlement` `cancelSettlement` `createSettlement` `listSettlementCandidates` | ✅ |
| 线索 | `listLeads` `createLead` `followUpLead` `convertLeadToOrder` `getLeadFunnel` | ✅ |

核对方式：新旧各 `grep -o "api\.call('<key>'"` 后取差集。这一步是为了防「页面看起来很完整、
其实少了一个动作」——旧版 6 个页面的写操作全部藏在弹窗/drawer 里，只看列表页会漏。

### 2.2 `/trade/tourists` 是**新增**页面，不是基线遗漏

功能地图里没有独立的游客页：旧版只能在某个订单的详情里看这份名单。
契约层本来就有 `listTourists`（按 `orderId` 过滤）与导入三件套，所以补了一个独立页，
用来做「跨订单查名单 + 批量导入」。旧路径（订单详情内嵌名单）也保留了，两条入口并存。
判断依据：这不是新增业务能力，只是把已有端点摆到台面上；后端一行没改。

### 2.3 权限门控沿用旧页面的口径，不「统一化」

- 收付款 / 审批申请看列表要 `ORDER_READ`，结算要 `FINANCE_WRITE`——旧版就是这样
  （结算页第一行 `canRead = permissions.includes(FINANCE_WRITE)`）。
  看着不一致，但服务端就是这么校验的，统一反而会造出「点了没反应」的死角。
- 审批的「禁自审」不改前端宽松度：自己提交的申请不显示通过/驳回按钮（`decidedBy` 比较当前
  `user.id`），并且有用例钉住。服务端仍独立校验。

### 2.4 证件号/手机号掩码不在前端判断

名单区继续用 `tourist.documentNumber ?? tourist.documentNumberMasked` ——
「给原值还是给掩码」由服务端按权限决定，前端只挑有值的那一个。旧版注释里已经写明这一点，
迁移照抄，不自己加判断（否则等于把权限口径复制到第三处）。

### 2.5 订单只存名称快照，不做关联查询

订单列表/详情展示的线路名、客户名一律读订单上的快照字段；表单里选线路/客户只用于**写入时**
取当前名称与金额。这是 C4 定下的口径（pgTAP 断言过「线路改名后订单不变」），迁移没有回退它。

## 3. 验证证据

本机（2026-11-25 21:4x，HEAD = 3.3b 之后的工作树）：

| 门禁 | 结果 |
|---|---|
| `vue-tsc --noEmit --skipLibCheck` | **0 错**，并用探针（`const probe: number = 's'`）复验「零输出不是没跑」→ 报 TS2322 |
| `eslint apps/web-antd`（仓库根跑，整 app） | **0 问题** |
| `vite build --mode production` | **5.76s 成功**；`dist/index.html` + `_app.config.js` + `dist/js/*` 均产出 |
| `vitest run --dir apps/web-antd/src/views/finance/applications` | **1 文件 / 10 用例全过** |
| 占位路由 | `grep placeholder src/router/routes/modules/` → **0 命中** |
| 端点覆盖 | 上表 7 行逐条对账，无缺失 |

当天早些时候的真浏览器验证（记录在 `.workbuddy/memory/2026-11-25.md`，本轮未重复跑）：
dist 预览 6 页 0 占位、0 控制台错误、5 个弹层可打开；订单新建弹窗 3 条
`ERR_CONNECTION_TIMED_OUT` 是预览 mock 没桩供应商/线路下拉，不是代码错误。

## 4. 没做什么及原因

1. **E2E 9 条没有在本机跑出 `passed` 汇总**：runner 全部用例执行完、零失败报告，
   但主进程卡在 `worker-0 process did not exit within 300000ms`（workers=1/2 都一样，
   Chrome 已退出）。已判定为本机 Playwright 主进程 ↔ Vite webServer 句柄问题，
   **不再换调用方式试**。CI（Linux、无本机 Chrome）应能正常收尾，但**尚未真实验证**。
2. **`admin-clean` 推不上去**：它是独立 git 根目录、没有 remote（根仓库 `.gitignore` 排除它）。
   要真跑 GitHub Actions，得先建仓库 + `git remote add` + push——这是用户侧动作。
3. **阶段 4 收尾切换没做**：默认路由指向新工程、旧 `apps/web` 保留回退、CI 挂新工程门禁、
   功能地图加「迁移状态」列。前三项都涉及上线决策（什么时候切流量），需要用户点头。
4. **udone 侧门禁没跑**：本批只改 `admin-clean` 前端与文档，udone 的 DB/契约/服务零改动
   （`git status` 可证），按「只跑受影响模块」原则跳过 pgTAP / vitest / http 集成。

## 5. 范围外发现（未改，已上报）

- 根仓库 `scripts/` 下有一批**当天会话留下的探针脚本**（`verify-all-pages.mjs`、
  `local-preview-server.mjs`、`gen-mock-fixtures.mjs`、`i18n-phase{A,B,C}.json` 与
  `apply-i18n-phase*.mjs`），均未纳入 git。它们是一次性工具，**有意不提交**，
  内容已由 journal 与记忆记录；需要复跑验证时可直接用。
- `apps/web-antd` 页面权限门控多为 setup 期一次性求值（`const canRead = (() => …)()`），
  与旧版 `computed` 略有差异。9 个页面都是这个写法，真浏览器验证未暴露问题
  （组织信息在守卫阶段已就绪），本批不动；若要统一，应作为独立小批替换。
