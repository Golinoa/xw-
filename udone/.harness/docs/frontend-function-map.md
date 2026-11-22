# udone 前端功能地图（迁移基线）

生成时间：2026-11-20 13:1x。用途：Vben Admin 迁移的**唯一功能基线**。
任何页面在迁移后都必须能在这里找到对应条目，否则算功能丢失。

## 0. 现状纠正（先读）

项目**不是"没用 UI 组件库"**。现状是：

- Vue 3.5 + Vite 7.3 + vue-router 5 + **ant-design-vue 4.2.6**
- `apps/web/src/design-system/tokens.ts`：自建设计令牌（颜色/间距/字号/圆角），
  经 `ConfigProvider` 注入；30 个页面里 32 个使用 CSS 变量
- `antd-registration.ts`：全局按需注册 28 个组件（避免全量注册导致首 chunk 1.87 MB）

**"丑"的真正原因**：只有裸组件，缺 Admin 脚手架的布局骨架——
手写顶部导航、`AppLayout.vue` 236 行、无侧边栏/页签/面包屑、表格没有搜索区与工具栏。
所以迁移的目标是**换布局骨架 + 复用共享契约**，不是"从零做 UI"。

## 1. 页面清单（15 个路由 / 30 个 .vue）

| # | 路由 | 页面 | 主文件 | 行数 | 主 API |
|---|---|---|---|---:|---|
| 1 | `/login` | 登录 | `LoginView.vue` | 196 | Supabase Auth + CAPTCHA |
| 2 | `/` | 工作台 | `HomeView.vue` | 36 | — |
| 3 | `/customers` | 客户列表 | `customers/CustomerListView.vue` | 667 | listCustomers 等 14 个 |
| 4 | `/customers/recycle-bin` | 客户回收站 | `customers/CustomerRecycleBinView.vue` | 326 | listDeletedCustomers / restoreCustomer |
| 5 | `/orders` | 订单列表 | `orders/OrderListView.vue` | 784 | listOrders 等 12 个 |
| 6 | `/suppliers` | 供应商 | `suppliers/SupplierListView.vue` | 392 | list/create/update/deleteSupplier |
| 7 | `/finance` | 收付款 | `finance/FinanceListView.vue` | 559 | listPayables / listReceivables |
| 8 | `/finance/applications` | 审批申请 | `finance/FinanceApplicationListView.vue` | 749 | 6 个申请端点 |
| 9 | `/settlements` | 结算批次 | `settlements/SettlementListView.vue` | 546 | 6 个结算端点 |
| 10 | `/company-settings` | 公司配置+审批流 | `settings/CompanySettingsView.vue` | 378 | 4 个配置端点 |
| 11 | `/audit-events` | 审计日志 | `audit/AuditListView.vue` | 239 | listAuditEvents / Facets |
| 12 | `/notifications` | 通知 | `notifications/NotificationListView.vue` | 233 | 2 个通知端点 |
| 13 | `/balances` | 资金账户 | `balances/BalanceListView.vue` | 256 | 3 个账户端点 |
| 14 | `/reports` | 经营报表 | `reports/ReportListView.vue` | 282 | getTenantReport / getSupplierReport |
| 15 | `/routes` | 线路 | `routes/RouteListView.vue` | 208 | 4 个线路端点 |
| 16 | `/customer-sources` | 客户来源 | `customer-sources/CustomerSourceListView.vue` | 256 | 4 个来源端点 |
| 17 | `/leads` | CRM 线索 | `crm/LeadListView.vue` | 464 | 5 个线索端点 |

（`/login` 与 `/` 在 layout 外，其余 15 个在 `AppLayout` 内；上表共 17 条。）

## 2. 弹窗 / 抽屉（14 个，必须逐个迁）

| 组件 | 行数 | 归属页面 |
|---|---:|---|
| `orders/OrderFormModal.vue` | 825 | 订单 |
| `orders/OrderDetailDrawer.vue` | 562 | 订单 |
| `orders/TouristImportModal.vue` | 317 | 订单 |
| `orders/TouristRosterSection.vue` | 266 | 订单（内嵌区） |
| `orders/TouristFormModal.vue` | 240 | 订单 |
| `customers/CustomerFormModal.vue` | 359 | 客户 |
| `customers/CustomerDetailDrawer.vue` | 226 | 客户 |
| `customers/CustomerTagManagerModal.vue` | 277 | 客户 |
| `customers/CustomerBatchTagModal.vue` | 131 | 客户 |
| `finance/FinanceApplicationFormModal.vue` | 218 | 审批申请 |
| `settlements/SettlementCreateModal.vue` | 281 | 结算 |
| `suppliers/SupplierFormModal.vue` | 196 | 供应商 |
| `routes/RouteFormModal.vue` | 204 | 线路 |
| `crm/`（无独立弹窗，全部内联） | — | 线索 |

## 3. API 调用面

- **69 个契约端点**被前端调用，全部经 `@erp/contracts` 的 zod schema 校验
  （`apps/web/src/lib/api-client.ts`：请求体/响应体双向校验）。
- 页面 → API 映射见本节附表；迁移时**端点 key 一个都不能变**。

## 4. 认证与权限

- 登录：Supabase Auth `signInWithPassword`，会话存 **sessionStorage**（关闭标签页即失效）
- 组织切换：`auth.switchOrganization`，所有请求带 `X-Organization-ID`
- 权限码（前端隐藏入口用，服务端独立校验）：
  `ORDER_READ/WRITE`、`CUSTOMER_READ/WRITE/RESTORE`、`SUPPLIER_READ/WRITE`、
  `ROUTE_WRITE`、`FINANCE_WRITE/APPROVE`、`SETTINGS_MANAGE`、`AUDIT_READ`
- `ALLOW_LOCAL_JWT_AUTH`：本地/CI 自签令牌通道，生产禁用

## 5. 必须保住的测试资产

| 层 | 数量 | 内容 |
|---|---:|---|
| pgTAP | 50 文件 | 数据库约束、RLS、事务 |
| HTTP 集成 | 34 文件 / 455 用例 | 真实 PostgREST 链路 |
| Vitest | 74 文件 / 920+ 用例 | API/契约/工具 |
| E2E | 7 spec / 25 条（24 通过 1 跳过） | 真浏览器 + 契约桩 |
| 契约包 | 33 个 schema 文件 | 响应体运行时校验 |

**迁移红线**：不能为了 UI 改造删掉契约校验、降级测试覆盖、或让 E2E 从"真浏览器"退化成快照测试。

## 6. Vben 侧可复用资产（仓库内已有）

`D:/Coding/ERP/admin` 是 **Vben Admin 5.7.0**（`vben-admin-monorepo`），
但属于**另一个业务**：有单软件运营后台（`apps/web-antd`），不是旅行社 OMS。

可复用的**代码模式**（不是业务代码）：

- `apps/web-antd/src/router/index.ts` + `router/routes/`：路由与访问守卫
- `apps/web-antd/src/api/request.ts`：统一请求内核（业务 JSON 直出、无信封、
  `X-Request-Id`、401 单飞刷新、5xx 退避重试）——与当前 `api-client.ts` 职责对应
- `apps/web-antd/src/views/_core/`：登录、403、404、500、个人设置等骨架页
- `apps/web-antd/src/adapter/`、`store/`、`preferences.ts`

**不可复用**：其登录实现走 `/api/ops/auth/login`，不是 Supabase Auth；
业务页面（ops 域）与旅行社 OMS 无关。

## 7. 环境约束（迁移必须先解）

- 🔴 `admin/` 的 `node_modules` **残缺**（无 vite/vue 根包），且项目红线：
  **禁止在沙箱里重装 admin 依赖**（39 个 workspace 会把 pnpm 卡死，已多次踩坑）。
  ⇒ 迁移不能在沙箱里跑通 Vben 构建；依赖安装需用户在自己终端执行，
    或在新位置建立**独立的精简 Vben 工程**而非复用 39-workspace 大仓。
- 🔴 当前 E2E 的 `api-stub.ts` 拦截 `/api/` 与 `/auth/v1/`，Vben 若改请求层/认证路径，
  桩必须同步改造，否则 25 条用例全废。
- 🔴 `format:check` 覆盖 `.github/` 与 `../.workflow/`，迁移中改 CI 配置会被格式门禁检查。

## 附：页面 → API 详细映射

- audit: listAuditEvents, listAuditFacets
- balances: adjustAccountBalance, createFundAccount, listAccountBalances
- crm: convertLeadToOrder, createLead, followUpLead, getLeadFunnel, listLeads
- customers: batchTagCustomers, createCustomer, createCustomerTag, deleteCustomer,
  deleteCustomerTag, getCustomer, listCustomers, listCustomerSources, listCustomerTags,
  listDeletedCustomers, restoreCustomer, updateCustomer, updateCustomerTag
- customer-sources: create/delete/list/updateCustomerSource
- finance: createFinanceApplication, decideFinanceApplication, listFinanceApplications,
  listPayables, listReceivables, undoFinanceApplication, withdrawFinanceApplication
- notifications: listNotifications, markNotificationsRead
- orders: createOrder, createTourist, deleteTourist, getOrder, getOrderFinance,
  getTouristImportTemplate, importTourists, listOrders, listTourists,
  previewTouristImport, transitionOrder, updateOrder, updateTourist
- reports: getSupplierReport, getTenantReport
- routes: createRoute, deleteRoute, listRoutes, updateRoute
- settings: getApprovalFlow, getCompanySettings, updateApprovalFlow, updateCompanySettings
- settlements: cancelSettlement, confirmSettlement, createSettlement, getSettlement,
  listSettlementCandidates, listSettlements
- suppliers: createSupplier, deleteSupplier, listSuppliers, updateSupplier

## 8. 迁移状态（Vben 侧）

| 路由 | 旧页面 | 新位置 | 状态 |
|---|---|---|---|
| `/login`、`/auth/forget-password` | `LoginView.vue` | `views/_core/authentication/*` | ✅ 2026-11-22（含 CAPTCHA / 邀请 / 设新密码） |
| `/` → `/workbench` | `HomeView.vue` | `views/workbench/index.vue` | ✅ 2026-11-22（含成员与邀请） |
| `/notifications` → `/operations/notifications` | `NotificationListView.vue` | `views/operations/notifications/index.vue` | ✅ 2026-11-22 |
| `/audit-events` → `/operations/audit` | `AuditListView.vue` | `views/operations/audit/index.vue` | ✅ 2026-11-22 |
| `/company-settings` → `/config/company` | `CompanySettingsView.vue` | `views/config/company/index.vue` | ✅ 2026-11-22（含审批流与二次确认） |
| `/balances` → `/finance/balances` | `BalanceListView.vue` | `views/finance/balances/index.vue` | ✅ 2026-11-22（建账户 + 调余额） |
| `/reports` → `/operations/reports` | `ReportListView.vue` | `views/operations/reports/index.vue` | ✅ 2026-11-22（含 CSV 导出） |
| 客户 / 回收站 / 来源 / 线路 / 供应商 | 5 页 + 6 弹窗 | — | ⬜ 阶段 3.3 |
| 订单 / 游客名单 / 导入 | 5 页 + 5 弹窗 | — | ⬜ 阶段 3.4 |
| 收付款 / 审批申请 / 结算 / 线索 | 4 页 + 2 弹窗 | — | ⬜ 阶段 3.5 |

顶栏已补回旧 `AppLayout` 的两项壳层功能：公司切换（`header-widgets.vue`）与未读角标。
成员面板仍按 `userId` 更新（原样迁移），改成列表点选需要产品口径，未自决。
