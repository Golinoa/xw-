# 运营后台需求追踪表（R-ID 映射）

- 生成日期：2026-11-16
- 需求真源：`admin/Docs/PRD.md`（v1.0，433 行，2026-10-05 定稿）。**本次未修改 PRD**。
- 代码范围：`udone/`（后端 + 迁移 + 测试）与 `admin/apps/web-antd/`（运营前端）。
- 配套文档：发布侧证据见 [`RELEASE-READINESS.md`](./RELEASE-READINESS.md)。

## 0. 为什么需要本表

PRD 只有章节号，没有可引用的需求编号（`grep "R-[0-9]"` 无命中），因此执行计划 Task 4 第 8 条、Task 5 第 8 条要求的「PRD R-ID 追踪」和 Task 9 第 1 条要求的「P0 R-ID → 页面/API/迁移/RLS/审计/测试/环境 映射」都无法落地。

本表**新建**一套 R-ID 体系，挂在 PRD 之外，不回写 PRD。编号一旦给出不再改动；后续新增需求只追加。

## 1. 编号规则

- 格式：`R-<PRD 一级章号>-<两位序号>`，例如 `R-6-28`。
- 序号在**章内**递增，顺序与 PRD 行文一致（自上而下、自左而右）。
- 章号取 PRD 一级章节：`4` 用户与权限、`6` 功能需求、`9` 数据与接口边界、`10` 非功能要求。
- PRD §1/§2/§3/§5/§7/§8/§11/§12/§13/§14 不单独编号，理由见 §5「编号范围说明」。

## 2. 状态定义

| 状态 | 判定标准 |
| --- | --- |
| 已实现有测试 | 后端或前端存在落点，且**同一域**内存在自动化测试（pgTAP / Vitest 集成 / 组件测试 / e2e） |
| 已实现无测试 | 落点存在，但找不到针对该条目的的自动化断言 |
| 未实现 | 找不到落点，或只有字段/占位而无执行路径 |
| 需 staging 验证 | 本地已有实现或本地可验，但验收条件（真实环境、压测、跨系统）只能在 staging 完成 |

## 3. 取证口径与限制（必读）

1. **本轮未执行任何测试命令。** 状态依据是源码/迁移/pgTAP/测试文件的静态核对，叠加既有运行记录（45 个迁移、37 个 pgTAP、单元 65 文件 863 用例、HTTP 集成 24 文件 402 用例、e2e 5 spec 11 用例）。`admin` 侧依赖正在重装，按指令未跑 `quality:check`。
2. **「已实现有测试」不等于「每条断言逐字覆盖」。** 它表示该需求所在域存在真实测试文件；具体断言颗粒度差异见各行备注。
3. **路径前缀约定**（为压窄表格宽度）：
   - 后端列：相对 `udone/`，如 `supabase/migrations/...`、`apps/api/src/...`、`tests/integration/...`。
   - 前端列：相对 `admin/apps/web-antd/src/`，如 `views/ops/...`、`router/...`；e2e 相对 `admin/apps/web-antd/`。
4. **行号均为真实行号**，已用 Grep 核对。迁移行号指向建表语句、函数定义或关键校验分支。
5. 找不到证据就写 `未找到`，不填占位路径。

---

## 4. 追踪表

### 4.1 §4 用户与权限模型（PRD 110–141）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-4-01 | 内部账号池，复用 Supabase Auth，无公开注册 | §4.1 / 114–116 | `supabase/migrations/20261030000003_ops_identity.sql:35`（ops.operators）；`apps/api/src/modules/ops/auth/routes.ts:74` | `router/guard.ts:43`；`api/core/auth.ts:40` | `tests/integration/ops-auth.test.ts`；`supabase/tests/ops_identity_rls.sql` | 已实现有测试 |
| R-4-02 | 六预置角色，角色名不进业务分支 | §4.2 / 120–129 | `20261030000003_ops_identity.sql:65`（ops.roles） | `constants/permissions.ts:17` | `tests/integration/ops-accounts.test.ts` | 已实现有测试 |
| R-4-03 | 权限按动作码授权，覆盖 read/write/approve/execute | §4.2 / 131 | `20261030000003_ops_identity.sql:472`（39 条 seed） | `constants/permissions.ts:80` | `supabase/tests/ops_identity_write.sql` | 已实现有测试 |
| R-4-04 | 账号须启用且至少一个角色 | §4.3 / 135 | `supabase/migrations/20261030000005_ops_identity_write.sql:218`（roles_required） | `views/ops/identity-audit/operators.vue:198` | `tests/integration/ops-accounts.test.ts` | 已实现有测试 |
| R-4-05 | 无运营授权/停用账号拒绝 /ops | §4.3 / 135 | `apps/api/src/middleware/ops-auth.ts:326` | `router/guard.ts:79` | `tests/integration/ops-denials.test.ts:93,132`；`supabase/tests/ops_identity_rls.sql:288` | 已实现有测试 |
| R-4-06 | 前端按权限呈现，服务端再次校验 | §4.3 / 136 | `apps/api/src/middleware/ops-permission.ts:18` | `router/access.ts:60`；`views/ops/_shared/use-ops-permission.ts` | `e2e/http/permission.e2e.ts:21` | 已实现有测试 |
| R-4-07 | 角色/权限变更仅管理员并留前后摘要 | §4.3 / 137 | `apps/api/src/modules/ops/accounts/routes.ts:369,413` | `views/ops/identity-audit/operators.vue:322` | `supabase/tests/ops_identity_write.sql`；`e2e/stub/governance.e2e.ts:17` | 已实现有测试 |
| R-4-08 | 高影响操作必须记录原因 | §4.3 / 138 | `20261030000007_ops_customer_domain.sql:730`（p_reason）；`20261030000003_ops_identity.sql:262`（write_audit） | `views/ops/billing/components/high-risk-modal.vue`；`views/ops/contract/components/high-risk-confirm.vue` | `views/ops/billing/__tests__/high-risk-action.test.ts`；`views/ops/contract/__tests__/high-risk-confirm.test.ts` | 已实现有测试 |
| R-4-09 | 按权限/策略要求二次认证或 MFA | §4.3 / 138 | `20261030000003_ops_identity.sql:43`（仅 `mfa_required` 标记列） | 未找到 | 未找到 | 未实现 |
| R-4-10 | 禁止用 user_metadata 自我提权 | §4.3 / 139 | `apps/api/src/middleware/ops-auth.ts:60`（resolveOpsContext 只读成员关系） | — | `supabase/tests/ops_identity_rls.sql`；`tests/integration/ops-identity.test.ts` | 已实现有测试 |
| R-4-11 | 停用/撤销后旧会话不得再写 | §4.3 / 140 | `20261030000003_ops_identity.sql:97`（operator_roles）；`20261030000005_ops_identity_write.sql` | — | `supabase/tests/ops_identity_rls.sql:288`；`supabase/tests/ops_identity_write.sql` | 已实现有测试 |
| R-4-12 | 认证提供方适配边界可迁移 | §4.3 / 141 | `apps/api/src/modules/ops/auth/upstream.ts:20` | — | `apps/api/src/modules/ops/auth/routes.test.ts` | 已实现有测试 |

### 4.2 §6.1 运营总览（PRD 163–170）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-01 | 八项核心指标 | §6.1 / 165 | `supabase/migrations/20261031000009_ops_overview.sql:78` | `views/ops/identity-audit/overview.vue:177` | `supabase/tests/ops_overview_domain.sql`；`tests/integration/ops-overview.test.ts` | 已实现有测试 |
| R-6-02 | 到期窗口默认 30 天可配并显示统计时间 | §6.1 / 166 | `20261031000009_ops_overview.sql:104`；`20261031000001_ops_settings.sql:24` | `views/ops/identity-audit/settings.vue:156` | `supabase/tests/ops_settings_domain.sql`；`ops_overview_domain.sql` | 已实现有测试 |
| R-6-03 | 指标下钻继承权限与默认筛选 | §6.1 / 167 | `20261031000009_ops_overview.sql:78` | `views/ops/identity-audit/overview.vue:204`（只跳转不传筛选，代码注释明示） | `views/ops/identity-audit/__tests__/governance-rules.test.ts`（未覆盖筛选继承） | 已实现无测试 |
| R-6-04 | 待审核/待核销金额单独呈现 | §6.1 / 168 | `20261031000009_ops_overview.sql:78`（amounts 分组） | `views/ops/identity-audit/overview.vue:147`（待核销收款独立卡片） | `supabase/tests/ops_overview_domain.sql` | 已实现有测试 |
| R-6-05 | 图表与列表同口径，四类异常态明确 | §6.1 / 169 | `20261031000009_ops_overview.sql:88`（restricted/partial） | `views/ops/identity-audit/overview.vue:5`（状态清单） | `__tests__/governance-rules.test.ts`；`e2e/stub/governance.e2e.ts:17` | 已实现有测试 |
| R-6-06 | 不逐条加载历史，聚合/索引化 | §6.1 / 170 | `20261031000009_ops_overview.sql:78`（单次聚合） | — | 未找到性能断言 | 已实现无测试 |

### 4.3 §6.2 软件客户（PRD 172–180）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-07 | 建档/编辑/停用，无物理删除 | §6.2 / 174 | `20261030000007_ops_customer_domain.sql:730`（transition_customer） | `views/ops/customer/list.vue:212,285` | `supabase/tests/ops_customer_domain.sql`；`tests/integration/ops-customers.test.ts` | 已实现有测试 |
| R-6-08 | 客户核心字段齐全 | §6.2 / 175 | `20261030000007_ops_customer_domain.sql:38-76` | `views/ops/customer/components/customer-form.vue` | `supabase/tests/ops_customer_domain.sql` | 已实现有测试 |
| R-6-09 | 多联系人、主要联系人、最小必要展示 | §6.2 / 176 | `20261030000007_ops_customer_domain.sql:86,121`（mask_phone/mask_email） | `views/ops/customer/components/contact-table.vue` | `views/ops/customer/__tests__/contact-masking.test.ts` | 已实现有测试 |
| R-6-10 | 编号唯一；重名/重码只提示不合并 | §6.2 / 177 | `20261030000007_ops_customer_domain.sql:70`（UNIQUE）；`:544`（duplicate_matches） | `views/ops/customer/list.vue` | `supabase/tests/ops_customer_domain.sql`；`tests/integration/ops-customers.test.ts` | 已实现有测试 |
| R-6-11 | 五态生命周期且与合同/账款/租户独立 | §6.2 / 178 | `20261030000007_ops_customer_domain.sql:50`（CHECK） | `views/ops/customer/detail.vue:207` | `supabase/tests/ops_customer_domain.sql` | 已实现有测试 |
| R-6-12 | 停用前展示关联，禁止删除有关联客户 | §6.2 / 179 | `20261030000007_ops_customer_domain.sql:154`（reference_counts）；`:789`（referenced 拦截） | `views/ops/customer/detail.vue` | `supabase/tests/ops_customer_domain.sql` | 已实现有测试 |
| R-6-13 | 搜索筛选服务端分页 | §6.2 / 180 | `20261030000007_ops_customer_domain.sql:326`（list_customers） | `views/ops/customer/list.vue` | `supabase/tests/ops_customer_domain.sql`；`tests/integration/ops-customers.test.ts` | 已实现有测试 |

### 4.4 §6.3 产品与套餐（PRD 182–191）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-14 | 产品目录字段与生命周期 | §6.3 / 184 | `20261030000009_ops_catalog_domain.sql:30` | `views/ops/catalog/products.vue:172` | `supabase/tests/ops_catalog_domain.sql`；`tests/integration/ops-catalog.test.ts` | 已实现有测试 |
| R-6-15 | 销售方式可配，未开放不得签约 | §6.3 / 185 | `20261030000009_ops_catalog_domain.sql:49`；`20261030000010_ops_contract_domain.sql:1233`（签署时真查表） | `views/ops/catalog/products.vue:213` | `supabase/tests/ops_catalog_domain.sql`；`ops_contract_domain.sql` | 已实现有测试 |
| R-6-16 | 套餐字段与三种条目类型 | §6.3 / 186–187 | `20261030000009_ops_catalog_domain.sql:57`；`20261030000010_ops_contract_domain.sql:112` | `views/ops/catalog/plans.vue:204`；`components/package-form.vue` | `supabase/tests/ops_catalog_domain.sql`；`views/ops/catalog/__tests__/package-form.test.ts` | 已实现有测试 |
| R-6-17 | 价格版本只影响新合同，历史快照 | §6.3 / 188 | `20261030000009_ops_catalog_domain.sql:87`；`20261030000010_ops_contract_domain.sql:609`（snapshot_json） | `views/ops/catalog/components/price-version-panel.vue` | `supabase/tests/ops_contract_domain.sql`；`__tests__/price-version-panel.test.ts` | 已实现有测试 |
| R-6-18 | 功能键稳定，支持启停/额度/期限/范围 | §6.3 / 189 | `20261030000009_ops_catalog_domain.sql:105` | `views/ops/catalog/features.vue:232` | `supabase/tests/ops_catalog_domain.sql` | 已实现有测试 |
| R-6-19 | 套餐编辑不回写历史；停用查草稿合同 | §6.3 / 190–191 | `20261030000009_ops_catalog_domain.sql:1307`（draft_contracts 拦截） | `views/ops/catalog/plans.vue` | `supabase/tests/ops_catalog_domain.sql` | 已实现有测试 |

### 4.5 §6.4 合同与订单（PRD 193–203）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-20 | 从已有客户建合同，不做线索漏斗 | §6.4 / 195 | `20261030000010_ops_contract_domain.sql:701`（create_contract） | `views/ops/contract/create.vue:70` | `supabase/tests/ops_contract_domain.sql`；`tests/integration/ops-contracts.test.ts` | 已实现有测试 |
| R-6-21 | 合同字段齐全，一条目一份快照 | §6.4 / 196–197 | `20261030000010_ops_contract_domain.sql:47,105` | `views/ops/contract/components/contract-form.vue` | `supabase/tests/ops_contract_domain.sql` | 已实现有测试 |
| R-6-22 | 六态合同，收款状态独立 | §6.4 / 198 | `20261030000010_ops_contract_domain.sql:47`（CHECK） | `views/ops/contract/detail.vue:226` | `supabase/tests/ops_contract_domain.sql` | 已实现有测试 |
| R-6-23 | 推进需权限；生效后不可覆盖需变更单 | §6.4 / 199 | `20261030000010_ops_contract_domain.sql:1121`（transition）；`:970`（contract_immutable） | `views/ops/contract/detail.vue:226` | `views/ops/contract/__tests__/high-risk-flow.test.ts`；`ops_contract_domain.sql` | 已实现有测试 |
| R-6-24 | 续约建来源关系并记录差异 | §6.4 / 200 | `20261030000010_ops_contract_domain.sql:1858`（renew_contract） | `views/ops/contract/detail.vue:307` | `supabase/tests/ops_contract_domain.sql` | 已实现有测试 |
| R-6-25 | 终止需原因与影响预览，不物理删除 | §6.4 / 201 | `20261030000010_ops_contract_domain.sql:227`（reference_counts）；`:1121` | `views/ops/contract/components/high-risk-confirm.vue` | `__tests__/high-risk-confirm.test.ts` | 已实现有测试 |
| R-6-26 | 单币种，不算税、不自动开票 | §6.4 / 202 | `20261030000010_ops_contract_domain.sql:47`（currency） | `views/ops/contract/__tests__/amount-format.test.ts` | `supabase/tests/ops_contract_domain.sql` | 已实现有测试 |
| R-6-27 | 附件留类型/上传人/时间/签名访问 | §6.4 / 203 | `20261030000010_ops_contract_domain.sql:190`；`:2121,2285`；`apps/api/src/modules/ops/storage/sign.ts:26` | `views/ops/contract/detail.vue` | `supabase/tests/ops_contract_domain.sql`；`apps/api/src/modules/ops/storage/sign.test.ts` | 已实现有测试 |

### 4.6 §6.5 应收、线下收款与退款（PRD 205–215）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-28 | 按付款条款建多期应收计划 | §6.5 / 207 | `20261031000002_ops_billing_receivables.sql:366`（create_receivable_plan） | `views/ops/billing/receivables.vue:340` | `supabase/tests/ops_billing_domain.sql`；`tests/integration/ops-receivables.test.ts` | 已实现有测试 |
| R-6-29 | 线下收款登记字段齐全 | §6.5 / 208 | `20261031000004_ops_billing_receipts.sql:531`（record_receipt） | `views/ops/billing/receipts.vue:229` | `supabase/tests/ops_receipt_domain.sql`；`tests/integration/ops-receipts.test.ts` | 已实现有测试 |
| R-6-30 | 分次收款/跨期分配，并发不超额 | §6.5 / 209 | `20261031000004_ops_billing_receipts.sql:802`；`:912`（按 id 排序 FOR UPDATE） | `views/ops/billing/components/allocation-modal.vue` | `supabase/tests/ops_receipt_domain.sql`；`ops-receipts.test.ts` | 已实现有测试 |
| R-6-31 | 登记与核销分离，未审核不入实收 | §6.5 / 210 | `20261031000004_ops_billing_receipts.sql:688`；`:730`（segregation_of_duty） | `views/ops/billing/components/receipt-detail-drawer.vue` | `views/ops/billing/__tests__/receipt-approve-button.test.ts`；`ops_receipt_domain.sql` | 已实现有测试 |
| R-6-32 | 撤销核销需原因/权限/反向流水 | §6.5 / 211 | `20261031000004_ops_billing_receipts.sql:1107`（reverse_allocation） | `views/ops/billing/ledger.vue` | `supabase/tests/ops_receipt_domain.sql` | 已实现有测试 |
| R-6-33 | 退款登记关联原收款/合同 | §6.5 / 212 | `20261031000004_ops_billing_receipts.sql:1278`（record_refund） | `views/ops/billing/refunds.vue:80` | `supabase/tests/ops_receipt_domain.sql`；`ops-receipts.test.ts` | 已实现有测试 |
| R-6-34 | 账款四态派生，冲销走独立流水 | §6.5 / 213 | `20261031000002_ops_billing_receivables.sql:114`（status）；`20261031000004_ops_billing_receipts.sql:194`（reversals） | `views/ops/billing/receivables.vue` | `supabase/tests/ops_billing_domain.sql` | 已实现有测试 |
| R-6-35 | 筛选 + 导出沿用同权限 | §6.5 / 214 | `20261031000002_ops_billing_receivables.sql:188`；`20261031000013_ops_exports.sql:92` | `views/ops/identity-audit/exports.vue:191` | `supabase/tests/ops_exports_domain.sql`；`ops-exports.test.ts` | 已实现有测试 |
| R-6-36 | 不做在线支付/自动对账/自动开票 | §6.5 / 215 | 路由表无支付端点（`packages/contracts/src/routes.ts` 全量枚举） | — | `apps/api/src/contracts/route-parity.test.ts` | 已实现有测试 |

### 4.7 §6.6 订阅、授权与权益（PRD 217–225）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-37 | 生效后建草案，审核后才生效/下发 | §6.6 / 219 | `20261031000006_ops_entitlement_domain.sql:144,203,267` | `views/ops/entitlement/change-requests.vue:104` | `supabase/tests/ops_entitlement_domain.sql`；`tests/integration/ops-entitlements.test.ts` | 已实现有测试 |
| R-6-38 | SaaS 订阅字段；自动续订只记录不扣费 | §6.6 / 220 | `20261031000006_ops_entitlement_domain.sql:144` | `views/ops/entitlement/subscriptions.vue:113` | `supabase/tests/ops_entitlement_domain.sql` | 已实现有测试 |
| R-6-39 | 私有化授权字段；永久≠永久更新 | §6.6 / 221 | `20261031000006_ops_entitlement_domain.sql:203` | `views/ops/entitlement/licenses.vue:106` | `supabase/tests/ops_entitlement_domain.sql` | 已实现有测试 |
| R-6-40 | 权益快照只追加，不静默覆写 | §6.6 / 222 | `20261031000006_ops_entitlement_domain.sql:70,106` | `views/ops/entitlement/components/snapshot-history.vue` | `views/ops/entitlement/__tests__/snapshot-readonly.test.ts` | 已实现有测试 |
| R-6-41 | 变更类型全覆盖，留前后值并二次确认 | §6.6 / 223–224 | `20261031000006_ops_entitlement_domain.sql:267` | `views/ops/entitlement/components/change-request-diff.vue`；`high-risk-modal.vue` | `__tests__/approval-segregation.test.ts`；`state-machine.test.ts` | 已实现有测试 |
| R-6-42 | 到期提醒；不自动扣费/续约/删数据 | §6.6 / 225 | `20261031000010_ops_reports.sql:186`（expiring） | `views/ops/identity-audit/overview.vue:177` | `supabase/tests/ops_reports_domain.sql` | 已实现有测试 |

### 4.8 §6.7 `udone` 租户开通与变更（PRD 227–236）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-43 | 租户映射唯一客户，冲突拒绝 | §6.7 / 229 | `20261031000007_ops_tenant_integration_domain.sql:97`（UNIQUE udone_organization_id） | `views/ops/tenant-integration/mappings.vue:242` | `supabase/tests/ops_cross_domain_denials.sql`；`ops-tenant-integration.test.ts` | 已实现有测试 |
| R-6-44 | 只存外部 ID 与同步版本，不复制业务表 | §6.7 / 230 | `20261031000007_ops_tenant_integration_domain.sql:69` | `views/ops/tenant-integration/mappings.vue` | `supabase/tests/ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-6-45 | 经 Hono API 受控命令开通/暂停/恢复 | §6.7 / 231 | `apps/api/src/modules/ops/tenant-integration/routes.ts:403,540,589` | `views/ops/tenant-integration/commands.vue:109` | `tests/integration/ops-tenant-integration.test.ts`；`ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-6-46 | 幂等键/原因/期望版本，重试不重复 | §6.7 / 232 | `20261031000007_ops_tenant_integration_domain.sql:111` | `views/ops/tenant-integration/composables/use-command-submission.ts` | `supabase/tests/ops_tenant_integration_domain.sql:463`（同键重放） | 已实现有测试 |
| R-6-47 | 四态同步 + 摘要/次数/错误类别，不存密钥 | §6.7 / 233 | `20261031000007_ops_tenant_integration_domain.sql:111,199` | `views/ops/tenant-integration/components/command-detail-drawer.vue` | `supabase/tests/ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-6-48 | 超时先查状态；重试有退避与审计 | §6.7 / 234–235 | `tenant-integration/routes.ts:540`（retry）；`:589`（cancel） | `views/ops/tenant-integration/command-feedback.ts` | `__tests__/command-feedback.test.ts`；`ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-6-49 | 页面只展示租户状态/权益摘要 | §6.7 / 236 | `20261031000007_ops_tenant_integration_domain.sql:69`（仅外部 ID 与状态） | `views/ops/tenant-integration/commands.vue` | `views/ops/tenant-integration/__tests__/tenant-rules.test.ts` | 已实现有测试 |

### 4.9 §6.8 私有化部署台账（PRD 238–244）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-50 | 客户可关联多实例并记全台账字段 | §6.8 / 240 | `20261031000008_ops_deployment_domain.sql:55` | `views/ops/deployment/instances.vue:193` | `supabase/tests/ops_deployment_domain.sql`；`tests/integration/ops-deployments.test.ts` | 已实现有测试 |
| R-6-51 | 版本升级登记前后版本与结果 | §6.8 / 241 | `20261031000008_ops_deployment_domain.sql:111` | `views/ops/deployment/detail.vue:242` | `views/ops/deployment/__tests__/version-history-readonly.test.ts` | 已实现有测试 |
| R-6-52 | 不存 SSH/密码/root 凭证 | §6.8 / 242 | `20261031000008_ops_deployment_domain.sql:55-100`（表结构无凭据列） | — | 未找到（仅结构缺失，无可执行断言） | 已实现无测试 |
| R-6-53 | 按客户/版本/状态/维护期筛选 | §6.8 / 243 | `apps/api/src/modules/ops/deployment/routes.ts:198` | `views/ops/deployment/instances.vue` | `supabase/tests/ops_deployment_domain.sql` | 已实现有测试 |

### 4.10 §6.9 售后工单（PRD 246–254）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-54 | 工单字段与客户/产品/合同/租户关联 | §6.9 / 248 | `20261031000003_ops_support_tickets.sql:47` | `views/ops/support/list.vue:275` | `supabase/tests/ops_support_domain.sql`；`tests/integration/ops-tickets.test.ts` | 已实现有测试 |
| R-6-55 | 五类问题类型，配置可扩展 | §6.9 / 249 | `20261031000003_ops_support_tickets.sql:64`（非空文本，字典驱动）；`:623` | `views/ops/support/components/ticket-create-modal.vue` | `supabase/tests/ops_support_domain.sql` | 已实现有测试 |
| R-6-56 | 六态；waiting 需等待对象或备注 | §6.9 / 250 | `apps/api/src/modules/ops/tickets/routes.ts:427`（transition） | `views/ops/support/components/ticket-state-panel.vue` | `views/ops/support/__tests__/state-actions.test.ts` | 已实现有测试 |
| R-6-57 | 时间线追加，不覆盖历史结论 | §6.9 / 251 | `20261031000003_ops_support_tickets.sql:118`；`tickets/routes.ts:526` | `views/ops/support/components/ticket-timeline.vue` | `__tests__/timeline-order.test.ts` | 已实现有测试 |
| R-6-58 | 可关联同步任务/授权变更/升级记录 | §6.9 / 252 | `20261031000003_ops_support_tickets.sql:147`（ticket_references） | `views/ops/support/detail.vue` | `supabase/tests/ops_support_domain.sql` | 已实现有测试 |
| R-6-59 | 超期按可配置内部时限，不发外部通知 | §6.9 / 253 | `20261031000003_ops_support_tickets.sql:200,214`；`20261031000001_ops_settings.sql:24` | `views/ops/support/components/ticket-overdue-badge.vue` | `__tests__/overdue-from-server.test.ts` | 已实现有测试 |
| R-6-60 | 筛选；关闭可重开并记录原因 | §6.9 / 254 | `tickets/routes.ts:205,427` | `views/ops/support/list.vue`；`detail.vue:217` | `views/ops/support/__tests__/terminal-reason.test.ts` | 已实现有测试 |

### 4.11 §6.10 运营配置、审计与集成（PRD 256–264）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-6-61 | 账号邀请/禁用/角色权限，禁公开注册 | §6.10 / 258 | `apps/api/src/modules/ops/accounts/routes.ts:137,181,293` | `views/ops/identity-audit/operators.vue:198` | `tests/integration/ops-accounts.test.ts`；`e2e/stub/governance.e2e.ts:17` | 已实现有测试 |
| R-6-62 | 审计覆盖授权/合同/收款/退款/租户/部署/角色/导出 | §6.10 / 259 | 迁移内 61 处 `write_audit`（入口 `20261030000003_ops_identity.sql:262`） | `views/ops/identity-audit/audit.vue:122` | `supabase/tests/ops_identity_write.sql`；`e2e/stub/governance.e2e.ts:52` | 已实现有测试 |
| R-6-63 | 登录结果写入审计 | §6.10 / 259 | 仅 `20261030000006_ops_identity_alignment.sql:62`（touch_last_login 更新 last_login_at），无 audit_events 写入 | 未找到 | 未找到 | 未实现 |
| R-6-64 | 审计字段完整，敏感信息不入日志 | §6.10 / 260 | `20261030000003_ops_identity.sql:111`（表）；`:262`（写入口） | `views/ops/identity-audit/components/audit-detail-drawer.vue` | `supabase/tests/ops_identity_write.sql` | 已实现有测试 |
| R-6-65 | ops 数据域隔离，双向拒绝 | §6.10 / 261 | `apps/api/src/middleware/ops-auth.ts:326`；`20261003000001_rls_helpers.sql:215` | — | `supabase/tests/ops_cross_domain_denials.sql`；`tests/integration/ops-denials.test.ts:93` | 已实现有测试 |
| R-6-66 | 跨系统调用记录目的/关联/幂等键/状态 | §6.10 / 262 | `20261031000007_ops_tenant_integration_domain.sql:111` | `views/ops/tenant-integration/commands.vue` | `supabase/tests/ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-6-67 | 失败命令可重试/取消，成功的不可删 | §6.10 / 263 | `tenant-integration/routes.ts:540,589` | `views/ops/tenant-integration/components/command-detail-drawer.vue` | `__tests__/command-detail-drawer.test.ts` | 已实现有测试 |
| R-6-68 | 导出需单独权限并写审计 | §6.10 / 264 | `20261031000013_ops_exports.sql:92`；`exports/routes.ts:67` | `views/ops/identity-audit/exports.vue:191` | `supabase/tests/ops_exports_domain.sql`；`tests/integration/ops-exports.test.ts` | 已实现有测试 |

### 4.12 §9 数据与接口边界（PRD 308–331）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-9-01 | 运营使用独立 schema 与逻辑域 | §9.2 / 318 | `supabase/migrations/20261030000001_ops_schema_idempotency.sql:17` | — | `tests/integration/ops-schema.test.ts` | 已实现有测试 |
| R-9-02 | 浏览器不持 service role，只走 Hono API | §9.2 / 319 | `apps/api/src/modules/ops/*/routes.ts`（统一 REST client） | `api/request.ts:160`；`api/adapter/env.ts` | `api/__tests__/env.test.ts`；`quality:check` 含 bundle secret 检查 | 已实现有测试 |
| R-9-03 | 暴露表逐表 RLS，默认拒绝 | §9.2 / 321 | 各 ops 迁移 `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`（如 `20261030000009_ops_catalog_domain.sql:1569`） | — | 37 个 pgTAP，含 `ops_identity_rls.sql`、`ops_customer_domain.sql` 等 | 已实现有测试 |
| R-9-04 | 跨表写入用事务/RPC 保证原子 | §9.2 / 322 | `20261031000004_ops_billing_receipts.sql:802`（单函数内锁 + 双趟校验） | — | `supabase/tests/ops_receipt_domain.sql` | 已实现有测试 |
| R-9-05 | 迁移文件为结构真源 | §9.2 / 323 | `udone/supabase/migrations/`（45 个） | — | `udone/scripts/db/local-db.mjs verify`（45 迁移 + 37 pgTAP） | 已实现有测试 |
| R-9-06 | 版本化命名空间 + 认证→授权→校验顺序 | §9.3 / 327–328 | `apps/api/src/index.ts:43-46`（中间件顺序）；`packages/contracts/src/routes.ts:696`（/api/v1/ops 前缀） | — | `apps/api/src/contracts/route-parity.test.ts` | 已实现有测试 |
| R-9-07 | 集成命令带版本、幂等键、可查状态 | §9.3 / 330 | `20261031000007_ops_tenant_integration_domain.sql:111` | `views/ops/tenant-integration/commands.vue` | `supabase/tests/ops_tenant_integration_domain.sql` | 已实现有测试 |

### 4.13 §10 非功能要求（PRD 333–369）

| R-ID | 需求（≤25 字） | PRD 出处 | 后端落点 | 前端落点 | 测试证据 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R-10-01 | 列表 800ms / 总览 1.5s / 写入 1s（p95） | §10.1 / 339–341 | — | — | 未找到压测脚本或报告 | 未实现 |
| R-10-02 | 分页 ≤50；大规模导出走后台任务 | §10.1 / 342 | `20261030000007_ops_customer_domain.sql:326`（默认 20，上限 100）；`apps/api/src/modules/ops/exports/runner.ts:16`（懒执行挂读请求，非后台任务） | `views/ops/identity-audit/exports.vue` | `supabase/tests/ops_exports_domain.sql` | 需 staging 验证 |
| R-10-03 | 关键查询建索引，避免每行重复查询 | §10.1 / 343 | 各迁移 `CREATE INDEX`（如 `20261030000007_ops_customer_domain.sql:77`） | — | 未找到执行计划断言 | 已实现无测试 |
| R-10-04 | 全站 HTTPS，密钥只在 Worker secrets | §10.2 / 348 | `udone/wrangler.toml`（secrets 声明） | — | 未找到（部署层证据，仓库内无） | 需 staging 验证 |
| R-10-05 | ops 与租户授权域分开，匿名/租户拒绝 | §10.2 / 349 | `apps/api/src/middleware/ops-auth.ts:326`；`20261003000001_rls_helpers.sql:215` | — | `supabase/tests/ops_cross_domain_denials.sql`；`ops-denials.test.ts:93,132` | 已实现有测试 |
| R-10-06 | RLS 与 API 权限双重执行 | §10.2 / 350 | `middleware/ops-permission.ts:18` + 库内 `require_permission` | — | `supabase/tests/ops_identity_rls.sql` | 已实现有测试 |
| R-10-07 | 管理员控账号；强密码；MFA 启用 | §10.2 / 351 | `accounts/routes.ts:181`；`mfa_required` 字段 | `views/ops/identity-audit/operators.vue:198` | `tests/integration/ops-accounts.test.ts` | 需 staging 验证 |
| R-10-08 | 联系方式最小化；敏感操作审计；日志脱敏 | §10.2 / 352–353 | `20261030000007_ops_customer_domain.sql:121`（mask_*）；`write_audit` | `views/ops/customer/components/contact-table.vue` | `__tests__/contact-masking.test.ts`；`quality:check` secret scan | 已实现有测试 |
| R-10-09 | 精确十进制、不可覆盖流水、幂等唯一 | §10.3 / 357–359 | 各表 `numeric(14,2)`；`20261030000001_ops_schema_idempotency.sql`（幂等表） | `api/ops/billing/money.ts` | `views/ops/billing/__tests__/money.test.ts`；`ops_receipt_domain.sql` | 已实现有测试 |
| R-10-10 | 同步失败不虚报；重试上限/分类；可恢复 | §10.3 / 360–361 | `20261031000007_ops_tenant_integration_domain.sql:111,199` | `views/ops/tenant-integration/command-feedback.ts` | `supabase/tests/ops_tenant_integration_domain.sql` | 已实现有测试 |
| R-10-11 | 前后端按领域模块化，规则在服务层 | §10.4 / 365–367 | `udone/apps/api/src/modules/ops/`（19 个域目录） | `admin/apps/web-antd/src/views/ops/`（10 个域目录） | 未找到结构断言 | 已实现无测试 |
| R-10-12 | 单 Hono Worker；新环境可重复部署 | §10.4 / 368–369 | `udone/wrangler.toml`；`supabase/migrations/` | — | `local-db.mjs verify`（本地绿，未在空隔离项目重放） | 需 staging 验证 |

---

## 5. 编号范围说明（哪些 PRD 段落没有 R-ID）

| PRD 段落 | 未编号原因 |
| --- | --- |
| §1 产品概述 | 目标陈述，验收点已下沉到 §6/§10，重复编号会产生两处真源。 |
| §2 范围与边界 | §2.3「首期包含」是 §6 的目录；§2.4「首期不包含」是**负向范围**，用「不存在该能力」表达，已在 R-6-36、R-6-52 内体现，不单独编号。 |
| §3 名词与核心概念 | 术语定义，无验收行为。 |
| §5 信息架构 | 原文写明「一级导航**建议**」，实际导航按域合并（运营配置/审计/导出/总览同属 `identity-audit` 域），属允许的设计自由度。 |
| §7 关键业务流程 | 是 §6.2–6.7 的组合流程，逐条拆分会与 R-6-07…R-6-49 重复。流程级验收放在 §11.1，由 `RELEASE-READINESS.md` 承接。 |
| §8 状态规则 | 每类对象的状态机已作为约束落在对应域迁移，并被该域 R-ID 的测试覆盖（如 `ops_*_domain.sql` 内的状态迁移断言），不重复编号。 |
| §11 验收标准 | 是本表的**验收出口**而非新需求；逐条映射见 `RELEASE-READINESS.md`。 |
| §12 报表口径 | 指标口径已内联在 R-6-01/R-6-04 与 `20261031000009_ops_overview.sql:78` 的注释里，避免同一口径两处维护。 |
| §13 风险与控制 | 风险条目不是可交付功能，控制措施已散落在 R-4/§9/§10 条目。 |
| §14 文档建设 | 文档治理要求，不属于运营后台功能。 |

---

## 6. 无法追溯的需求

以下条目在 PRD 中明确要求，但在 `udone/` 与 `admin/` 中**找不到可执行的落点**。它们不是「优先级低」，而是当前实现确实缺失。

| # | 需求 | PRD 出处 | 现状 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 高影响操作按策略要求二次认证/MFA | §4.3，PRD:138 | `ops.operators` 有 `mfa_required` 列（`20261030000003_ops_identity.sql:43`），但没有任何读取该列并强制校验的代码；登录走 GoTrue，未传 `aal` 要求 | PRD §11.1 第 1 条「已授权角色只能执行被授予动作」之外的身份强度要求落空；安全验收缺一项 |
| 2 | 登录结果写入审计 | §6.10，PRD:259 | 登录成功只更新 `last_login_at`（`20261030000006_ops_identity_alignment.sql:62`）；`ops.audit_events` 无登录相关 action，61 处 `write_audit` 均不含登录 | 审计验收（§11.1 第 9 条）中「登录结果」无法举证；异常登录排查无据 |
| 3 | 性能基线（列表 800ms、总览 1.5s、写入 1s、10k/100k 合成数据） | §10.1，PRD:339–344 | 仓库内无压测脚本、无合成数据生成器、无测试报告 | PRD §11.1 第 11 条无法举证；发布准入第 7 项阻塞 |
| 4 | 全站 HTTPS 强制 | §10.2，PRD:348 | 仓库内无证据（属部署/入口层配置，`wrangler.toml` 只管 Worker 自身） | 需在 staging/production 入口核对，无法静态追溯 |

### 6.1 有落点但口径不一致（不算缺失，需决策）

| # | 需求 | PRD 出处 | 实现现状 | 差异 |
| --- | --- | --- | --- | --- |
| 1 | 指标下钻继承当前用户数据权限**与默认筛选条件** | §6.1，PRD:167 | `views/ops/identity-audit/overview.vue:204` 只 `router.push({name})`，代码注释写明「下钻只做跳转，不试图跨页传筛选条件」 | 权限继承成立；**筛选条件不继承**。要么改前端传参，要么改 PRD 措辞 |
| 2 | 大规模导出使用受权限控制的**后台任务**，避免请求超时 | §10.1，PRD:342 | `apps/api/src/modules/ops/exports/runner.ts:16` 明确选择「懒执行挂读请求」，每次 `GET /exports` 或 `GET /exports/{id}` 最多推进 1 条 | 能力有、权限与审计有，但慢查询会拖慢列表请求；需在 staging 用大数据量验证是否触及超时 |
| 3 | 客户「停用」前展示关联合同/授权/部署/工单 | §6.2，PRD:179 | 后端在 `transition_customer` 里对 `terminate` 做引用拦截（`:779`），`suspend` 不拦截 | PRD 写「停用」，实现语义更接近「终止」；若业务要求 suspend 也拦截需补一条规则 |

---

## 7. 统计

| 状态 | 条数 | 占比 |
| --- | --- | --- |
| 已实现有测试 | 87 | 87.9% |
| 已实现无测试 | 5 | 5.1% |
| 未实现 | 3 | 3.0% |
| 需 staging 验证 | 4 | 4.0% |
| **合计** | **99** | 100% |

按章节分布：

| 章节 | 条数 | 已实现有测试 | 已实现无测试 | 未实现 | 需 staging |
| --- | --- | --- | --- | --- | --- |
| §4 用户与权限 | 12 | 11 | 0 | 1 | 0 |
| §6.1 运营总览 | 6 | 4 | 2 | 0 | 0 |
| §6.2 软件客户 | 7 | 7 | 0 | 0 | 0 |
| §6.3 产品与套餐 | 6 | 6 | 0 | 0 | 0 |
| §6.4 合同与订单 | 8 | 8 | 0 | 0 | 0 |
| §6.5 账款/收款/退款 | 9 | 9 | 0 | 0 | 0 |
| §6.6 订阅/授权/权益 | 6 | 6 | 0 | 0 | 0 |
| §6.7 租户开通 | 7 | 7 | 0 | 0 | 0 |
| §6.8 私有化部署 | 4 | 3 | 1 | 0 | 0 |
| §6.9 售后工单 | 7 | 7 | 0 | 0 | 0 |
| §6.10 配置/审计/集成 | 8 | 7 | 0 | 1 | 0 |
| §9 数据与接口边界 | 7 | 7 | 0 | 0 | 0 |
| §10 非功能 | 12 | 5 | 2 | 1 | 4 |
| **合计** | **99** | **87** | **5** | **3** | **4** |

## 8. 维护约定

1. 新增需求先在此表追加 R-ID，再写代码；不允许先写代码后编号。
2. 状态从 `未实现` → `已实现有测试` 必须同时给出测试文件路径，否则保持 `已实现无测试`。
3. 每次 Task 完成门（执行计划第 78 行）复核本表，与 `RELEASE-READINESS.md` 同步更新。
4. 本表不替代 PRD；PRD 变更（改稿）后需回头修正对应条目的出处行号。
