# Task 6 前端 · entitlement 域（订阅 / 私有授权 / 权益快照 / 变更申请）

- 日期：2026-10-29
- 分支：`feat/ops-console`（工作树 `D:/MYC/Coding/ERP-ops`）
- 应用：`admin/apps/web-antd`（Vue Vben Admin 5.7.0）
- 前置门禁：`admin/.harness/journal/2026-10-29-source-gate-task6-7.md`（已通过）
- 后端状态：`udone` 侧 ops entitlement API **尚未实现**，本域全部走开发态契约桩

## 1. 交付范围（仅可写路径内）

### API 客户端 `apps/web-antd/src/api/ops/entitlement/`

| 文件 | 内容 |
| --- | --- |
| `endpoints.ts` | 路径集中、静态 `VITE_OPS_MOCK` 判定、幂等键/写请求配置、列表参数白名单 |
| `types.ts` | 契约字段（订阅/授权/快照/快照行/变更申请/差异/transition 入参出参） |
| `subscriptions.ts` | `fetchSubscriptions` / `fetchSubscription` / `createSubscription` / `transitionSubscription` |
| `licenses.ts` | 同构的 `fetchLicenses` / `fetchLicense` / `createLicense` / `transitionLicense` |
| `change-requests.ts` | `fetchChangeRequests` / `fetchChangeRequest` / `createSubscriptionChangeRequest` / `createLicenseChangeRequest` / `transitionChangeRequest` |
| `snapshots.ts` | `fetchSnapshot` / `fetchSnapshotHistory`（**只有读**，无 update/delete） |
| `rules.ts` | 状态机动作表、审批人≠申请人、未审批不可执行、高风险判定、原因校验、永久授权期限校验 |
| `errors.ts` | `code` + `details.reason` → 中文文案与可恢复性 |
| `format.ts` | 状态/变更类型/授权方式标签、额度与日期格式化、快照摘要与永久授权说明 |
| `dev-stub.ts` | `VITE_OPS_MOCK=true` 的契约桩（静态判定 + 动态 import，生产可 tree-shake） |
| `fixtures.ts` | **虚构**客户/订阅/授权/快照/变更申请 |
| `README.md` | 域内约定与契约推导清单 |

### 页面 `apps/web-antd/src/views/ops/entitlement/`

- `subscriptions.vue`（替换占位页）：服务端分页筛选（状态/客户/计费周期/到期区间）+ 快照摘要列 + 详情抽屉 + 创建草稿
- `licenses.vue`（替换占位页）：同构 + `license_mode` + 维护期独立列 + 永久授权提示
- `change-requests.vue`（新增）：跨主体变更申请列表、差异查看、审批/驳回/执行/重试/取消
- `components/`：`entitlement-detail-drawer.vue`、`state-machine-panel.vue`、`snapshot-history.vue`、`snapshot-lines-table.vue`、`change-request-actions.vue`、`change-request-diff.vue`、`change-request-create-modal.vue`、`feature-editor.vue`、`high-risk-modal.vue`、`subscription-create-modal.vue`、`license-create-modal.vue`
- `composables/`：`use-entitlement-high-risk.ts`、`use-current-operator.ts`
- `router/routes/modules/entitlement.ts`：新增子路由 `/entitlements/change-requests`

开发态提示复用 `#/views/ops/billing/components/dev-data-notice.vue`（只读引用，未修改）。

## 2. 源码参考门约束的落点

| 门禁约束 | 落点（文件 + 函数） |
| --- | --- |
| §3.2 状态由变更申请执行结果推进，界面不直写终态 | `api/ops/entitlement/rules.ts: entitlementStatusActions()` 对 `active/suspended` 只返回 `change:<type>` 动作；`views/.../components/state-machine-panel.vue` 仅按该表渲染；`entitlement-detail-drawer.vue: onStateAction()` 把 `change:*` 一律导向「创建变更申请」，不调用任何写 status 的 API |
| §3.4 快照仅 INSERT，历史不可就地改写 | `api/ops/entitlement/snapshots.ts` 只有 `fetchSnapshot` / `fetchSnapshotHistory`；`snapshot-history.vue` 只有「查看明细」按钮；`dev-stub.ts: appendSnapshot()` 只 push，不修改既有行；变更执行通过 `applyExecutedChange()` 把 `currentSnapshotId` 指向**新**快照 |
| §3.1/§3.5 冲突必须刷新后重试，禁止本地覆盖 | `errors.ts: describeEntitlementError()` 对 409 `CONFLICT`/`VERSION_MISMATCH`/`APPROVAL_REQUIRED` 返回 `shouldRefresh=true`；`entitlement-detail-drawer.vue: onHighRiskClose()` 与 `change-requests.vue: onHighRiskClose()` 在关闭时重新拉取，不做本地覆盖 |
| §5 金额只展示不运算 | `format.ts: formatQuota()` 仅格式化；列表额度摘要取服务端 `snapshotSummary`（`format.ts: snapshotSummaryText()`），前端不对 `quota` 求和 |
| 不得复制 ERPNext 代码（GPL-3.0） | 本域全部按本仓库契约自写，无任何外部源码/元数据引入 |
| 开发态数据可见标注 | 三页均渲染 `DevDataNotice`，桩数据仅虚构名称（示例旅行社甲/乙（虚构）） |

## 3. 单元测试

`apps/web-antd/src/views/ops/entitlement/__tests__/`（7 文件 / 45 用例，全部通过）：

| 文件 | 覆盖 |
| --- | --- |
| `state-machine.test.ts` | 状态动作表；终态无动作；变更申请动作表；高风险判定；永久授权期限约束 |
| `state-machine-panel.test.ts` | 只渲染当前态允许的动作；缺权限禁用并显示动作码；终态无按钮；点击只上报事件 |
| `execute-approval.test.ts` | 未审批执行被规则拦截；桩返回 409 `APPROVAL_REQUIRED`；409 文案映射；版本冲突要求刷新 |
| `approval-segregation.test.ts` | 申请人自批被拒（规则 + 按钮禁用 + 说明）；换人可审批；桩返回 403 `SEGREGATION_OF_DUTY` |
| `snapshot-readonly.test.ts` | 快照 API 无写函数；历史无编辑/删除入口；只读提示；查看明细只上报 id |
| `high-risk-confirm.test.ts` | 打开弹窗不发请求；原因必填；防重复提交；失败保留原因与 requestId；弹窗只上报事件 |
| `conflict-errors.test.ts` | 409/403/400/网络/5xx 文案与 `shouldRefresh`/`canRetry` |

## 4. 状态覆盖矩阵（硬性验收）

| 状态 | 落点 |
| --- | --- |
| loading | 列表 `Table :loading`；详情抽屉 `Spin`；差异/快照弹窗 `Spin` |
| empty | 三页 `Empty` 文案；快照历史「暂无历史快照」；变更申请「暂无变更申请」 |
| error | 列表 `Alert` + 重试；抽屉/弹窗 `Alert` + requestId |
| validation | 创建草稿/变更申请表单（客户、合同条目、日期、功能键非空/去重、永久授权不得填到期日） |
| permission-denied | `canRead=false` 时整页只显示 `Alert`（`data-testid=entitlement-permission-denied`），不渲染任何权益明细；按钮按动作码禁用并提示 |
| conflict | 409 → 文案 + 刷新重拉（抽屉/列表） |
| destructive-confirm | `high-risk-modal.vue` + `use-entitlement-high-risk.ts`（审批、撤销/暂停执行、驳回、取消均二次确认 + 原因必填） |

## 5. 契约推导 / 待确认（须 leader 与后端确认）

1. **U-05 `POST /subscriptions|licenses/{id}/transition`**：§3.5 状态机列出 `submit/approve/reject` 动作与权限，但 §5.6 未给端点。已按 customer/contract 域形态补 `transition`，且前端只用于草稿期；`active` 之后一律走变更申请。
2. **U-06 `GET /entitlement-snapshots`**：§5.6 只有按 id 查单条。快照历史列表按「历史可回溯」推导；后端未提供时页面回退详情 `snapshots[]`，两者都没有则显式降级提示（`historyDegraded`），不伪造历史。
3. **列表筛选参数 `billingCycle` / `endsFrom` / `endsTo` / `licenseMode`**：§5.6 只列 `expiringInDays`。本实现同时支持契约字段与推导字段；若后端只实现契约字段，「计费周期」「到期区间」需改为 `expiringInDays` 或后端补参。
4. **列表快照摘要 `snapshotSummary{featureCount,enabledCount,quotaTotal}`**：§5.6 列表条目未列，但 PRD §6.6 要求列表可见当前权益。摘要坚持服务端计算（前端不求和）；缺失时显示「快照摘要未返回」。
5. **`quota` vs `quota_value`**：数据库列 `quota_value`，§5.6/§5.4 响应字段为 `quota`；前端统一用 `quota`。
6. **`before_summary`/`after_summary` 的 jsonb 形状**：契约未定死。前端假定含 `features[]`（`featureKey/enabled/quota/termMonths/displayName`）；不含时降级为原文展示，不做推断（`change-request-diff.vue`）。
7. **变更申请状态集**（§3.5 标注推导 U-04）：前端按 `draft/pending_approval/approved/executing/executed/failed/rejected/cancelled` 渲染，未知状态降级为「未知(原值)」。
8. **路由标题本地化**：`/entitlements/change-requests` 直接使用中文标题「权益变更申请」，因为 `src/locales/**` 不在本任务可写路径内；待 locales 负责人补 `ops-shell.menu.entitlementChangeRequests` 后替换为 `$t(...)`。

## 6. 假设

- **当前操作人身份**：任务书写「从 `useAuthStore().userInfo` 取」。实际 `useAuthStore` 不暴露 `userInfo`；用户信息落在 `useUserStore().userInfo`（由 `authStore.fetchUserInfo()` 回填，`userId === operator.id`，见 `api/core/user.ts: toOpsUserInfo`）。`views/ops/entitlement/composables/use-current-operator.ts` 读取 `useUserStore`，与 billing 域详情抽屉同一口径。
- **桩内当前操作人**固定为 `STUB_CURRENT_OPERATOR_ID`（`00000000-0000-4000-8000-000000000001`，与 billing/identity 桩一致）。因此「审批人≠申请人」在桩里只能通过「本人新建的申请 → 自批被拒」和「夹具申请由他人审」两条路径演示；真实后端以登录态为准。

## 7. 验收命令与结果

见本次交付回复（四条命令的真实输出）。执行环境：Node 24.20.0 / pnpm 10.33.4，`corepack pnpm`。

## 8. 已知风险

1. **后端契约缺项**（U-05/U-06 与三个推导筛选参数）未冻结：后端实现后需要一次端点对齐，否则草稿期状态流转与快照历史会退化为只读。
2. **`execute` 是异步命令（202）**：本域只展示 `command{id,status}` 与提示，未实现命令状态轮询；命令详情归 tenant-integration 域，跨域跳转待串。
3. **表单未接入客户/合同选择器**：创建草稿目前手填客户 ID 与合同条目 ID（客户域/合同域未提供候选查询组件），属于联调期待补项。
