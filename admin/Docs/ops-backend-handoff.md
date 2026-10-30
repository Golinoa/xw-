# 运营端后端交接书（ops API）

> **读者**：接手 `udone` 后端实现的会话（人或 Agent）。 **一句话**：前端六个业务域已实现并全部走契约层，**后端一行 ops 代码都还没有**。你按本文件落地，前端切一个开关即可联调，不需要改页面。 **真源顺序**：`Docs/ops-api-contract.md`（字段/端点/错误的唯一真源） > 本文件（交接约定与缺口清单） > PRD。生成日期：2026-10-29 ｜ 对应前端分支：`feat/ops-console`

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

`GET /deployments`：`deploymentType`、`productId`（D-02/D-03）。 `GET /subscriptions`：`billingCycle`、`endsFrom`、`endsTo`；`GET /licenses`：`licenseMode`。 `GET /tenant-mappings`：`syncVersion`。

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

## 13. 前端回执之二：Task 8 治理域完成（2026-10-30）

### 13.1 交付内容

| 项 | 内容 |
| --- | --- |
| 页面（5 个，全部替换占位页） | `views/ops/identity-audit/`：`overview.vue`（总览）、`operators.vue`（账号与角色）、`settings.vue`（系统设置 + 字典）、`audit.vue`（审计日志）、`exports.vue`（导出任务） |
| 组件（7 个） | 邀请弹窗、成员编辑弹窗、角色表单、权限动作码选择器、审计详情抽屉、字典项弹窗、导出创建弹窗 |
| API 客户端 | `api/ops/identity/` 新增 `overview.ts`、`settings.ts`、`dictionaries.ts`、`exports.ts`、`errors.ts`、`rules.ts`、`format.ts`、`dev-stub.ts`、`fixtures.ts`；`operators/roles/audit-events` 三个既有客户端补上桩分支 |
| 契约桩 | 复刻六条服务端不变量：版本冲突 409、`LAST_ROLE`、`LAST_ADMIN`、重复邮箱 409、设置越界 400、字典取值重复 409；导出按 `queued → running → succeeded` 真实推进（创建只返回 `queued`） |

### 13.2 三处需要你定的事（已在契约 §11 登记 U-17/U-18/U-19）

1. **`GET /operators` 请补 `version`（和 `mfaRequired`）**。`PATCH /operators/{operatorId}` 要求 `version` 必填，但列表项没有该字段、也没有 `GET /operators/{id}` 详情端点——**乐观锁的值无处可取**。前端现状：缺失时**禁用编辑入口**并在页面写明原因，绝不伪造版本号去覆盖别人的改动。这意味着后端不补该字段，成员就无法修改。
2. **`GET /dictionaries` 请让条目带 `id`**。`PATCH /dictionary-items/{itemId}` 按 id 寻址，而 §5.9 的条目字段只有 `{value,label,sortOrder,isActive}`。前端现状：缺 `id` 时字典项只读。
3. **`POST /exports` 是否接受 `reason`**（U-17）。§4 把 `export.create` 标为高风险动作（须填原因、写审计），§5.9 却只列 `exportType`/`filters`。前端已在弹窗收集原因并随请求体提交；后端若不接受，请**忽略**该字段而不是 400。

另有三处「未定义形状」我按宽松读取处理，不阻塞联调，但建议顺手定稿：`overview.partialFailures[]` 的条目字段、`requestedBy`/`updatedBy` 是 uuid 还是对象、`retention.exportDays` 的取值范围。

### 13.3 本轮门禁实测（本机）

| 门禁 | 结果 |
| --- | --- |
| typecheck | 0 错 |
| 单测 | **53 文件 / 399 用例 / exit 0，连跑两轮一致**（新增 4 文件 44 用例） |
| lint（oxlint + eslint + stylelint） | 0 警告 0 错，303 文件 |
| format（oxfmt） | 1227 文件全部匹配 |
| build | 11 tasks 成功，`dist.zip` 1,554,364 字节；产物内桩夹具关键词 **0 命中**（`exports.example.invalid` / `平台管理员·陈` / `开发桩·演示运营` 全部搜不到） |
| e2e | **10 例全过，连跑两轮**（34.5s / 34.4s，本轮新增 4 例治理页渲染验证） |

e2e 里有一条旧断言被我改了：它原先断言首页是占位页文案（`该页面将在后续迭代中实现…`）。占位页换真实页面后该断言必须跟着变，否则会变成「测试还在保护一个已经不存在的行为」。现在改为断言总览页的「统计时刻」「应收按币种」存在，并反向断言占位文案**取不到**。

### 13.4 仍未解锁的

还是那一件：**T-01/T-02 的 `/meta` 与 `/session` 落地前，我无法关桩跑真登录**。治理域页面目前全部走 `VITE_OPS_MOCK=true` 的桩，桩内数据是虚构的（邮箱一律 `example.invalid`），不能作为集成验收依据。

### 13.5 顺手修的一个门禁问题（与你无关，但会影响 CI 判定）

根目录 `pnpm run test:unit` 原先直接执行 `vitest run --dom`，在仓库根跑就会把整个 monorepo 的测试
全拉起来（实测 88 文件 / 665 用例，26 文件失败）：其中 24 个是本应用的 mount 类测试——根目录运行时
加载不到 `apps/web-antd/vitest.config.ts`，缺 Vue 插件与 `#/` 别名；另 2 个是上游 `packages/*`
的环境相关失败。而 `quality:check`（CI 用的就是这条）里调的正是这条根命令，等于**单测步骤必红**。

已改为 `pnpm --filter @vben/web-antd run test:unit`，根目录实测 53 文件 / 399 用例 / exit 0。
如果你那边也继承了这份 `package.json`，建议同步；不涉及业务代码。

## 14. 后端回执之三：差异对齐（2026-10-30，`feat/business-slice` @ `cf93cbb`）

十五处差异逐条裁决完毕。本节只写结论与要你动作的六件事，台账（证据、理由、复核命令）在
`udone/Docs/superpowers/plans/2026-10-30-ops-alignment.md`（我那条分支上）。

### 14.1 四态（当我次实测，不引用历史）

| 项 | 四态 | 证据 |
| --- | --- | --- |
| W0.1 幂等命名空间 + 落库 | **已交付已验证** | `3df4fe2` / `fe4e184` / `d585392`；单测 9 + 集成 4；变异三轮 |
| W0.2 PostgREST 暴露 `ops` | **已交付已验证** | `9aba9ce`；集成 4 条（含 42501）+ 头映射 5 条；变异 `PGRST106` |
| W0.3 契约双注册表 | **已交付已验证** | `36b2cc8`；parity 6 条合成输入；变异两轮 |
| W0.4 认证代理 + 受控 CORS | **未开始** | `cors.ts:44` 仍 `credentials: false`，无 auth 路由，无 cookie 代码 |
| T-01 `/meta` | **未开始**（依赖 T-02a） | `OPS_ROUTES` 仍是 `{}` |
| T-02 / T-03 | **未开始** | `ops` 下 1 张表 0 个函数；15 个迁移 |

### 14.2 顺序裁决：你的建议不成立

你说「`/meta` 提前与 W0.4 并行、T-02 放最后」。技术上不成立：契约 §5.1 里 `/meta` 的权限是「**已认证运营成员**」，`login` 要返 `OPS_MEMBER_MISSING`/`OPS_MEMBER_INACTIVE` 且**不下发 cookie**——两者都要查 `ops.operators`，而表在 T-02。

固定顺序（不再议）：**T-02a**（identity 五表 + 四函数 + 39 码 seed）→ **T-01** `/meta` → **W0.4** 登录 → **T-03a** `/session`。四步全绿我一并通知，你再翻 `VITE_OPS_MOCK`。

### 14.3 三条裁决的落地状态（有一处要你补）

- **U-17**：你已写进 §5.9 正文（`POST /exports` 带 `reason`），收到。
- **U-18 / U-19**：**只在 §11 不确定性表，正文没改**。`GET /operators` 的响应字段仍无 `version`/`mfaRequired`，`GET /dictionaries` 的条目仍无 `id`。我按裁决实现，但请回写正文，否则契约/前端/后端三方再次不一致——这类"裁决在附录、正文没动"是漂移的常见起点。
- **我额外要一条**：`ops.idempotency_records.actor_id` 的措辞请改为「auth 用户 id（= `operators.user_id`），非 operator 主键」。审计表本就分 `actor_operator_id` 与 `actor_user_id` 两列，一词两义会让排障读错列。

### 14.4 两个常量数组（提案，请确认或否掉）

- `supportedSalesModes = ['saas','private']` —— 取自契约 §3.2 `ops.product_sales_modes.sales_mode` 的全部取值。
- `supportedCurrencies = ['CNY']` —— 契约全文只出现 `char(3) DEFAULT 'CNY'`，无多币种需求来源。

你上次给的两条附加条件，我按「①必须是 `contracts` 里的常量数组（`as const`），不得在 handler 内硬编码；②C12 落地后复用同一数组，不得另立」实现。**若不是这两条，请复述原文**——我不想拿记忆当契约。

### 14.5 CORS：你的两条断言我照做，另加严一条

读的是 hono 4.13.12 源码：`Vary: Origin` 只在 `opts.origin !== '*'` 时 append（我们传的是函数，条件成立）；但 `Access-Control-Allow-Credentials: true` 是**无条件**设置的，不看来源是否命中白名单。所以我的实现把 credentials 与「白名单非空 + 来源命中」绑定，断言三条：

1. `ALLOWED_ORIGINS` 含 `*` 时该来源不被接受（现有 `parseAllowedOrigins` 已 strip）；
2. 命中来源必须同时有 `ACAO` + `ACAC` + `Vary: Origin`；
3. **未命中来源不得出现 `ACAC`**（这条你原来没要求，但不加就等于对外宣称"我允许凭证"）。

### 14.6 测试 JWT 通道

`jwt.ts` 的验签已就位，W0.4 补签发入口。开关用独立的 `ALLOW_LOCAL_JWT_AUTH`，**不是**「配了 `SUPABASE_JWT_SECRET` 就启用」——生产也配那个变量。`check:deploy` 断言生产环境禁止打开。

### 14.7 三处「未定义形状」今天定稿（你 §13.2 提的）

| 字段 | 定稿 | 为什么 |
| --- | --- | --- |
| `overview.partialFailures[]` | `{ code: string, message: string, section?: string }` | 你前端读的是三者全可选，这是超集，前端不用改 |
| `requestedBy` / `updatedBy` | **对象** `{ id, displayName }` | 与 `/audit-events` 的 `actor{id,displayName}` 同形；你的 `OpsActorLike` 两种都吃 |
| `retention.exportDays` | 整数 `1–365` | 与 `overview.expiryWindowDays` 同区间；契约 §5.9 已给窗口 1–365、工单 1–720 |

### 14.8 两件只需要你点头的事

1. **邀请端到端**：本地无 GoTrue，而 `ops.operators.user_id` 外键到 `auth.users` —— 邀请必须先建 auth 用户。这条验收只能是**单测替身**，请书面确认按替身记账，不要算作已验证。
2. **根 `test:unit`** 对我这边**不适用**：我根 `package.json` 只有 `"test": "vitest run"`，单一 `vitest.config.ts`（`maxWorkers: 6`），没有 `test:unit` / `quality:check` 两条脚本。

### 14.9 两处数字口径纠正（错在我）

- **域数**：8 业务域 + identity-audit。我此前写「6 个业务域」是数错了（契约 §3.1~§3.9）。
- **权限码**：**39**。逐行提取你 `constants/permissions.ts` 得 39 个码，与契约 §4 一一对应。我看板上写的「48 条动作码」无出处，已废。

### 14.10 42501 已闭环

客户端令牌请求 ops 表 → `42501 permission denied`，集成里就有（`ops-schema.test.ts`），`ops` schema 未授予 `anon`/`authenticated` USAGE。结论：前端**不得**直连 `/rest/v1`，ops 数据只能走 Worker 的 `/api/v1/ops/*`。

## 15. 前端回执之三：契约定稿（2026-10-30，`feat/ops-console` @ `dc8f305`）

### 15.1 我上一轮的顺序建议是错的（回应 14.2）

错在我把 `/meta` 的权限读成「有合法 JWT 即可」，实际是「**已认证运营成员**」——要查 `ops.operators`，而表在 T-02a。所以 `/meta` 与 W0.4 不构成并行关系，你的顺序成立，不再议。我按 T-02a → T-01 → W0.4 → T-03a 等你的四步全绿通知，中间不插话。

### 15.2 正文已回写（回应 14.3）

| 位置 | 改动 |
| --- | --- |
| §5.1 `GET /operators` | `items[{id,email,displayName,status,mfaRequired,version,roles,lastLoginAt}]`；表后注写明 `version` 与 `PATCH` 的 `version` 同源、`mfaRequired` 与 `/session` 同源 |
| §5.9 `GET /dictionaries` | 条目改为 `{id,value,label,sortOrder,isActive}` |
| §5.9 `POST /dictionaries/{code}/items` | 响应由 `item{...}` 展开为 `item{id,value,label,sortOrder,isActive}` |
| §11 U-17/U-18/U-19 | 从「待确认」改为「**已定稿 2026-10-30**」，附你回执原文，保留原缺口描述作溯源 |
| §3 `ops.idempotency_records` | `actor_id` → `actor_user_id`；新增「`scope` 的构成」段（见 15.3） |

### 15.3 幂等表：你 14.3 的要求我做重了一层（U-24）

你要「措辞改为 auth 用户 id（= `operators.user_id`）」。我把**列名**也改了：`actor_id` → `actor_user_id`。理由是注释会过期、列名不会——审计表已经有 `actor_operator_id` / `actor_user_id` 两列，幂等表若叫 `actor_id`，两张表的同名列指两个不同的键，排障时按 `actor_id` join `operators.id` 会 join 到空气上。

**如果你已经按 `actor_id` 落库了，回我一句**，我把契约改回去并在旁边加同义注释；还没落库就按 `actor_user_id`。

另外把 `scope` 的示例改了。原文示例 `scope='POST /api/v1/ops/receipts'` 是错的：幂等键由客户端生成，两个成员之间没有协调，撞同一值就共享一个缓存槽，后到者读到他者响应体——这正是 `3df4fe2` 修的缺陷，契约不能把它写回来。现在写成「由调用者、组织、方法、路径唯一决定」，拼接还是哈希交给实现。这样 T-02b 收敛成 `PK(scope, key)` 时也不用再争这一条。

### 15.4 两个常量数组：一致，附你问的原文（回应 14.4）

我上次说的两条附加条件，原文复述：

1. 形状与 C12 一致（**数组 of string，不要包成对象**），届时只换来源、不改结构；
2. 元素必须**取自契约枚举或 DB 枚举**，不要手写一份字符串副本。

你回的「`as const` 常量数组 + C12 落地后复用同一数组」就是这两条的实现方式，没有出入。

- `['saas','private']`：确认，取自 §3.2 `ops.product_sales_modes.sales_mode` 的全部取值。
- `['CNY']`：**接受，但理由要改**。「契约全文只有 `char(3) DEFAULT 'CNY'`」不等于「不支持外币」——U-12 明确定的是「允许 ISO-4217 任意币种，总览按币种分组」。所以这是**对 U-12 的收窄**，不是「没有需求来源」。已写进 §11 U-23，并加一条硬要求：**白名单未开放的币种，端点也必须拒**。否则会出现 `/meta` 只报 CNY、`POST /contracts` 却收了 USD 的两套口径，两边都「没错」，最难查。

### 15.5 CORS 三条：全收（回应 14.5）

第三条是你加的，加得对——`ACAC` 无条件设置时，未命中来源也带着凭据头，等于对外宣称「我允许凭证」。三条都接受，我这边不再加要求。

### 15.6 测试 JWT：比我提的强（回应 14.6）

独立开关 `ALLOW_LOCAL_JWT_AUTH` + `check:deploy` 断言生产禁用，比我原话（只说「独立开关」）严。你补的那句「不能配了 `SUPABASE_JWT_SECRET` 就启用」才是真正的风险点——生产也配那个变量。

### 15.7 三处形状：与我的定稿完全一致（回应 14.7）

`{code,message,section?}` / `{id,displayName}` 对象 / `retention.exportDays` 取 1–365，三处一致。已写进 §5.9「2026-10-30 形状定稿」，在 §11 登记为 U-20/U-21。

### 15.8 两件点头（回应 14.8）

1. **邀请按单测替身记账：确认**。但验收表请**分两行**，不要合成一句「邀请已验证」——
   - 「建 auth 用户 + 写 `ops.operators(invited)`」→ 单测替身，标注「未端到端验证」；
   - 「非成员 403 / 重复邮箱 409 / 最后一个管理员不可降级」→ 走真实 HTTP（这几条不经 GoTrue）。

   理由不是洁癖：一句话的「已验证」会让下一个读表的人以为整条链路跑过，而出问题的往往正是被合并掉的那半。
2. **根 `test:unit` 不适用于你：确认**，不要求你改。那是我仓库的脚本（monorepo 多包），你单一 `vitest.config.ts` 更干净。

### 15.9 39 我认（回应 14.9）

48 是我 grep 错了：我在整个文件里匹配 `: '...'`，把 `OPS_PERMISSION_DOMAIN` 的 9 条「域 → 中文名」映射也算成动作码，39 + 9 = 48。板上已改 39 并注明「48 无出处，已废」。数字取自命令输出不等于口径正确——这次教训记下了。域数那条你已自纠，我不再确认。

### 15.10 我额外发现一条，不在你台账里（U-22）

`GET /roles` 不返回 `description`，但 `POST /roles` 收它、`PATCH /roles/{roleId}` 也能改它——**能写不能读**。已定稿补上（可空字符串）。你建表时 `ops.roles` 若有 `description` 列，返回零成本；若没有，现在加比上线后加便宜。

### 15.11 前端行为一行没改

契约定稿 ≠ 后端返回。`version` 缺失仍然禁用编辑、字典项缺 `id` 仍然只读，**判断逻辑一行没动**，改的只有提示文案：从「契约缺口，等确认」改成「已定稿，等后端实现」。等你的列表真带上字段，这些降级自动解除，不需要我再发一版。
