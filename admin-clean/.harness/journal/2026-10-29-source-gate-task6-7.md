# ERPNext 源码参考门 — Task 6 / Task 7 批次

- 日期：2026-10-29
- 执行人：leader（本批次开发者）
- 适用任务：Task 6 授权/租户交付、Task 7 私有部署/售后
- 结论：**通过**（原始阻塞「参考源缺失」已解除，见 §1）

## 1. 参考源与获取方式

| 项 | 值 |
| --- | --- |
| 仓库 | `https://gitee.com/mirrors/erpnext`（GitHub `frappe/erpnext` 的只读镜像） |
| 提交 | `7474d9e786277383de1242ab882f16856d17a9c9` |
| 版本 | tag `v16.50.0`（`git describe --tags` 实测） |
| 本地路径 | `D:/MYC/Coding/_refs/erpnext` |
| 获取方式 | `git clone --filter=blob:none --sparse --depth 1 --branch v16.50.0` + `git sparse-checkout set` |
| 体积 | 1.8 MB（仅检出所需 doctype，非全仓） |

**与执行计划的偏差（显式登记）**

1. 计划记录路径为 `D:/Coding/ERP/ERPNext`，`version-16` 分支。该盘符在新开发机上不存在。
2. 计划钉死的提交 `7474d9e7…` 实测等于 **tag v16.50.0**；镜像中 `version-16` 分支头已前移（`ade850bb`）。因此**按提交/tag 检出，比按分支头检出更严格**，与计划意图一致。
3. 直连 GitHub 限速严重（4 分 36 秒仅 4.4 MB，已中止），改用 Gitee 镜像，5 秒完成。镜像内容由提交哈希校验一致，不影响只读参考的有效性。

**许可合规**：ERPNext 为 GPL-3.0。本批次**未复制任何源码、元数据或依赖**，仅阅读行为与测试以提炼工程做法。下文所有「采用」均为**模式借鉴后自行实现**，非代码移植。

## 2. 已阅读文件清单（实际打开，非目录浏览）

| 文件 | 规模 | 阅读重点 |
| --- | --- | --- |
| `erpnext/accounts/doctype/payment_entry/payment_entry.py` | 3636 行 | `on_submit`、`on_cancel`、`set_status`、`validate_allocated_amount*`、`validate_duplicate_entry`、`make_gl_entries(cancel=1)` |
| `erpnext/accounts/doctype/payment_entry/test_payment_entry.py` | 2365 行（14 处 `assertRaises`） | `test_duplicate_payment_entry_allocate_amount`、`test_allocation_equal_to_outstanding_at_precision_is_allowed`、`test_overallocation_validation_on_payment_terms` |
| `erpnext/hooks.py` | 743 行 | `doc_events` 注册、`auto_cancel_exempted_doctypes`、`bank_reconciliation_doctypes` |
| `erpnext/controllers/status_updater.py` | 240 行 | `StatusUpdater.set_status` / `get_status` 的状态派生与留痕 |
| `erpnext/crm/doctype/lead/lead.py` | — | 9 值状态枚举、`validate` 内调 `set_status()`、`has_opportunity` / `has_quotation` 派生 |
| `erpnext/crm/doctype/lead/test_lead.py` | — | `test_make_customer`、`test_opportunity_from_lead` |
| `erpnext/crm/doctype/opportunity/opportunity.py` | — | `declare_enquiry_lost`、`auto_close_opportunity`、`has_active_quotation` |
| `erpnext/crm/doctype/opportunity/test_opportunity.py` | — | `test_opportunity_status`（下游单据提交后状态自动变化） |

## 3. Task 6（授权 / 租户交付）观察与决策

### 3.1 提交时以服务端最新状态复核，不信任客户端快照

- **源码**：`payment_entry.py:432 validate_allocated_amount_with_latest_data()` 在保存/提交时重新调用 `get_outstanding_reference_documents(..., validate=True)` 拉取**最新**未结金额，再逐行比较；`374 validate_allocated_amount()` 在分配额超过未结额时 `frappe.throw`，并同时拒绝负数方向的越界。
- **观察**：客户端传来的 `outstanding_amount` 被视为不可信输入，一律以服务端现值重算。
- **采用**：租户命令的乐观并发与变更申请执行前的一致性校验。
  - 落点：`apps/web-antd/src/api/ops/tenant/index.ts`（`expected_sync_version` 必传）、`src/views/ops/tenant-integration/mappings.vue`（409 后强制刷新）。
  - 契约依据：`ops-api-contract.md` §3.6「映射已存在时 `expected_sync_version` 必须等于 `mapping.sync_version`」。
  - **不采用**：其多币种/本位币换算与 `precision("field")` 动态精度（本项目金额固定 `numeric(14,2)`，无多币种）。
- **验收断言**：409 `CONFLICT` + `details.reason='SYNC_VERSION_CONFLICT'` 时，页面必须展示「数据已变化，请刷新后重试」并重新拉取，**不得**用本地值覆盖或静默重试。

### 3.2 状态是派生结果，不是可自由写入的字段

- **源码**：`controllers/status_updater.py:197 set_status()` 中 `new_status = self.get_status()["status"]`，`get_status()` 由关联单据计算；`payment_entry.py:957 set_status()` 直接由 `docstatus` 推出 `Draft/Submitted/Cancelled`。`test_opportunity.py:40` 断言报价单提交后机会状态**自动**变为 `Quotation`。
- **观察**：状态永远由事实推导，避免出现「状态与事实不一致」的双写问题。
- **采用**：订阅/授权状态由**变更申请的执行结果**推进，不由界面直接写。
  - 落点：`src/views/ops/entitlement/subscriptions.vue`、`licenses.vue` —— 状态列只读；任何状态推进都必须走「发起变更申请 → 审批 → 执行」。
  - 契约依据：§3.5 状态机（`draft→pending_approval→active`，`active→suspended/revoked/expired`）。
  - **不采用**：`docstatus` 三态模型（本项目用显式状态机 + `version` 乐观锁）。
- **验收断言**：界面不存在「直接把状态改成 active」的入口；未审批即执行 → 409 `STATE_CONFLICT` / `APPROVAL_REQUIRED` 有可读提示。

### 3.3 状态变化必须留时间线，且关键类型免噪

- **源码**：`status_updater.py:210` 状态变化时 `self.add_comment("Label", _(new_status))`，但排除 `Cancelled / Partially Ordered / Ordered / Issued / Transferred` 等高频噪声状态。
- **采用**：租户命令与授权变更的时间线，用 `attempts` 记录而非散落日志。
  - 落点：`src/api/ops/tenant/index.ts` 的 `listAttempts(commandId)` + 页面命令详情抽屉。
  - **不采用**：其 comment 机制（我们有独立 `ops.audit_events`）。
- **验收断言**：命令详情必须能列出每次尝试的 `attempt_no / outcome / http_status / error_category / request_id`。

### 3.4 删除被守卫，历史不可就地抹除

- **源码**：`hooks.py:431` 为 `Payment Entry` 注册 `on_trash → erpnext.regional.check_deletion_permission`；`on_cancel` 走 `make_reverse_gl_entries(gl_entries, partial_cancel=True)`（`payment_entry.py:1491`）。
- **采用**：权益快照「仅 INSERT」，撤销只能新增反向变更记录。
  - 落点：契约 §3.5 `ops.entitlement_snapshots` 仅 INSERT + `UNIQUE(source_type, source_id, content_hash)`；前端 `licenses.vue`/`subscriptions.vue` 不提供快照编辑，只提供「查看历史快照」与「发起变更」。
  - **不采用**：`ignore_linked_doctypes` 的级联解绑机制（我们无跨单据强链接体系）。
- **验收断言**：快照历史列表按 `created_at` 只增不减；`revoke` 后旧快照仍可查看。

### 3.5 重复录入必须被拒绝，而非「后写覆盖」

- **源码**：`test_payment_entry.py:1188 test_duplicate_payment_entry_allocate_amount` —— 同一发票的两张草稿，第二张提交时 `assertRaises(ValidationError)`；`validate_duplicate_entry()`（`payment_entry.py:339`）按 `(reference_doctype, reference_name, payment_term, payment_request)` 四元组查重。
- **采用**：租户命令 `idempotency_key` 唯一 + 变更申请「同源快照不重复发放」。
  - 落点：`src/api/ops/tenant/index.ts` 创建命令时前端生成幂等键并透传；重复提交由服务端 409 `CONFLICT` 拒绝。
  - **不采用**：四元组查重的具体维度（本项目按契约的幂等键与 `content_hash`）。
- **验收断言**：连续两次点击「下发」只产生一条命令；第二次返回既有命令而非新建（幂等），页面提示「该操作已提交」。

### 3.6 计划中点名的 `hooks.py` 事件注册：适用性结论

`hooks.py` 的 `doc_events` 是「跨模块副作用集中声明」的做法。本项目对应物是 udone 的模块注册与 `ops.audit_events`，但**本批次只做前端**，无落点。
→ 登记为：**本批次不适用**（架构不同，且前端无事件注册入口）。这不是跳过，是无对应物。

## 4. Task 7（私有部署 / 售后工单）观察与决策

### 4.1 终态需要「原因」，且有前置守卫

- **源码**：`opportunity.py:277 declare_enquiry_lost(lost_reasons_list, competitors, detailed_reason)` —— 置 `Lost` 必须有丢单原因，且若存在活跃报价单则 `frappe.throw("Cannot declare as Lost because an active Quotation exists.")`。
- **采用**：工单关闭/取消必须填原因；有未完成子任务或未结关联时拒绝关闭。
  - 落点：`src/views/ops/support/detail.vue` 的状态流转对话框；`src/api/ops/support/index.ts` 的 `transition()` 强制 `reason`。
  - 契约依据：§3.8 support 域状态流转需 `reason`。
- **验收断言**：不填原因点「关闭」→ 前端拦截且不发请求；服务端 409 有可读提示。

### 4.2 超期自动流转由调度器完成，不在界面里做时间判断

- **源码**：`opportunity.py:532 auto_close_opportunity()` —— 由 scheduler 按 `CRM Settings.close_opportunity_after_days`（默认 15 天）把 `Replied` 批量置 `Closed`，并 `ignore_permissions/ignore_mandatory`。
- **采用**：工单「超时未响应」由服务端计算并返回布尔字段，前端**只展示不推断**。
  - 落点：`src/views/ops/support/list.vue` 使用服务端返回的 `is_overdue`（若契约未定义则标为推导项待后端确认）。
  - **不采纳**：前端用 `Date.now()` 与 `due_at` 自行比较判超时（会因客户端时钟/时区与后端不一致产生假告警）。**这是本批次明确禁止的实现方式。**
- **验收断言**：列表超时标识必须来自响应字段；前端不得出现本地时间差计算（代码评审检查项）。

### 4.3 状态时间线是核心可读物

- **源码**：`test_opportunity.py:40 test_opportunity_status` 用一个「下游动作 → 状态变化」的断言固化时间线语义；`lead.py` 的 `has_opportunity/has_quotation` 让状态可从关联事实回推。
- **采用**：工单详情以时间线为主视图（事件 + 操作者 + 时间 + 原因），状态徽标为派生展示。
  - 落点：`src/views/ops/support/timeline.ts` + `detail.vue`。
- **验收断言**：时间线按时间升序完整呈现，含分派、状态变更、备注三类事件。

### 4.4 私有化部署：ERPNext 无对应物

ERPNext 无「私有化实例台账 + 版本升级历史」的对应实现（其 `bench` 部署在仓库外）。按计划要求 **明确写「不适用」**，理由：无可借鉴的行为源，改以 PRD §6.8 与运维实际约束为唯一真源，不强行类比。

## 5. 本批次编码约束（由以上结论派生）

1. 金额只展示与校验，不做前端运算；比较一律基于字符串/定点，不经 `parseFloat`。
2. 任何状态推进都必须是「命令/申请」驱动，界面不得直写终态。
3. 409 冲突必须刷新后重试，禁止本地覆盖。
4. 超时/逾期一律读服务端字段。
5. 开发态数据必须可见标注，禁止冒充真实集成。

## 6. 待后端确认（随实现同步登记）

- `SYNC_VERSION_CONFLICT` 是否已列入 `details.reason` 词表（契约 §6.4 需核对）。
- `support` 工单是否返回 `is_overdue`；若否，需后端补字段而非前端自算。
- 租户命令 `cancel` 的允许条件是否严格为「零次尝试」。
