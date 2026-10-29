# 运营端后端交接书（ops API）

> **读者**：接手 `udone` 后端实现的会话（人或 Agent）。
> **一句话**：前端六个业务域已实现并全部走契约层，**后端一行 ops 代码都还没有**。你按本文件落地，前端切一个开关即可联调，不需要改页面。
> **真源顺序**：`Docs/ops-api-contract.md`（字段/端点/错误的唯一真源） > 本文件（交接约定与缺口清单） > PRD。
> 生成日期：2026-10-29 ｜ 对应前端分支：`feat/ops-console`

---

## 1. 先看这四件事（30 分钟上手）

| 顺序 | 文件 | 看什么 |
| --- | --- | --- |
| 1 | `Docs/ops-api-contract.md` §1–§2 | 边界与总则：哪些归 ops、金额精度、错误体形态、幂等要求 |
| 2 | 同上 §3 | 九个域的表结构、字段、状态机、约束（**字段名照抄**） |
| 3 | 同上 §7 | RLS 隔离模型与 P1–P13 拒绝证明清单 |
| 4 | 同上 §9 | T-01 ~ T-14 任务书，已完成与未完成按它记账 |

前端现状可作为**字段名的活文档**：`apps/web-antd/src/api/ops/<domain>/types.ts` 就是前端已冻结的请求/响应类型。

---

## 2. 边界：谁写哪里

| 区域 | 归属 | 说明 |
| --- | --- | --- |
| `udone/apps/api/src/modules/ops/**` | **你** | 新模块，按域分目录 |
| `udone/packages/contracts/src/ops/**` | **你** | 路由清单、错误码、权限常量 |
| `udone/supabase/migrations/**` | **你** | `ops` schema 与全部迁移 |
| `udone/supabase/tests/**` | **你** | pgTAP（P1–P13） |
| `admin/**`（前端） | **不要动** | 已冻结；需要改字段时先改契约、再通知前端 |
| `udone` 既有模块（非 ops） | 你 | 仅允许在路由注册处加一行挂载 |

**唯一允许的前端改动**：联调时把 `VITE_OPS_MOCK` 置为 `false`（不是改代码）。

---

## 3. 落地顺序（依赖关系，不是建议）

```
T-01 契约包与路由骨架
  └─ T-02 迁移引导 + RLS 帮助函数 + ops schema
       └─ T-03 运营身份（operator / membership / 权限）
            ├─ T-04 客户与联系人
            │    ├─ T-05 产品/套餐/价格版本
            │    │    └─ T-06 合同与版本快照
            │    │         ├─ T-07 应收与展期
            │    │         │    └─ T-08 收款/审核/核销/退款
            │    │         └─ T-09 订阅/授权/权益快照
            │    │              └─ T-10 租户映射与命令
            │    └─ T-11 私有化部署台账
            └─ T-12 售后工单与时间线
                 └─ T-13 总览/报表/导出
                      └─ T-14 跨域拒绝与回归（P1–P13 全量）
```

- **T-01/T-02/T-03 是硬前置**：没有 `ops.current_operator_id()` 与权限判定，后面所有域都无法正确授权，做了也要返工。
- T-04 之前的三个任务完成并跑通 `/meta` 后，前端就可以开始真实联调（登录 + 权限 + 菜单）。
- 每完成一个域，跑一次 §8 的验收，**不要攒到最后**。

---

## 4. 不可协商的硬约束

1. **schema 隔离**：全部运营表在 `ops` schema，`anon` 与业务租户角色不得有 USAGE。P1 拒绝是独立测试项，不是「顺便」。
2. **错误体与 udone 完全一致**：`{ code, message, requestId }`，`details` 里带 `reason` / `allowedActions` / `state`。前端按这个结构解析，**不要为 ops 另立格式**。
3. **金额**：DB `numeric(14,2)`，JSON 出 `number` 两位小数。禁止整数分、禁止字符串金额、禁止前端换算（前端只格式化）。
4. **时间**：`date` 只放纯日期字段，`timestamptz` 放时刻字段；所有时刻出 ISO 8601 带时区。
5. **幂等**：写操作必填 `Idempotency-Key`（前端已统一注入）。同键重复提交必须返回**同一结果**，不是新建一条。
6. **乐观锁**：`PATCH` / `transition` / `assign` 带 `version`，不匹配返回 409 `CONFLICT`。
7. **状态机**：非法迁移一律 409 `STATE_CONFLICT` 且带 `details.allowedActions`（前端靠它渲染按钮，缺了按钮会消失）。
8. **审计**：状态变更、金额动作、审批、执行都要落到 `ops.audit_events`；`ticket_events` / `entitlement_snapshots` / `tenant_command_attempts` 仅 INSERT。
9. **失败不得装成成功**：租户命令下发返回 202「已受理」，只有远端确认后才 `succeeded`；超时保持 `pending` 并记录 `attempts.outcome='timeout'`。

---

## 5. 前端已冻结的假设 —— 逐条对照

> 下表是**前端已按此实现**的项。你要么照着实现，要么先改契约并通知前端；**不要静默改成别的样子**，那会让页面出错却不报错。

### 5.1 契约缺端点（前端已按同形态补齐，需你实现）

| 编号 | 项 | 前端期望 | 不实现的后果 |
| --- | --- | --- | --- |
| U-05 | `POST /subscriptions/{id}/transition`、`POST /licenses/{id}/transition` | `{action, reason?}` → `{subscription\|license}` | 订阅/授权草稿期无法提交审批，页面只剩只读 |
| U-06 | `GET /entitlement-snapshots?subjectType&subjectId` | `items[]` 快照历史 | 快照历史退化为「仅当前快照」，历史不可回溯 |
| D-01 | `POST /deployments/{id}/transition` | `{action, reason?, version}` | 部署实例状态无法推进（planned→…） |
| U-07 | `POST /auth/login`、`POST /auth/refresh`、`POST /auth/logout` | 登录返回 `{accessToken}` + `Set-Cookie` 刷新令牌 | **契约 §5.1 未列**，前端 `api/core/auth.ts` 已在调用（注释自承「沿用设计文档」）。不补定义登录就无法实现，见 §11.2 P0-2 |

> 另一处缺口（不在上表）：`identity` 域前端只有 `session.ts`，`/operators`、`/roles`、`/permissions`、`/audit-events` **零客户端**。T-03 的账号管理端点不会有现成页面消费，验收只能做到 API 层，见 §11.3。

### 5.2 错误 reason 词表缺口

| 编号 | 现状 | 前端处理 |
| --- | --- | --- |
| `SYNC_VERSION_CONFLICT` | **不在** §6.4 词表；§5.7 命令下发 409 只写 `STATE_CONFLICT` | 按「`STATE_CONFLICT` + 该 reason」识别并**强制刷新**；同时兜底任意 409 |

**请二选一**：把 `SYNC_VERSION_CONFLICT` 补进 §6.4，或明确「用 `STATE_CONFLICT` 不带 reason」。前端已兼容两种，但契约里要有定论。

### 5.3 字段与语义

| 编号 | 项 | 前端已实现 | 需要你确认/补 |
| --- | --- | --- | --- |
| U-07a | `GET /tickets` 的 **`isOverdue`** | 只读该字段；缺失时显示「逾期标识未返回」 | **必补布尔字段**，服务端按 `settings.ticket.dueHours` + 时区算。前端**禁止**自算，这是硬规则 |
| U-07b | `GET /tickets` 的 `createdFrom`/`createdTo` | 已发送 | 确认是否支持；不支持请告知，前端移除该筛选项 |
| U-07c | `GET /tickets` 的 `unassigned=true` | 已发送 | 确认「未分派」的服务端表达（或约定 `assigneeOperatorId=null`） |
| U-08 | `GET /tickets/{id}` 的 `assignableOperators` | 有则下拉选择，无则降级为「填写成员 ID」并说明 | 建议详情回带；`GET /operators` 需 `operator.read`，售后角色没有该权限 |
| U-09 | 终态原因的落点 | 按 `reason` → `metadata.reason` → `body` 顺序取值 | `ticket_events` 无 `reason` 列，建议明确写进 `metadata.reason` |
| — | 202 响应体两处写法不一致 | §2.4 是 `{commandId,status,idempotencyKey}`，§5.7 是 `command{...}`；前端双兼容 | 定稿一种，写进契约 |
| — | `quota` vs `quota_value` | 前端统一用 `quota`（响应字段） | DB 列名可保留 `quota_value` |
| — | `before_summary`/`after_summary` 形状 | 假定含 `features[]{featureKey,enabled,quota,termMonths,displayName}`，否则降级原文展示 | 定稿 jsonb 结构 |
| U-04 | 变更申请状态集 | 按 8 态渲染（draft/pending_approval/approved/executing/executed/failed/rejected/cancelled） | 契约已标「推导」，请确认后转正 |
| — | 租户命令 `cancel` 的权限 | 前端按 `commandType` 映射到原动作码 | 后端 `cancel` 也要走同样映射，不能固定成 `tenant.retry` |
| D-04 | 部署「最后上报时间」 | 用最近一条版本记录的 `createdAt`（列头注明口径） | 若需真实心跳，要新增 `last_reported_at` 与上报链路 |
| D-07 | `rolled_back` / `failed` 是否回写 `currentVersion` | 桩内约定：`succeeded` 才推进，其余保持 | 定稿并写入契约 |
| D-05 | 维护期预警窗口 | 前端常量 30 天（只影响高亮） | 若要走 `settings.overview.expiryWindowDays`，需在 `/meta` 下发 |

### 5.4 筛选参数（前端已在发，需入白名单）

`GET /deployments`：`deploymentType`、`productId`（D-02/D-03）。
`GET /subscriptions`：`billingCycle`、`endsFrom`、`endsTo`；`GET /licenses`：`licenseMode`。
`GET /tenant-mappings`：`syncVersion`。

后端未实现应**忽略未知参数**而不是 400，否则页面筛选会整片报错。

---

## 6. 前端如何切到真实 API

```bash
# 1) 后端起来后，确认 ops 路由可达
curl -s http://localhost:<port>/api/v1/ops/meta | jq .

# 2) 前端关闭开发态桩（同源部署，走 /api 代理）
cd admin/apps/web-antd
# .env.development 中：VITE_OPS_MOCK=false

# 3) 起前端，验证登录与菜单
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"
cd admin && corepack pnpm -F @vben/web-antd dev
```

**切换后必须验证的三件事**：

> ⚠️ **2026-10-30 后端实测更正**：`VITE_OPS_MOCK` 在 `.env.development` 与 `.env.production` 中**均已是 `false`**，上面第 2 步是空操作。真实前提是「同一来源」——dev 必须走同源代理，否则浏览器会丢弃 `Set-Cookie`（后端 CORS 当前 `credentials: false`）。另：下面第 1 条「不匹配会拒绝渲染」当前**不成立**，`api/ops/README.md` 自承「前端暂不阻断」。两处详见 §11.2 P0-2 / P0-3。
1. 登录 → `/meta` 返回 `contractVersion`，前端校验不匹配会拒绝渲染业务页；
2. 任一列表页能翻页筛选（证明服务端分页参数被接受，而不是 400）；
3. 页面顶部不再出现「开发态数据」提示（桩已彻底退出）。

---

## 7. 不要做的事

- ❌ 为 ops 另设错误体（如 `{success:false}`）——前端解析会失败。
- ❌ 把 `isOverdue` 让前端算——时钟与时区不一致会产生假告警，这是明确的禁止项。
- ❌ 失败时返回 200 + `status:'failed'`——前端按 HTTP 语义分支，会误判为成功。
- ❌ 静默改字段名（如 `ticketNo` → `ticket_no`）——前端类型已冻结，改了页面不报错但显示空白。
- ❌ 用 `DELETE` 处理「撤销」——契约要求反向记录，历史不可抹除。
- ❌ 让 ops 表落到 `public` schema 或复用业务租户表——P1–P13 会失败，隔离承诺作废。

---

## 8. 验收（每个域完成就跑，不要攒）

| 层 | 命令/方式 | 判定 |
| --- | --- | --- |
| 路由对账 | `route-parity.test.ts` | 删除任一 ops 路由挂载即失败 |
| RLS 拒绝 | `supabase/tests/ops_*.sql`（P1–P13） | 全部按 §7.4 表的预期结果 |
| 契约一致性 | 前端 `contractVersion` vs `/meta` | 不匹配时前端拒绝渲染（不允许静默回退 mock） |
| 业务正向 | 每个域至少一条端到端（建单→流转→查询） | 状态与审计同时正确 |
| 业务拒绝 | 每个域至少一条拒绝路径（非法迁移/超版本/重复幂等键） | 返回契约规定的 code + reason |
| 前端冒烟 | `cd admin && corepack pnpm run test:e2e` | 6 例通过（需 `VITE_OPS_MOCK=true` 的桩项目或改指向真实 API 的契约回放项目） |

---

## 9. 交接时的现状快照（供你判断起点）

| 维度 | 状态 |
| --- | --- |
| 前端业务域 | **6 个已实现**：customer / catalog / contract / billing / entitlement+tenant / deployment+support |
| 前端质量门 | typecheck 0 错；单测 47 文件 / 321 用例；lint 0 错；e2e 6 例；生产构建通过且桩零泄漏 |
| 后端 ops 代码 | **0 行**（`apps/api/src/modules/` 无 ops，8 个迁移无 ops schema） |
| 契约冻结度 | 43 张表 / 112 个端点已定稿；本文件 §5 的缺口需你定夺后回写契约 |
| 前端联调方式 | 改一个环境变量，无需改代码 |

> ⚠️ **2026-10-30 后端实测更正**：「8 个迁移」是 `feat/ops-console`（`c6facfe`）的状态。后端实际开工分支 `feat/business-slice`（`0351bad`）已有 **13 个**迁移，比它多 24 个提交（多出 `soft_delete_visibility`、`order_write_grants`、`order_line_upsert`、`line_write_state_guard`、`finance_applications`）。迁移序号与「现有表」的假设请按 13 个重算。

---

## 10. 第一个 PR 建议范围

只做 **T-01 + T-02 + T-03 的登录与 `/meta`**，不碰业务域。理由：
- 这三项决定后面所有授权是否正确，返工代价最高；
- 前端登录、菜单、403/404 已就绪，做完即可验证「权限驱动呈现」是否真的成立；
- 可以在真实 API 上第一次跑通前端 e2e 的契约回放项目，把联调风险提前暴露。

---

## 11. 后端回执（2026-10-30，`feat/business-slice` @ `0351bad`）

### 11.1 结论

契约可用，架构判断成立：独立 `ops` schema + 独立身份表 + 「只判动作码不判角色名」，与我现有租户权限模型（`organization_role_permissions` + `has_permission()` + `current_data_scope()`）同构，不打架。§1–§8 的字段、错误体、分页白名单、金额精度、P1–P13 我都对着代码核过，与真实实现一致。

我接受 §10 的范围：**只做 T-01 + T-02 + T-03 的登录 / `/meta` / `/session`**，不碰业务域。但下面 **4 件事必须先由你处理**，否则我写完要返工，理由逐条附实测证据。

我的执行层计划在 `udone/Docs/superpowers/plans/2026-10-30-ops-backend-implementation.md`（4 项前置纠正 + Wave 1）。

### 11.2 你的 P0（不处理我只能空转）

**P0-1 把前端与契约入库**
- 现状：`git status --porcelain` = **90 项**（41 未跟踪 / 42 修改 / 7 删除），含 `admin/Docs/ops-api-contract.md`（1120 行真源）、`src/api/ops/**`（ops 下 38 个测试文件）、`views/ops/**`；远端只有 `main`，`feat/ops-console` 未推。
- 为什么阻塞：① 唯一真源只活在一个工作副本里，磁盘出事就没了；② 我要做联调必须 checkout 到那份前端，不提交我拿不到；③ §5 说「字段已冻结」——没进 git 的冻结等于没冻结。
- 要你做：提交并推到远端，然后告诉我分支名。

**P0-2 补契约里的认证三端点（最大缺口）**
- 现状：前端 `api/core/auth.ts` 调 `/auth/login|refresh|logout`，注释写「契约 §5.1 未列，沿用设计文档 §2.2」；契约全文 0 处提到 refresh。
- 为什么阻塞：T-03 就是「登录」。令牌形态、刷新轮换、失败锁定、`mfaRequired` 全无定义，我只能猜，猜错就是双向返工。
- 我的裁决（你无异议我就按此实现，并请你回写 §5.1）：

| 端点 | 请求 | 成功 | 关键错误 |
| --- | --- | --- | --- |
| `POST /auth/login` | `{email, password}`（无 Bearer） | 200 `{accessToken}` + `Set-Cookie: ops_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/ops/auth` | 401 `AUTH_REQUIRED`（不区分「邮箱不存在/密码错」）；403 `FORBIDDEN` + `reason=OPS_MEMBER_MISSING`/`OPS_MEMBER_INACTIVE` 且**不下发 cookie**；429 `RATE_LIMITED` |
| `POST /auth/refresh` | 无 body，读 cookie | 200 `{accessToken}` + 轮换后的 cookie | 401 `AUTH_REQUIRED` |
| `POST /auth/logout` | 无 body，读 cookie | 204，清 cookie | — |

补充约定：浏览器不持 anon key（符合 §7.2），GoTrue 由 Worker 代理；`SameSite=Strict` 只在同源成立，跨源必须 `None; Secure`，所以开发的正确姿势是同源代理。

**P0-3 `contractVersion` 要么阻断，要么改验收项**
- 现状：`api/ops/README.md` 写「前端暂不阻断不兼容版本（等后端给出真实版本号）」；但 §6 与 §8 把它写成「不匹配即拒绝渲染」的已验证拦截。
- 二选一：(a) 你实现阻断 + 升级提示页；(b) 我把 §8 验收项改成「`/meta` 返回真实版本号，前端记录但不阻断」。
- 建议 (a)：§2.1 已把「禁止静默回退 mock」写成决策，不做就等于留了静默回退的口子。

**P0-4 identity 写请求缺幂等键（现在不阻塞，做页面时会 400）**
- 现状：billing / contract / deployment / entitlement / support / tenant 六个域都有 `writeConfig(createIdempotencyKey())`；`identity/` 只有 `session.ts`，`/operators`、`/roles`、`/audit-events` 零客户端。
- 影响：§5.1 把邀请 / 改账号 / 建角色标成「幂等 必填」。你写账号管理页时必须带键，否则我按契约返回 400 `VALIDATION_ERROR`。

### 11.3 你的 P1（不阻塞开工，但要改口径）

- §9「6 个业务域已实现」建议改成「**8 个业务域已实现 + identity 仅会话层**」——否则读者以为 T-03 有现成消费者，实际只有 `/session`、`/meta`、`/permissions` 有客户端。
- §6 的联调开关是空操作（见该节更正框）：`VITE_OPS_MOCK` 两处都已是 `false`。你要确认的是 **dev 是否同源代理**，这决定 cookie 能不能落地。
- e2e 的 `stub/` 项目依赖 `VITE_OPS_MOCK=true`，与「提交前必须 false」冲突。建议放进 e2e 专用 env，不要改主 env。

### 11.4 我对 §5 开放问题的裁决（默认按此实现，反对请在 T-01 前说）

| 编号 | 问题 | 裁决 | 理由 |
| --- | --- | --- | --- |
| §5.2 | `SYNC_VERSION_CONFLICT` 归哪个 code | 用 `409 STATE_CONFLICT` + `details.reason='SYNC_VERSION_CONFLICT'`，并加进 §6.4 词表 | 一个 code 一套前端分支，区分交给 reason；你已双兼容，这条不逼你改代码 |
| §5.3 | 202 响应体两种写法 | 定稿 `{commandId, status, idempotencyKey}`（按 §2.4），把 §5.7 的 `command{…}` 视为笔误 | 与既有 `pagination`/错误体同一风格，少一层嵌套 |
| U-07a | `isOverdue` | 必补，服务端按 `settings.ticket.dueHours` + `Asia/Shanghai` 算 | 时钟/时区不一致会产生假告警，前端自算明确禁止 |
| U-07b | `createdFrom`/`createdTo` | 支持，按 `created_at` 闭开区间 | 列表页已有该筛选项，不做就要前端删控件 |
| U-07c | `unassigned=true` | 支持，等价 `assigneeOperatorId=null`，服务端翻成 `assignee_operator_id IS NULL` | 比让前端发 null 更明确 |
| U-08 | `assignableOperators` | `GET /tickets/{id}` 回带 | 售后角色没有 `operator.read`，不回带就没法分派 |
| U-09 | 终态原因落点 | 写 `metadata.reason`，`ticket_events` 不加列 | 时间线表只增不改，加列要动历史语义 |
| §5.3 | `quota` vs `quota_value` | 响应字段 `quota`，DB 列 `quota_value` | 列名内部可见，响应名已冻结 |
| §5.3 | `before/after_summary` 形状 | `{features:[{featureKey,enabled,quota,termMonths,displayName}], totalAmount?}` | 与权益快照列一致；你拿不到时降级原文 |
| U-04 | 变更申请 8 态 | 转正，按你列的 8 态实现 | 与 §3.5 状态机一致 |
| §5.3 | 租户命令 `cancel` 权限 | 按 `commandType` 映射到原动作码，不固定 `tenant.retry` | 否则「取消开通」会要求一个不相关的权限 |
| D-04 | 部署「最后上报时间」 | 用最近一条 `deployment_version_records.created_at`，不加心跳列 | 加心跳要有上报链路，当前没有 |
| D-07 | `rolled_back`/`failed` 是否回写 `currentVersion` | 只有 `succeeded` 推进，其余保持 | 与「失败不得装成成功」同一条原则 |
| D-05 | 维护期预警窗口 | 先按双方常量 30 天；要配置化等 `/meta` 加可选字段时一起做 | 加可选字段是加法兼容，不破坏你的类型 |
| §5.4 | 筛选参数 | 全部入白名单，未知参数忽略而不是 400 | 否则筛选一改就整片报错 |

### 11.5 我这边开工顺序

| 波次 | 内容 | 完成后你能看到什么 |
| --- | --- | --- |
| 0 | 幂等键命名空间、PostgREST 暴露 `ops`、契约双注册表、认证代理 | 无对外变化，但 T-01~T-03 不返工 |
| 1 | T-01 `/meta`、T-02 schema 与 RLS 函数、T-03 `/session` + 登录 | 前端可关桩对着真 API 跑通登录、菜单、403/404 |

前置纠正我**不等** P0-1 也能做（都在我自己仓库里）；但 T-03 的登录实现依赖 P0-2 的定义，P0-2 定稿前我只做 T-01/T-02。

### 11.6 一条我无法端到端验证的

邀请走 `auth.admin`（service_role）：我本地栈没有 GoTrue（Supabase Auth 是替身），「邀请 → `status='invited'` → 审计」只能单测替身。要真验需要 staging 的 Supabase 项目，否则这条在验收表里必须标「单测替身」，不能算已验证。

---

## 12. 前端回执（2026-10-30，`feat/ops-console` @ `2052c8a`）

### 12.1 你的 P0 处理结果

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| **P0-1** 入库并推远端 | ✅ 完成 | 分支 **`feat/ops-console`**，已推 `origin`（gitee），工作树干净。拆成 4 个提交：`chore(tooling)` 配置 / `docs(ops)` 契约与 journal / `feat(ops-console)` 主体 264 文件 / `docs(ops)` 格式修正，便于分别回滚。 |
| **P0-2** 认证三端点 | ✅ 完成 | 已并入契约 **§5.1 正式端点表**（此前只在本文件 §5.1 的缺口表里，契约正文 0 处提及）。**按你的裁决原样采纳**，另补两条约定：① 三个 `POST /auth/*` 豁免 `Authorization`，其余全部要求；② `SameSite=Strict` 只在同源成立，跨源必须 `None; Secure` + CORS 凭证，否则「登录成功但立刻 401」——这条我实测过，浏览器会静默丢 `Set-Cookie`。 |
| **P0-3** `contractVersion` | ✅ 采纳 (a) 实现阻断 | 规则写进契约 **§2.1.1**，实现 `api/ops/identity/contract-version.ts`。判定：MAJOR 不等或无法解析 → 阻断；MINOR/PATCH 不同 → 放行（契约加法演进）。**版本门在登录成功之后生效**，登录页不受阻断——否则运维看不到升级提示，只能看白屏。前端常量 `OPS_CONTRACT_VERSION = '1.0.0'`，**以契约 §2.1.1 为准**；你 T-01 定稿后若版本号不同，告诉我，我改常量。 |
| **P0-4** identity 幂等键 | ✅ 客户端已就位，页面待做 | `/operators`、`/roles`、`/audit-events` 客户端已落地（`api/ops/identity/{operators,roles,audit-events}.ts`）。**幂等键做成必填参数**：`inviteOperator(payload, idempotencyKey)`——忘记传在 typecheck 阶段就失败，不会走到你那里才变成 400。同一表单的提交与重试复用同一 key。管理页面属 Task 8，届时直接消费这些客户端，不会再改契约。 |

### 12.2 你的 P1 回应

- **P1-1（§9 口径）**：认可。但正文数字我想等 Task 8 完成后一次改对，避免改两次。本文件 §9 的「6 个业务域」现在是**过时数字**，实际是 **8 个业务域 + identity 仅会话层**，请以此为准。
- **P1-2（dev 同源代理）**：已确认，`vite.config.ts` 的 `/api` 代理指向 `http://localhost:5320/api`，dev 是同源。你那边端口若不同，改这一处即可，前端不需要别的配合。
- **P1-3（e2e 专用 env）**：**这条建议已经落地了**，不需要再改。`apps/web-antd/.env.e2e` 已存在且 `VITE_OPS_MOCK=true`，与 `.env.development`/`.env.production` 的 `false` 分离。

### 12.3 一处影响你本地跑测试的改动（请 rebase 后注意）

我修正了单测配置，**`admin/vitest.config.ts` 已删除**，配置移到 `apps/web-antd/vitest.config.ts`。

原因是那份文件从来没被加载过：vitest 从 cwd 逐级向上找配置，先命中 `vite.config.*` 就停，`apps/web-antd` 下有 `vite.config.ts`，所以上层那份永远读不到（实测把它的 `environment` 改成不存在的值，测试照样通过）。同时 vitest 4 已移除 `poolOptions`，写入会被静默忽略。

顺带解决了「用例全过但 exit 1」的假失败——真因是 fork worker 启动超时，**被跳过的整个测试文件不出现在失败列表里**，只是总数悄悄变小（漏过 7 个用例）。现在 48 文件 / 347 用例 / exit 0，连跑两轮一致，耗时从 83s 降到 27s。

如果你 checkout 后跑 `pnpm -F @vben/web-antd test:unit`，用的是新配置，不需要额外操作。

### 12.4 我这边当前的阻塞点

只剩一个：**等你 T-01/T-02 出 `/meta` 与 `/session`**，我就能关桩跑真登录。在那之前我没有可以推进的联调工作，Task 8 治理域要不要现在做，取决于你是否希望 `identity` 客户端先就位（做完你 P0-4 也一并解决）。

