# Task 7 前端 · support 域（售后工单）交付记录

- 日期：2026-10-29
- 执行人：support 域前端开发专家（并行任务，与 deployment 域互不交叉）
- 工作树：`D:/MYC/Coding/ERP-ops`，分支 `feat/ops-console`
- 契约真源：`Docs/ops-api-contract.md` §3.8 / §5.8 / §4 / §6；`Docs/PRD.md` §6.9 / §8 / §9
- 前置门禁：`.harness/journal/2026-10-29-source-gate-task6-7.md`（§4.1 终态原因、§4.2 逾期不自算、§4.3 时间线为核心）
- 许可合规：**未复制 ERPNext 任何代码**。本次未再打开 `_refs/erpnext`，行为依据只取自已通过的参考门 journal §4 的结论（`declare_enquiry_lost` 的终态原因守卫、`auto_close_opportunity` 的调度器超期判定、`test_opportunity_status` 的时间线语义），实现全部自写。

## 1. 改动 / 新增文件

### 1.1 域 API 客户端（`apps/web-antd/src/api/ops/support/`）

| 文件 | 职责 |
| --- | --- |
| `endpoints.ts` | 端点清单（`/tickets`、`…/assign`、`…/transition`、`…/timeline`、`…/events`、`…/references`）、`isSupportStubEnabled()` 静态开关、幂等键、`buildTicketListParams()` 白名单、分页常量 |
| `types.ts` | 契约 §3.8/§5.8 字段与枚举（`TicketStatus`/`TicketPriority`/`TicketAction`/`TicketEventType`/`TicketRefType`），推导字段带 `?` 并注明 |
| `tickets.ts` | 列表 / 详情 / 创建 / PATCH（PATCH 仅暴露契约能力，本批次界面未接编辑入口） |
| `transitions.ts` | `assignTicket()`、`transitionTicket()`（唯一状态写入通道） |
| `events.ts` | `fetchTicketTimeline()`、`addTicketComment()`、`addTicketReference()`（不提供任何编辑/删除） |
| `rules.ts` | 状态动作表、前置守卫、原因校验（纯函数，单测覆盖） |
| `format.ts` | 状态/优先级/事件词表、逾期徽标、联系方式掩码、时间格式化、`eventReason()` |
| `errors.ts` | `describeTicketError()`：409 → 「数据已变化，请刷新后重试」+ `allowedActions` |
| `fixtures.ts` | 6 张**虚构**工单、20 条事件、2 条关联（客户名统一带「（虚构）」） |
| `dev-stub.ts` | 契约桩：复刻状态机、守卫、409/400、时间线只追加 |
| `index.ts` | 域出口 |

### 1.2 页面（`apps/web-antd/src/views/ops/support/`）

| 文件 | 说明 |
| --- | --- |
| `list.vue` | 替换原占位页：服务端分页 + 状态/优先级/分派（全部·分派给我·未分派）/客户/更新时间起/创建时间区间/只看逾期；建单弹窗 |
| `detail.vue` | 新增：头部摘要 + **时间线主视图** + 操作区（流转/分派/备注）+ 关联对象 |
| `timeline.ts` | 时间线拼装纯函数（升序、状态变迁路径、原因取值） |
| `components/ticket-timeline.vue` | 时间线渲染（事件类型 + 操作者 + 时间 + 原因/等待对象，状态路径可见） |
| `components/ticket-state-panel.vue` | 当前状态 + 可用动作 + 每个动作所需动作码；终态无常规动作、重开单列例外区块 |
| `components/ticket-transition-modal.vue` | 流转弹窗：`waitingOn`/`resolutionSummary`/`reason` 校验 + 二次确认；不通过**不 emit** |
| `components/ticket-assign-modal.vue` | 分派弹窗（成员列表缺失时降级为填 ID，并说明原因） |
| `components/ticket-comment-form.vue` | 备注输入（空内容不发请求） |
| `components/ticket-create-modal.vue` | 建单（客户远程搜索 + 必填校验） |
| `components/ticket-overdue-badge.vue` | 逾期徽标：**只接收工单对象，不接收当前时间** |
| `composables/use-customer-options.ts` | 客户搜索项（`GET /customers` 只读，服务端关键字） |
| `__tests__/*.test.ts` | 6 个测试文件、30 条用例 |

### 1.3 路由

`apps/web-antd/src/router/routes/modules/support.ts`：新增子路由 `SupportTicketDetail`（`/support/tickets/detail/:ticketId`，`hideInMenu` + `activePath` 保持菜单高亮）。未改动 `guard/access/index` 或其它路由模块。

## 2. 硬性口径的落点（代码位置）

### 2.1 「逾期不由前端计算」

| 落点 | 内容 |
| --- | --- |
| `api/ops/support/format.ts` → `ticketOverdueView()` | 只读 `isOverdue`：`true`→已逾期、`false`→未逾期、缺省→`已知=false` 显示「逾期标识未返回」。函数签名不含时间参数 |
| `views/ops/support/components/ticket-overdue-badge.vue` | 接收整条工单（`Pick<Ticket,'dueAt'|'isOverdue'>`），不接收 `now`；缺字段时不猜 |
| `views/ops/support/list.vue` | 「只看逾期」走服务端 `overdueOnly`；页脚常驻说明 `OVERDUE_SOURCE_NOTE` |
| 筛选参数 | `overdueOnly` 为契约字段；`createdFrom/createdTo/unassigned` 为推导项（见 §5） |

**为什么组件收整个对象而不是 `boolean` prop**：Vue 会把缺省的 `Boolean` prop 强制转成 `false`，那样「服务端没下发」与「未逾期」就分不开，恰好会掩盖契约缺字段——这是本域刻意规避的陷阱。

### 2.2 「终态必填原因」

| 落点 | 内容 |
| --- | --- |
| `api/ops/support/rules.ts` → `validateTicketReason()` / `validateTicketAction()` | 原因 trim 后为空 → `ok=false` 并给出中文提示；`close`/`reopen` 的 `requiresReason=true`，`wait` 需 `waitingOn`，`resolve` 需 `resolutionSummary` |
| `views/ops/support/components/ticket-transition-modal.vue` → `onOk()` | 校验不通过 → 标红并 `return`，**不 `emit('submit')`**；页面只在 `@submit` 里发请求，因此「未填原因不发请求」是结构保证 |
| `views/ops/support/detail.vue` → `submitTransition()` | 提交前再次 `validateTicketAction()`，任何路径都不会不带原因调 `transitionTicket()` |
| `dev-stub.ts` → `stubTransitionTicket()` | 桩同样对 `wait`/`resolve`/`close`/`reopen` 缺失字段返回 400，避免前端在假成功里漏掉分支 |

### 2.3 409 冲突（他人已流转）

- `errors.ts` → `describeTicketError()`：`CONFLICT`/`STATE_CONFLICT` 一律 `shouldRefresh=true`，文案含「数据已变化，请刷新后重试」，并回显 `details.allowedActions`。
- `detail.vue` → `handleMutationError()` / `refreshAfterConflict()`：冲突后重新拉取详情，顶部提示「数据已变化，请刷新后重试」+ **当前最新状态 / 版本 / 指派人**；`submitTransition` 不重放原动作（旧 `version` 只会再撞一次 409）。

### 2.4 权限与掩码

- 无 `ticket.read`：`list.vue` / `detail.vue` 都只渲染「无访问权限 + 所需动作码」，不加载数据、不渲染任何工单或客户信息。
- 动作级：`ticket-state-panel.vue` 按 `rules.ts` 渲染，缺码时按钮禁用并写明 `ticket.assign` / `ticket.update` / `ticket.close`。
- 联系方式：`format.ts` → `ticketContactLines()` 默认取 `maskedPhone/maskedEmail`；只有具备 `customer.sensitive.read` **且**后端下发原值时才显示原值（与 customer 域同口径），并附 `contactHint()` 说明。
- 当前操作人：`list.vue` 只读引用 `#/views/ops/entitlement/composables/use-current-operator`（`useUserStore().userInfo.userId`），避免第二套身份读取口径；客户下拉只读调用 `GET /customers`（`support_agent` 具备 `customer.read`）。两者都不修改对方域文件。

## 3. 状态覆盖（每页）

| 状态 | 列表 | 详情 |
| --- | --- | --- |
| loading | 表格 `:loading` | 首屏 `Spin` |
| empty | `#emptyText` 说明 | 时间线 `Empty` |
| error | `OpsErrorAlert` + 重试 | 同左（含 `requestId`） |
| validation | 建单弹窗字段级错误 | 流转/备注字段级错误（不发请求） |
| permission-denied | `OpsPermissionDenied`（不泄露数据是否存在） | 同左 |
| conflict | 列表重试提示 | 409 → 刷新 + 「当前最新状态」横幅（`data-testid="ticket-stale-notice"`） |
| destructive-confirm | 建单为新建、无破坏性动作 | 关闭/重开：警告 + 原因必填 + 勾选确认 |

## 4. 与任务书的差异（契约优先，显式登记）

**「终态无可用动作」vs 契约允许重开。** 任务书把「关闭/取消/解决」统称终态并要求「终态无可用动作」，但契约 §3.8 状态机明写 `resolved`/`closed` --`reopen`--> `in_progress`（需 `ticket.close` + 原因），且 §5.8 规定 `closed` 只允许 `reopen`。处理方式：

- `ticketStatusActions('closed')` 返回**空数组**（常规处置动作为空，满足「终态无可用动作」）；
- `ticketReopenAction('resolved'|'closed')` 单独返回重开动作，页面上放在「终态例外」区块，视觉上不与常规动作混淆；
- 单测同时断言两者（`state-actions.test.ts`）。

`resolved` 仍有 `close` 常规动作（契约表：`resolved --close--> closed`），这与「解决即终态」的表述不同，按契约实现。

## 5. 契约推导项（待后端确认）

| 编号 | 项 | 现状 | 需要的动作 |
| --- | --- | --- | --- |
| U-07a | `GET /tickets` 响应 **`isOverdue`** | §5.8 列表字段未列该字段 | 后端补布尔字段（服务端按 `settings.ticket.dueHours` + `Asia/Shanghai` 计算）。前端已按「缺失即降级」实现，字段上线即自动生效，无需改前端 |
| U-07b | `GET /tickets` 查询参数 `createdFrom`/`createdTo` | §5.8 只有 `updatedFrom` | 确认是否支持创建时间区间；不支持则需从界面移除该筛选项 |
| U-07c | `GET /tickets` 查询参数 `unassigned` | §5.8 只有 `assigneeOperatorId` | 确认「未分派」的服务端表达（或改用 `assigneeOperatorId=null` 约定） |
| U-08 | `GET /tickets/{id}` 的 `assignableOperators` | 契约未定义；`GET /operators` 需 `operator.read`，预置 `support_agent` 无该动作码 | 建议由工单详情回带可分派成员；未回带时页面降级为「填写成员 ID」并说明原因 |
| U-09 | `ops.ticket_events` 无 `reason` 列 | 终态原因落在何处未定义 | 建议明确写入 `metadata.reason`（前端已按 `reason` → `metadata.reason` → `body` 顺序取值） |

## 6. 开发态数据（诚实隔离）

- 开关：`endpoints.ts` 的 `isSupportStubEnabled()` = 静态 `import.meta.env.VITE_OPS_MOCK === 'true'`；桩用**动态 import**，生产构建整体摇掉。
- 数据：`fixtures.ts` 全部虚构（客户名带「（虚构）」，邮箱用 `example.invalid`，电话用 `138****0001` 类测试号段），无任何真实客户或真实人名。
- 标注：页面复用 `views/ops/customer/components/ops-dev-data-notice.vue`（`VITE_OPS_MOCK=true` 时显示「开发态数据」，措辞不绑定金额，适用于工单）。**未**直接引用 billing 的 `dev-data-notice.vue`——其文案写死「虚构金额、不可用于对账」，在工单页会误导。
- 桩复刻的不变量：非法迁移 409 + `allowedActions`、`version` 冲突 409、守卫缺失 400、`closed` 不可分派/不可备注、重复关联 409、时间线只追加、`isOverdue` 原样透传（不重算）。

## 7. 单测清单（`apps/web-antd/src/views/ops/support/__tests__/`）

| 文件 | 覆盖 |
| --- | --- |
| `state-actions.test.ts`（7） | 每状态动作表；`closed` 常规动作为空 + 重开为例外；未知状态不猜；`allowedActions` 取交集；面板只渲染当前态动作；缺码禁用且不上报 |
| `terminal-reason.test.ts`（4） | 未填原因点关闭 → 无 `submit`（= 不发请求）；填原因未勾选 → 仍不发；原因+确认 → 上报且 trim；`wait` 缺等待对象 → 不发 |
| `timeline-order.test.ts`（5） | 乱序输入 → 升序输出；含分派/状态变更/备注三类；状态路径文案；概览计数与空值降级；DOM 渲染顺序 |
| `overdue-from-server.test.ts`（5） | `isOverdue=false` + `dueAt` 已过期 → 仍「未逾期」；`isOverdue=true` → 已逾期；缺失 → 未返回；**源码扫描**无 `Date.now()`/`performance.now()`/`new Date()`/`dueAt` 比较 |
| `permission-denied.test.ts`（4） | `canViewTicket` 拒绝；无 `ticket.read` 页面不出现工单号/客户名/掩码电话；有读权限无 `ticket.create` 不渲染建单入口；`closed` 分派/备注按状态拒绝 |
| `conflict-errors.test.ts`（5） | 409 `CONFLICT`/`STATE_CONFLICT`（含 `allowedActions`）、403、400 `REFERENCE_CUSTOMER_MISMATCH`、网络失败 |

合计 30 条用例，全部通过。

## 8. 验收命令与真实输出（2026-10-29 23:55 本地）

```text
$ corepack pnpm --filter @vben/web-antd typecheck
> vue-tsc --noEmit --skipLibCheck
（无输出，退出码 0）

$ corepack pnpm --filter @vben/web-antd test:unit
 Test Files  47 passed (47)
      Tests  321 passed (321)
   Duration  26.63s

$ corepack pnpm run lint:check
Found 0 warnings and 0 errors.
Finished in 2.7s on 273 files with 226 rules using 2 threads.
（eslint / stylelint 段无输出，退出码 0）

$ corepack pnpm run format:check
Checking formatting...
All matched files use the correct format.
Finished in 2432ms on 1197 files using 2 threads.
```

### 8.1 与并行 deployment 域的交互

- 首次 typecheck 时命中了 deployment 域的 4 个错误（`api/ops/deployment/dev-stub.ts`、三个 `views/ops/deployment/components/*.vue`）。按边界要求**未修改**这些文件，仅登记；随后由 deployment 负责人修复，最终四条命令对其同样通过。
- 中途还出现过 3 次 vitest「Failed to start forks worker / Timeout waiting for worker to respond」（分别落在 `billing/dev-stub.test.ts`、`api/__tests__/stub-contract.test.ts`），单独重跑该文件即通过，最终整轮 `47 files / 321 tests` 全绿。判定为并行构建叠加导致的 worker 启动抖动，与用例断言无关。

## 9. 风险（给 leader）

1. **`isOverdue` 尚未在契约中**：前端已按「缺失即降级」实现，但若后端最终不补该字段，「逾期」在界面上会一直显示「逾期标识未返回」。这是有意的诚实降级，不是缺陷；请在接口评审时钉死字段名。
2. **「未分派」「创建时间区间」两个筛选参数为推导项**：后端若忽略 `unassigned`/`createdFrom`，页面会出现「筛了没效果」的观感（当前不做客户端兜底过滤，避免全量拉取）。建议随 U-07 一起确认。
3. **分派成员列表依赖 `assignableOperators`**：预置 `support_agent` 无 `operator.read`，若后端不回带该字段，运营只能手填成员 UUID——功能可用但体验差；建议 U-08 尽快落定。
