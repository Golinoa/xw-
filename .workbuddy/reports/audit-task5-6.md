# Task 5 + Task 6 完成度审计

- 审计对象：`admin/.harness/docs/exec-plans/active/2026-10-05-ops-console-implementation.md` 的 Task 5（155–162 行）与 Task 6（174–181 行），共 16 条
- 方式：只读静态审计（未安装依赖、未起服务、未跑测试、未连数据库）
- 结论时点：2026-11-16

> 说明：计划文件里 T3–T8 复选框全未勾，但后端 `udone` 的财务域、权益域、租户域**都已落地**（迁移 + RPC + 端点 + pgTAP + 集成测试），前端 `admin` 三个域也已接通真实 API 模块（非仅桩）。所以「未勾选」不等于「未实现」，逐条判定如下。

## 结论速览

| 判定 | 条数 |
|---|---|
| 已实现 | 8 |
| 已实现无测试 | 0 |
| 未实现 | 8 |
| 需真跑 | 0 |
| **合计** | **16** |

未实现的 8 条集中在三类：**Playwright 端到端用例缺失**（2 条）、**staging/并发真跑证据缺失**（3 条）、**租户命令执行侧不存在**（1 条）、**计划文档类收尾**（2 条）。资金主链路本身（应收→收款→核销→退款→冲正）的代码与测试是完整的。

## 资金安全专项（Task 5 额外的 4 问）

### 1. 核销上限口径：服务端 SQL 聚合，前端数字一律不信

**是服务端算的，且用的是「锁后重算」的聚合，不存在信任前端总额的路径。**

- 可分配额由 SQL 函数现算：`udone/supabase/migrations/20261031000004_ops_billing_receipts.sql:245`（`ops.receipt_allocated_net` = 分配合计 − 撤销合计），调用点同文件 `:902`（`allocatable := target.amount - ops.receipt_allocated_net(p_receipt_id)`），比对 `:904`。
- 单期余额用**加锁后读到的行**重算：`:913-920` 先 `for update` 按 id 排序锁全部应收（防死锁），`:962` 用 `(allocated_amount - reversed_amount) + 本次 > amount` 判超额。
- 同一期重复出现被单独拦截（`:890`），防「1000 的期收两笔 600，各自合法、合计超额」。
- 前端只提交 `{allocations:[{receivableId, amount}], reason}`，**不提交总额、不提交可分配余额**：`admin/apps/web-antd/src/views/ops/billing/components/receipt-detail-drawer.vue:218`。弹窗里算出的 `allocatable`/`total` 只进二次确认摘要（同文件 `:384-390`），不进请求体。
- 幂等键缺失直接 400 拒绝，避免「重放被当第二次核销」：`udone/apps/api/src/modules/ops/receipts/routes.ts:137`。

### 2. 登记人 ≠ 审核人：**收款强制，退款未强制（真实资损缺口）**

| 对象 | 应用层 | 数据库层 | 测试 |
|---|---|---|---|
| 收款审核 | ✅ `...receipts.sql:730`（`recorded_by = actor_id` → `segregation_of_duty`） | ✅ 表 CHECK `:148-151` | ✅ `udone/supabase/tests/ops_receipt_domain.sql:587`（T5） |
| 退款审核 | ❌ **无**：`transition_refund` 直接把 `approved_by = actor_id`（`:1449`），从不与 `handled_by` 比对 | ❌ `ops.refunds` 无对应 CHECK（表定义 `:216-229`） | ❌ 无 |
| 权益变更审批 | ✅ `...entitlement_domain.sql:1531` | ✅ CHECK `:311-313` | ✅ `ops_entitlement_domain.sql:1423`（C10） |

后端自己在 journal 里承认了这一点：`udone/.harness/journal/2026-10-31-receipt-domain.md:178-180`（C-110「`ops.refunds` 没有职责分离」）。**退款审批是同一条链路上唯一可以「自己登记、自己批、钱出去」的动作**，与计划第 164 行默认规则「收款必须由登记人以外的人审核」的立法意图不对称。

### 3. 退款 / 冲正：只追加反向流水，原流水不被改写

- 撤销核销：插入 `ops.receipt_allocation_reversals`（`:1176`），只累加应收侧的 `reversed_amount`（`:1180`）；**原 `receipt_allocations.amount` 一行不改**，注释明确「不回退 allocated_amount，不改收款状态」（`:1752` 的 COMMENT）。
- 退款：插入新 `ops.refunds` 行（`:1332-1347`），不改原收款金额。
- 冲正：`reverse_receipt` 只改状态与版本（`:1081` 附近的 `update ops.receipts`），全文件对 `ops.receipts` 的 5 处 UPDATE（`:736 / :768 / :994 / :1081 / :1466`）**均只改 status/version/approved_*，无一处改 amount**。
- 撤销上限由 SQL 现算 `allocation.amount - 已撤销合计`（`:1151-1174`），超退同理 `ops.receipt_refundable`（`:262`）。
- 租户命令尝试记录另有不可变触发器（`...tenant_integration_domain.sql:234`），UPDATE/DELETE 直接 raise。

### 4. 金额单一口径：落账口径唯一（服务端），但前端确有「第二套算术」

- **权威口径只有一处**：SQL `numeric(14,2)` + `sum()` 聚合；列表四张合计卡取自服务端 `summary`（`admin/.../views/ops/billing/receivables.vue:125`，渲染 `:436-454`），前端不对明细求和。
- **前端存在第二套算术，但只用于展示与提交前预校验**：
  - `admin/.../api/ops/billing/money.ts:60`（转整数分）、`:183`（`sumAmountStrings`）、`:213`（`compareAmountStrings`），全部走 BigInt 分。
  - `admin/.../views/ops/billing/components/allocation-modal.vue:69`（`allocatableText`）、`:76`（`enteredTotal`）。
  - `admin/.../api/ops/billing/rules.ts:276`（`checkAllocations`）。
  - 这套值不进请求体（见专项 1），所以**不构成第二套落账口径**，只是「预校验与展示的重复实现」。风险是两套实现将来漂移，不是当前算错账。

## 跨域端到端缺陷：多值筛选参数名不一致，服务端筛选静默失效

> 来源：与 general-purpose-3 交叉核对（其 Task 7/8 报告附录），本人独立复核了本审计范围内的三域，**结论成立**。

**现象**：前端把多选状态拼成 `status[]`，后端只读裸 `status`，中间没有归一化。结果是「筛选不生效、不报错、返回全量」。

| 环节 | 证据 |
|---|---|
| 前端 billing 发 `status[]` | `admin/apps/web-antd/src/api/ops/billing/endpoints.ts:90`（`params['status[]'] = [...query.status]`） |
| 前端 entitlement 发 `status[]` | `admin/apps/web-antd/src/api/ops/entitlement/endpoints.ts:82` |
| 前端 tenant 发 `status[]` | `admin/apps/web-antd/src/api/ops/tenant/endpoints.ts:101` |
| 后端 receipts 只读裸 `status` | `udone/apps/api/src/modules/ops/receipts/routes.ts:188`（`context.req.queries('status')`） |
| 后端 receivables 只读裸 `status` | `udone/apps/api/src/modules/ops/receivables/routes.ts:178` |
| 后端 entitlements 只读裸 `status` | `udone/apps/api/src/modules/ops/entitlements/routes.ts:202` |
| 后端 tenant-integration 只读裸 `status` | `udone/apps/api/src/modules/ops/tenant-integration/routes.ts:169` |
| 实际发出的键 | Hono **4.13.12** 已按仓内 dist 复核：`HonoRequest.queries()` 直接委托、无缺键分支（`udone/node_modules/.pnpm/hono@4.13.12/node_modules/hono/dist/request.js:67-69`）；`dist/utils/url.js:188-193` 只为实际出现的键建数组，末尾 `return key ? results[key] : results` 对缺失键返回 `undefined`。因此 9 个路由的 `if (statuses)` 全部跳过（如 `receipts/routes.ts:189`）→ RPC 收 `p_statuses: null` → SQL 视为「不筛」；仅 `exports/routes.ts:208` 的 `?? []` 会得到空数组，SQL 同样视为不筛（该分支在本版本对这 9 个路由不会走到） |
| 空数组在 SQL 里等于「不筛」 | `...ops_billing_receipts.sql:408-410`、`...ops_entitlement_domain.sql:1662-1663`、`...ops_tenant_integration_domain.sql:1228-1229` 均为 `p_statuses is null or cardinality(p_statuses) = 0 or ...` |
| 无自定义序列化器兜底 | `admin/apps/web-antd/src/api/request.ts:116-160` 未设 `paramsSerializer`；`admin/packages/effects/request/src/request-client/request-client.ts:15-37` 的 `brackets/repeat/...` 选项未被启用 → axios 默认按键名原样输出 |

**为什么测试没发现**：后端用例的 URL 构造器是 `url.searchParams.append(key, item)`，键用的是裸 `status`——`udone/apps/api/src/modules/ops/tenant-integration/routes.test.ts:191`；`udone/apps/api/src/modules/ops/entitlements/routes.test.ts:243-246` 构造、`:1022` 传 `status: [...]`，而用例名在 `:1010` 写的却是「status[]」。也就是说，**测试证明的是后端能处理 `status=a&status=b`，从未证明它能处理前端真正发出的 `status[]=a&status[]=b`**。名字与真实线上请求不一致，是这条缺陷能一路绿灯的直接原因。

**修复时须一并钉住的行为**：上面两条引证都绑定 `hono@4.13.12`，升级后返回值可能变化（`[]` 与 `undefined` 都会导致不筛，但测试断言会不同）。建议在修这条时补一个不碰数据库的三行用例：`new Hono().get('/', c => c.json({ q: c.req.queries('status') }))` + 请求 `/?status[]=a`，把线格式断言下来。

**对本审计的影响**：

- 计划第 159 行要求「应收计划、收款、核销、退款、账款明细」页面可用；页面在，但**「按状态筛选」这条在真实链路上不成立**——用户在收款列表选「待审核」，看到的是全部收款。对财务队列来说这比报错危险：筛选栏显示已选条件，列表却没筛。
- 计划第 180 行要求 Playwright 覆盖权限与流程；该缺陷正是只有端到端用例才能抓到的那一类（单测两端各自为真）。
- 因此下文 Task 5 #5、Task 6 #5/#6 的「已实现」**仅指代码存在，不代表端到端可验证**；凡涉及多选状态筛选的能力，一律按「未联调」看待。

## Task 5（8 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 155 | 应收/收款/核销/退款冲正契约确认 | 已实现 | 契约：`udone/packages/contracts/src/ops/receivables.ts`、`receipts.ts`、`billing-shared.ts`；路由版本化 `/api/v1/ops/receipts` 等在 `udone/packages/contracts/src/routes.ts:1033-1170`；状态机函数 `...receipts.sql:277`；权限码种子 `udone/supabase/migrations/20261030000003_ops_identity.sql:542`。全仓无在线支付/银行对账代码（grep stripe/alipay/银行对账 无命中），符合「不做」 | ①契约 §3.4 的 `allocated` 净/毛额自相矛盾已按净额落地、正文未回写（C-109）；②契约声明 `status[]` 多选，后端只认裸 `status`，契约与实现不一致（见跨域缺陷节） |
| 2 | 156 | 负数/超额/并发/不覆盖/越权/审计缺失用例 | 未实现 | 已有：负数 `ops_receipt_domain.sql:302`、未审先核销 `:676`、四类核销拒绝 `:656` 起、撤销 `:849`、退款 `:990`、审计 `:1315`、权限 `:1525`；API 用例 `udone/apps/api/src/modules/ops/receipts/routes.test.ts`（959 行）；幂等缺键 `routes.test.ts:363` | **「并发超额核销」没有用例**——后端 journal 自认：`udone/.harness/journal/2026-10-31-receipt-domain.md:171-173`「真正的并发核销没测……没有两个连接同时跑一笔核销」。`for update` 与排序加锁设计正确但无证据 |
| 3 | 157 | 精确 decimal/事务/唯一幂等键/RLS+审计同边界 | 已实现 | `numeric(14,2)` 全表（`:119/:177/:197/:216`）；事务内多表写入 + 审计同函数（`allocate_receipt` `:1001`）；持久化幂等表 `udone/supabase/migrations/20261030000001_ops_schema_idempotency.sql:20`（`scope_key` 唯一）；表级 `REVOKE ALL`（`:1497`）仅授 EXECUTE（`:1658` 起） | — |
| 4 | 158 | 版本化 API 契约 + 幂等重放或稳定冲突 | 已实现 | `/api/v1/` 前缀（`routes.ts:1033`）；幂等中间件重放首次响应、指纹不符回 409：`udone/apps/api/src/middleware/idempotency.ts:148-160`；金额仅 `numeric`，无浮点换算路径（`:881` 小数位校验） | 契约文档 §6.4 尚缺 3 个新 reason（后端 journal `:184`） |
| 5 | 159 | admin 应收/逾期/收款/核销/退款/冲正/明细页 | 已实现 | `admin/apps/web-antd/src/views/ops/billing/{receivables,receipts,refunds,ledger}.vue`；逾期状态服务端派生 `...receivables.sql:115-129`；高风险二次确认 `views/ops/billing/components/high-risk-modal.vue`，提交状态机 `composables/use-high-risk-action.ts`；页面已接真实 API 模块（`receivables.vue:50` 等 4 处） | ①客户/合同选择器仍是手填 ID（journal C-11）；②**多选状态筛选在真实链路上失效**（前端发 `status[]`、后端读 `status`，见跨域缺陷节），「待审核队列」会显示全部收款——页面在，筛选未联调 |
| 6 | 160 | 组件测试 + Playwright + 并发/幂等 | 未实现 | 组件/单测 73 条齐全：`views/ops/billing/__tests__/`（money/rules/errors/timeline/high-risk-action/dev-stub/receipt-approve-button）；pgTAP/API 覆盖已见第 2 条 | **无任何 billing 的 Playwright 用例**：`admin/apps/web-antd/e2e/` 只有 `access/auth/governance/permission.e2e.ts`，无分次收款/核销/退款冲正流程；并发仍缺。补 e2e 时必会暴露状态筛选失效（跨域缺陷节）——这正是单测两端各自为真、合起来为假的那类 |
| 7 | 161 | 本地隔离库并发验证 + staging 虚构验收（带请求 ID/账务核对） | 未实现 | pgTAP 套件可跑（`udone/package.json:24` `db:test`），后端 journal 称 829 断言全绿 | 无并发验证、无 staging 验收、无「请求 ID + 账务核对结果」产物。`admin/.harness/journal/` 与 `.workbuddy/reports/` 均无此证据 |
| 8 | 162 | PRD traceability + 财务运行注意 + journal | 未实现 | journal 已写：`admin/.harness/journal/2026-10-29-task5-billing.md`；后端 `udone/.harness/journal/2026-10-31-receipt-domain.md` | `admin/Docs/PRD.md` 无 R-ID → 实现的追溯链接（grep `traceab/R-ID` 无命中）；无「财务运行注意项/runbook」文档 |

## Task 6（8 条）

| # | 行号 | 条目摘要 | 判定 | 证据 | 缺什么 |
|---|---|---|---|---|---|
| 1 | 174 | 订阅/授权快照、变更审批执行、租户映射、命令状态、失败重试契约；区分商业权益与运行态 | 已实现 | `udone/packages/contracts/src/ops/entitlements.ts`、`tenant-integration.ts`；快照不可变 `...entitlement_domain.sql:124`（触发器 raise）；命令状态机 `...tenant_integration_domain.sql:252` + 失败分类 `:155-163`；商业权益（快照）与运行态（tenant_commands）分表 | 契约里「与 udone 运行态」的映射仍是文档级约定，无代码校验 |
| 2 | 175 | SaaS 开通/延长/缩减/暂停/恢复/过期迁移 + 审批权限 + 审计 + 合同约束 | 已实现 | 状态动作表 `...entitlement_domain.sql:328`（含 `mark_expired`）；变更类型 `:271`（issue/extend/upgrade/downgrade/quota_change/suspend/resume/expire/revoke）；权限分流 `:1182-1184`（request/approve/execute）；合同状态守卫 `:871`；过期守卫 `:1285` | 「与收款的约束」按计划规则故意不阻断（第 172 行），无自动校验，靠审批 |
| 3 | 176 | 未审批执行拒绝/同命令幂等/超时可查/跨客户租户拒绝/失败不标成功/可审计 的 DB+API 测试 | 已实现 | `ops_entitlement_domain.sql:735`（approval_required）、`:1063/:1423`（不可自批）；`ops_tenant_integration_domain.sql:661`（A1 运营不能标成功）、`:718`（A4）、`:757`（A8 成功不可写两次）、`:1176`（A26 超时仍 pending）、`:1499`（U5 超时审计）、`:370`（一租户一客户冲突）；API 层 `entitlements/routes.test.ts`（1133 行）、`tenant-integration/routes.test.ts`（830 行） | 均为串行用例；跨客户「租户 ID」是以 unique 约束证明，无并发双连接 |
| 4 | 177 | udone 命令事务/状态/可信身份/权限；调用租户 API 只传业务字段、不直写租户内部表 | 未实现 | 已做到部分：状态机/权限/审计完整（`:794` `transition_tenant_command`）；无直写租户内部表，只有 `udone_organization_id` 外参（`:458`） | **执行侧完全不存在**：无 HTTP 客户端、无调度器，全仓唯一的成功入口 `record_tenant_command_attempt` 只授 `service_role` 且**没有调用方**（后端 journal `:249-250`、`udone/.harness/journal/2026-10-31-entitlement-domain.md:212-214`）。「调用现有/新增租户 API」这一步从未发生 |
| 5 | 178 | 命令创建/查询/重试 + 权益查询 + 同步状态 API；持久化幂等键/requestID/状态/失败分类；重试先查询 | 已实现 | 10 个端点 `udone/apps/api/src/modules/ops/tenant-integration/routes.ts:251-590`；权益 15 端点 `entitlements/routes.ts:311-834`；幂等键唯一约束 `:174`；失败分类 `:155`；退避 `:283`；重试仅 `failed` 且排除 `permanent`（`:252` + `:846`） | `request_id` 列存在但**建命令时不写入**（`:756-762` 的 INSERT 无该列）；后端 journal `:258-260` 自认「贯通只做了半程」；另：命令列表的 `status[]` 筛选同样失效（`tenant/endpoints.ts:101` 对 `tenant-integration/routes.ts:169`） |
| 6 | 179 | admin 授权/订阅详情、差异预览、审批后执行、租户映射、同步状态、安全重试 | 已实现 | `admin/.../views/ops/entitlement/{subscriptions,licenses,change-requests}.vue` + `components/change-request-diff.vue`、`state-machine-panel.vue`（动作表驱动，不直写终态）；租户 `views/ops/tenant-integration/{mappings,commands}.vue` + `command-detail-drawer.vue:376-432`（重试前展示上次错误码/分类与风险） | 命令状态无轮询，需手动刷新（journal 风险 2）；订阅/授权/变更申请三页的多选状态筛选同样失效（`entitlement/endpoints.ts:82` 对 `entitlements/routes.ts:202`） |
| 7 | 180 | 组件/Vitest 状态机+错误映射；Playwright 权限拒绝/审批前拒绝/超时查询/安全重试；pgTAP 重复命令与隔离 | 未实现 | Vitest 齐全：`entitlement/__tests__/`（7 文件，含 `approval-segregation`、`execute-approval`、`snapshot-readonly`）、`tenant-integration/__tests__/`（7 文件，含 `command-submission`、`tenant-rules`）；pgTAP 见第 3 条 | **无 entitlement/tenant 的 Playwright 用例**（`admin/apps/web-antd/e2e/` 仅 4 个非业务域 spec）；「审批前按钮/直接 API 拒绝」「超时后查询」只有 Vitest 桩层覆盖，无真浏览器链路 |
| 8 | 181 | staging 两个虚构运营身份/组织边界验收 + journal | 未实现 | 两个域的前端 journal 均已写：`admin/.harness/journal/2026-10-29-task6-entitlement.md`、`2026-10-29-task6-tenant.md` | 无 staging 环境、无两个真实运营身份的验收记录。所有前端证据都是 `VITE_OPS_MOCK=true` 桩或 Vitest，跨组织边界从未在真实后端上验过 |

## 最危险的四个缺口

1. **退款审批无职责分离（资损级）**：`ops.refunds` 既没有表 CHECK，`transition_refund` 也不比对经办人（`...receipts.sql:1446-1453`）。同一个人可以登记退款并自己批准，钱直接退出；而收款侧是双层的。这是 Task 5 与计划第 164 行默认规则之间唯一的硬冲突。
2. **并发核销「设计正确、零证据」**：`for update` + 排序加锁 + 锁后聚合看起来完全正确，但没有任何两个连接同时核销的用例；后端 journal 明确把它列为「未验证项 1」。一旦加锁逻辑被后人改动，没有测试会红。
3. **租户交付从未真正下发**：整个 Task 6 对外承诺「202 已受理」，但执行侧（HTTP 客户端 + 调度器 + attempt 写入）不存在，`record_tenant_command_attempt` 无调用方。客户侧的开通/停用/权益同步一次都没发生过，`suspend`/`resume`/`revoke` 只改本地状态。
4. **状态筛选静默失效（跨域）**：前端 `status[]` 对后端 `status`，多选筛选恒等于「不筛」，且不报错。对财务队列影响最大——「待审核」页会列出全部收款，运营可能据此以为没有待办。三域（billing/entitlement/tenant）同时中招，只有端到端用例能发现。

其他需登记但不属资损的：`request_id` 未在建命令时落库（178 半程）、PRD 无追溯链接（162）、账号「审批人单点」只有 `platform_admin` 有 `entitlement.approve`（后端 journal 未验证项 4）。
