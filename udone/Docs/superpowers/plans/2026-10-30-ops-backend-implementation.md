# 运营端（ops）后端实施计划（udone）

> **For agentic workers:** 按 Wave 顺序执行，一个任务一个提交；完成项必须附**当次实测**证据，不引用历史结论。
> **读者边界:** 本文件是**业务端执行层清单**。ops 的字段、端点、错误码、RLS 与任务书的唯一真源是运营端仓库的 `admin/Docs/ops-api-contract.md`，本文件不重定义任何契约。

**Goal:** 把运营后台从「对着桩跑」推进到「对着真 API 跑」。先交付能验证「权限驱动呈现」的最小闭环（登录 + `/meta` + `/session`），再按域推进；每个域完成即验收，不攒到最后。

## 真源关系

| 问题 | 去哪看 | 归属 |
|---|---|---|
| ops 字段 / 端点 / 错误码 / RLS / 任务书 T-01~T-14 | `admin/Docs/ops-api-contract.md` | 运营端 |
| 交接约定、缺口清单、前端已冻结的假设 | `admin/Docs/ops-backend-handoff.md` | 运营端 |
| 前端已冻结的请求/响应类型 | `admin/apps/web-antd/src/api/ops/*/types.ts` | 运营端 |
| 工程约束、测试分层、契约规范 | `.harness/ENGINEERING_STANDARDS.md`、`.harness/TESTING_STANDARDS.md`、`.harness/CONTRACTS.md` | 业务端 |
| 业务端（非 ops）未完成项 | `Docs/superpowers/plans/2026-10-29-business-completion-backlog.md` | 业务端 |

## 基线（2026-10-30 实测，`feat/business-slice` @ `0351bad`）

| 门禁 | 结果 |
|---|---|
| `format:check` / `format:sql:check` | 通过 |
| `lint` + CSS token | 通过 |
| `schema:check` | 与 13 个迁移一致 |
| `check:deploy` | 通过 |
| `typecheck` | 通过（仅 `tsc --noEmit`，`.vue` 未纳入，见 backlog A2） |
| `test` | 37 个文件 / 256 用例 |
| `build` | 通过（主 chunk 1,638.00 kB / gzip 506.52 kB） |
| `db:local:verify` | 重放 13 迁移，11 个 pgTAP 文件 **189 断言**全过 |
| `db:local:http` | 真实 PostgREST 16.5 + 原生 PostgreSQL，**15 条**集成用例全过 |

规模现状：13 迁移 / 31 个契约端点 / 6 个 API 模块。ops 侧目标是 **+43 张表 / +112 个端点**，约为现有后端的 3.6 倍。

**契约数字已逐项核对（不是引用报告）:** 43 张表、112 个端点、**39** 个权限动作码、9 个域（契约 §3.1~§3.9 = **8 个业务域 + identity-audit**）、前端 47 个测试文件、6 例 e2e —— 全部吻合。

> 两处口径纠正（2026-10-30 二次核对）：① 原写「6 个业务域」，按契约目录逐节数是 8 个，错在业务端；② 权限码是 **39**：逐行提取运营端 `constants/permissions.ts` 得 39 个码，与契约 §4 一一对应，此前看板写的「48 条动作码」无出处，已废。
> 差异裁决与执行顺序见 `2026-10-30-ops-alignment.md`（DIF-01~15、N1~N8）。

**与报告不符的一处:** 报告 §9 写「8 个迁移」。本分支是 **13 个**（多 `soft_delete_visibility`、`order_write_grants`、`order_line_upsert`、`line_write_state_guard`、`finance_applications`）。原因是报告按 `feat/ops-console`（`c6facfe`）写成，而本分支比它**多 24 个提交**。迁移序号与「现有表」的假设一律按 13 个重算。

## 风险（未闭合不进入 Wave 1）

| 编号 | 风险 | 影响 | 业务端的处理 | 阻塞谁 |
|---|---|---|---|---|
| R1 | 运营端 90 个路径未提交（含 1120 行契约真源、`src/api/ops/**`），远端只有 `main` | 真源随时可能丢；业务端无法 checkout 到前端做联调 | 已在交接文档列为他的 P0；业务端不动 `admin/**` | 运营端 |
| R2 | 认证三端点 `/auth/{login,refresh,logout}` 被前端调用，但契约 §5.1 完全没有 | T-03 的「登录」无令牌形态定义，写了要返工 | 业务端按其已实现的约定（内存 access token + HttpOnly cookie）补契约建议稿，见交接文档 §11 | 运营端确认 |
| R3 | `contractVersion` 前端**不**阻断（README 自承「等后端给真实版本号」） | 报告 §8「契约一致性」验收项当前是空断言 | 后端先如实返回版本号；阻断与否由前端决定，验收项据实改写 | 运营端 |
| R4 | 幂等键未按端点/用户命名空间，且只存 isolate 内存 | 同一 key 跨端点会**重放另一端点响应体**；跨用户可能拿到别人的响应；多实例下重复建单 | Wave 0.1 先修，再谈资金端点 | 业务端 |
| R5 | PostgREST 未暴露 `ops` schema，且 `rest-client` 无 profile 头 | 改 `config.toml` 一行不解决问题，ops 表在真实链路里读不到 | Wave 0.2 三处一起改 | 业务端 |
| R6 | 本地无 GoTrue（Supabase Auth 是替身） | 「邀请 → `status='invited'` → 审计」不能端到端跑 | 该条验收降级为单测替身，并在 journal 中显式标注，不当作已验证 | 业务端 + 运营端知悉 |

## 任务总览

| 波次 | 编号 | 内容 | 规模 | 依赖 |
|---|---|---|---|---|
| 0 | ~~0.1~~ | 幂等键命名空间 + `ops.idempotency_records` ✅ `3df4fe2` / `fe4e184` | S + M | 落库部分依赖 0.2 |
| 0 | ~~0.2~~ | PostgREST 暴露 `ops`（config.toml / local-db / rest-client 三处）✅ `9aba9ce` | S | — |
| 0 | ~~0.3~~ | 契约双注册表（`respond` / `RouteKey` / route-parity）✅ `36b2cc8` | S | — |
| 1 | **N1 = T-02a** | ops 身份基座：`operators`/`roles`/`permissions`/`role_permissions`/`operator_roles` + `current_operator_id()` / `has_permission()` / `get_current_ops_context()` / `write_audit()` + 39 码 seed | M | 0.2 |
| 1 | **N2 = T-01** | 契约包与路由骨架 + `GET /meta` | M | N1、0.3 |
| 1 | **N3 = 0.4** | 认证代理（GoTrue）+ 受控 CORS 凭证 + 测试签发通道 | M | N1 |
| 1 | **N4 = T-03a** | 运营身份读接口：`/session`、`/permissions` | S | N1、N2 |
| 1 | **N5** | 可关桩里程碑（login → /meta → /session → 403 全绿才通知运营端） | — | N2+N3+N4 |
| 1 | **N6 = T-03b** | 账号与角色管理：`/operators*`、`/roles*`、`/audit-events` + 邀请 RPC | L | N4 |
| 1.5 | **N7 = T-02b** | 幂等列形状收敛为 `PK(scope, key)`（非阻塞，可插空） | S | N1 |
| 2+ | T-04~T-14 | 按域推进（客户 → 产品 → 合同 → 应收 → 收款 → 权益 → 租户 → 部署 → 工单 → 报表 → 跨域回归） | L × 11 | 见契约 §8 依赖图 |

**执行顺序（2026-10-30 二次修正，固定不再议）:** 原表把 0.4 放在 T-01 之前、T-02 放在 T-01 之后，运营端又建议「/meta 与 0.4 并行、T-02 最后」，两种排法都不成立——**`/meta`（权限＝「已认证运营成员」）与 `login`（要返 `OPS_MEMBER_MISSING`/`INACTIVE` 且不下发 cookie）都要查 `ops.operators`**，表在 T-02 里。所以 N1 必须在最前，顺序为 N1 → N2 → N3 → N4 → N5 → N6。裁决依据见 `2026-10-30-ops-alignment.md` DIF-01。

Wave 1 只做到「前端登录、菜单、403/404 能对着真 API 跑通」，不碰业务域——理由与报告 §10 一致：这三项决定后面所有授权是否正确，返工代价最高。

**执行顺序修正（2026-10-30）:** 原表把 0.1 排在 0.2 前面，实际 **0.2 必须先做**。理由：0.1 的落库部分要写 `ops.idempotency_records`，而 `ops` 没被 PostgREST 暴露时那条写入在真实链路里就是 406；0.2 的验收（跨 schema 往返）又需要有表可读写。两项互相咬住，所以先建 schema 与表、再暴露、最后接 store。已按此顺序完成。

## Wave 0：前置纠正（业务端）

### 0.1 幂等：先修命名空间，再落库 — 已完成（`3df4fe2` + `fe4e184`）

- [x] 键改为 `sha256(authorization) : 组织 : method : path : key`
- [x] 新增 `ops.idempotency_records` 存储实现，含 `request_hash`

**现状证据:** `middleware/idempotency.ts` 直接拿原始 header 值查缓存；`lib/idempotency-store.ts` 是 isolate 内存 Map，注释自承「跨 Worker 实例不生效」。三个后果都是真的：同一 key 换个端点会重放另一端点响应体；两个用户撞同一 key 会把 A 的响应给 B；多实例下重放失效。

**做法:** 命名空间由（调用者, 组织, method, path, key）五段组成。落库部分按契约 §2.5：只存 2xx、带 `request_hash`，同 key 不同 hash 返回 409 `IDEMPOTENCY_CONFLICT`，命中时回 `Idempotent-Replay: true`。

**做法修正（`d585392`）:** 原计划用 `sha256(Authorization)` 当调用者分量，理由是「中间件跑在路由之前，此时还没鉴权，但头可读」。**这个理由只在一个没有令牌刷新的世界里成立**。运营端指出：W0.4 接上 GoTrue 后 access token 会过期并轮换，而幂等最该生效的场景正是「网关超时 → 客户端重试」，这段间隔完全可能跨过刷新点；哈希一变，重试落进新命名空间，收款就记两次。

改为从**验签后的 `sub`** 派生。中间件位置不变（仍在校验身份之前），所以它自己用 `SUPABASE_JWT_SECRET` 验一次 HS256 签名——一次 HMAC 远比把中间件挪到 `requireAuth` 之后（要改 31 个端点的挂载方式）便宜。三级退化都朝安全方向收敛：无令牌 → `anonymous`；验签失败 → 令牌哈希（仍在调用者之间隔离，只是自己刷新后会换格）；验签通过 → `user:<sub>`。

由此换来一条契约侧结论：**用 `sub` 而不是 operator_id**。operator 与 auth user 一一对应，而 `sub` 在中间件层面直接可得，不必为派生多做一次数据库查询。契约里写「调用者标识」即可。

**验收标准:** 单测覆盖三种碰撞（跨端点 / 跨用户 / 跨 request_hash）；`db:local:http` 增加一条「同 key 重放返回同体 + `Idempotent-Replay`」；31 个现有端点回归全绿。

**完成情况:** 三条碰撞各一条断言（单测 9 条 + 集成 4 条），两轮变异验证（key 退回原始 header 值 → 跨端点/跨用户红；去掉指纹比对 → 改 body 那条红；`set()` 变空操作 → 两条重放红）。集成测试还断言了「库里那条记录的 `scope_key` 必须等于中间件派生出来的值」，把派生算法与落库内容绑在一起。

**遗留（写进代码注释，未当作已解决）:** ① 不是预留式幂等——并发双请求可能都执行一遍再靠唯一约束决定谁留下；契约 §2.5 只定义了「命中即回放 / 不同指纹 409」，没有定义「执行中」的返回语义，**T-08 收款端点开工前必须定下这个语义**。② 过期行没有清理任务。

**列名已对齐契约（`d585392`，迁移 `20261030000002`）:** `status` → `response_status`、`body` → `response_body`、新增 `actor_id`（仅排障，不参与派生）。`scope_key` 保留单列不合契约原本的 `scope` + `key`，理由见上：契约那个 scope 示例不含调用者，按字面实现会让两个成员撞 key 时共享缓存槽。

**规模:** S（命名空间）+ M（表与存储）

### 0.2 PostgREST 暴露 `ops` schema — 已完成（`9aba9ce`）

- [x] `config.toml` 的 `[api] schemas` 加 `ops`
- [x] `scripts/db/local-db.mjs` 的 `db-schemas` 加 `ops`
- [x] `lib/rest-client.ts` 支持 `profile`（GET/HEAD/DELETE 发 `Accept-Profile`，写方法另发 `Content-Profile`；DELETE 两个都发，因为它先读后删）
- [x] 顺带修正：`rest()` 不再把「2xx 空 body」当成 JSON 解析失败（`Prefer: return=minimal` 是 201 + 空正文）

**现状证据:** `config.toml` 是 `["public","graphql_public"]`；本地 harness 硬编码 `db-schemas = "public"`；`rest-client.ts` 把路径固定拼成 `/rest/v1/`，没有任何 schema 选择能力。三处任缺一处，ops 表在真实链路里都读不到。

**验收标准:** 跨 schema 读写往返在 `db:local:http` 里跑通；现有 15 条集成用例 + 31 个端点全部回归通过（这是共用出口，改动必须带全量回归）。

**完成情况:** 新增 `tests/integration/ops-schema.test.ts` 4 条：service_role 经 profile 往返、不带 profile 时表不可见（404 `PGRST205`）、客户端令牌被拒（`42501 permission denied`）、`request_hash` 长度约束生效。变异验证：把 `ops` 从本地 `db-schemas` 拿掉，往返用例立刻报 `PGRST106 Invalid schema: ops`——正是这组配置存在的理由。`rest-client` 另加 5 条单测覆盖头映射（只发该发的、DELETE 发两个、service_role 双头一致）。

**规模:** S

### 0.3 契约双注册表 — 已完成（`36b2cc8`）

- [x] `RouteKey` 扩为合并视图 `keyof typeof ROUTE_ENTRIES`，`respond()` 按合并视图查 schema
- [x] `route-parity.test.ts` 改为并集对账，并新增前缀断言（`OPS_ROUTES` 必须是 `/api/v1/ops` 开头）

**做法修正:** 原计划写「`keyof A | keyof B`」，实现时改用 `{ ...ROUTES, ...OPS_ROUTES }` 的合并视图 `ROUTE_ENTRIES`。理由：`RouteResponse<K>` 需要对联合键取 schema，而 TS 不允许对联合类型的索引签名直接索引；合并视图让 `RouteResponse` / `RouteRequest` 的条件类型原样可用。代价是**同名 key 会静默覆盖**，所以对账里专门有一条同名断言——那是展开唯一掩盖不了的东西。

**现状证据:** `respond<K extends RouteKey>`，`RouteKey = keyof typeof ROUTES`；对账测试第二条断言「每条已注册路由都要在 `ROUTES` 里有契约」——直接挂 ops 路由会立刻变红。报告把这步算作「骨架」，实际要改共享基建。

**验收标准:** 故意删一条挂载 → 红；故意写错前缀（如 `/api/ops/meta`）→ 红；`OPS_ROUTES` 与 `ROUTES` 出现同名键 → 红。

**完成情况:** 对账逻辑抽成纯函数 `apps/api/src/contracts/parity.ts` + 6 条合成输入断言（未挂载 / 未登记 / 双表同名 / 前缀写错 / 不检查无前缀要求的表 / 全对时四数组为空）。理由：真实数据上「通过」与「函数恒返回空数组」无法区分，只有喂坏数据才能证明门禁有效。两轮真实变异：往 `OPS_ROUTES` 登记一条不挂载的 `/api/v1/ops/meta` → 点名 `GET /api/v1/ops/meta`；把路径改成 `/api/ops/meta` → 前缀规则变红。

**规模:** S

### 0.4 认证代理与受控凭证

- [x] `POST /api/v1/ops/auth/{login,refresh,logout}` 落进契约与实现
- [x] `cors.ts` 仅在配置了 `ALLOWED_ORIGINS` 时开 `credentials`，登录单独限流

**补勾证据（2026-11-18）:** 三端点在 `modules/ops/auth/routes.ts`（96/197/222 行）与
`packages/contracts/src/ops/auth.ts`；`cors.ts` 用 per-origin 判定后单独设
`Access-Control-Allow-Credentials: true`（未配置来源时不设置），登录失败 5 次返回
`ERROR_CODES.RATE_LIMITED` / 429（`auth/routes.ts:118`）。

**现状证据:** 前端 `api/core/auth.ts` 已在调这三个路径，并假定「access token 只驻内存、刷新令牌走 Set-Cookie」（`withCredentials: true`）；契约 §5.1 一条都没有。业务端 `cors.ts` 是 `credentials: false`，跨源时浏览器会丢弃 `Set-Cookie`。

**做法:** 浏览器不持 anon key（符合契约 §7.2），由 Worker 用 publishable key 代理 GoTrue：登录成功后再用该 token 调 `ops.get_current_ops_context()` 判成员；非运营成员或停用返回 403 + `details.reason`（`OPS_MEMBER_MISSING` / `OPS_MEMBER_INACTIVE`）且**不下发 cookie**。refresh 读 HttpOnly cookie 并轮换。开发期要求前端走同源代理，跨源必须显式配置来源白名单。

**验收标准:** 单测覆盖「非运营成员 → 403 且无 Set-Cookie」「无效/过期 token → 401」「停用成员 → 403 + `OPS_MEMBER_INACTIVE`」「登录连续失败 → 429」。

**规模:** M

## Wave 1：首批交付

### T-01 契约包与路由骨架

- [x] `packages/contracts/src/ops/{permissions,errors,routes,meta}.ts`
- [x] `apps/api/src/modules/ops/**` 与 `index.ts` 一行挂载
- [x] `GET /api/v1/ops/meta`：`contractVersion`、`serverTime`、`timezone`、`supportedSalesModes`、`supportedCurrencies`
- [x] 三个新错误码 `STATE_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`SYNC_TARGET_UNAVAILABLE` 已登记进共享契约

**补勾证据（2026-11-18）:** ops 契约在 `packages/contracts/src/ops/session.ts`（`OpsPermission`）、
`packages/contracts/src/routes.ts:742`（`OPS_ROUTES`）与 `ops/meta.ts`；`modules/ops/` 下 21 个域，
`index.ts` 已挂载。三个错误码都在 `packages/contracts/src/errors.ts`，`errors.test.ts` 快照同步。
`SYNC_TARGET_UNAVAILABLE` 按契约 §6.3 登记为 502 语义（`commandId` + `retryable`），
但当前没有任何端点同步下发租户命令，所以**它是「已登记、暂无产生端」**——
定时派发（`tenant-integration/dispatch.ts`）走后台 RPC 回写 failed/unknown，不返回 HTTP 502。
要让它真正出现，需要新增「同步执行并等待结果」端点，属另一个任务，不在 T-01 范围。

**做法要点:** `Permission` 保持租户专用联合，**不**把 ops 的 39 个动作码并进去——`customer.read`、`settings.manage`、`audit.read` 在两侧同名但存储不同（`organization_role_permissions` vs `ops.role_permissions`），共用一个类型等于给串号留口子。ops 用独立的 `OpsPermission`。

**验收标准:** 路由对账双向通过（含前缀断言）；`errors.test.ts` 快照按意图更新；`/meta` 在 `db:local:http` 下返回真实版本号。

**规模:** M

### T-02 `ops` schema 引导与 RLS 帮助函数

- [x] 迁移 `20261030000001_ops_schema_idempotency.sql`（原计划名 `..._ops_schema_bootstrap.sql`，实际落库名不同，内容等价）
- [x] `ops.current_operator_id()` / `has_permission(text)` / `get_current_ops_context()` / `write_audit(...)`
- [x] `ops.idempotency_records`（配合 0.1）

**补勾证据（2026-11-18）:** 迁移 `20261030000001_ops_schema_idempotency.sql:20` 建
`ops.idempotency_records`；四个函数在 `20261030000003_ops_identity.sql:142/154/176/248`。

**验收标准（pgTAP，全部真跑）:** P1 `anon` 无 schema USAGE；P2 租户成员查 `ops.customers` 为 0 行；P10 租户成员调 `public.get_current_auth_context()` 为 0 行；所有函数 `search_path = ''` 且未授予 `public`/`anon`。

**规模:** M

### T-03 运营身份与账号管理

- [x] 表：`operators`、`roles`、`permissions`、`role_permissions`、`operator_roles`、`audit_events`
- [x] RPC：邀请、改状态/角色、改角色权限（均 `SECURITY DEFINER` + 二次校验）
- [x] 端点：`/session`、`/permissions`、`/operators*`、`/roles*`、`/audit-events` + 0.4 的认证三端点

**补勾证据（2026-11-18）:** 表建在 `20261030000003_ops_identity.sql`；写 RPC 同文件并经历
`20261030000005/0006` 重载修正；端点登记在 `packages/contracts/src/routes.ts:771~824`。
邀请仍是单测替身（本地无 GoTrue），此项按原验收分层不算端到端验证。

**验收分层（必须分开写，不许混算）:**

| 层 | 手段 | 覆盖 |
|---|---|---|
| 表 / RLS / RPC | pgTAP | P4 / P5 / P7 / P13、`LAST_ROLE`、`LAST_ADMIN` |
| HTTP 端点 | `db:local:http` | P6（无敏感权限时响应里不存在 `phone`/`email` 键）、P11（租户管理员 403）、P12（无 token 401） |
| 邀请 | **单测替身** | 本地无 GoTrue，`auth.admin` 不可端到端验证——journal 必须写明这条是替身 |

**规模:** L

## Wave 2+：按域推进

顺序与依赖直接沿用契约 §8 的 T-04~T-14，不再重写。每个域一轮：迁移 → RPC → 端点 → pgTAP → 集成 → 提交。跨域拒绝与回归（T-14）在 T-13 之后一次性跑 P1~P13 全量。

## 门禁与提交规则

每个节点提交前按序执行，任一红即停：

```
pnpm format:check && pnpm format:sql:check && pnpm lint && pnpm typecheck \
  && pnpm test && pnpm schema:check && pnpm db:local:verify \
  && pnpm db:local:http && pnpm build && pnpm check:deploy
```

- 迁移**串行追加**，一个节点只加一个迁移文件，文件名接在 `20261029000008_finance_applications.sql` 之后。
- 一个节点一个提交，提交信息带任务号（如 `feat(udone): ops meta endpoint (T-01)`）。
- 提交前 `schema:generate`，`schema:check` 不一致不许提交。

## 与既有 backlog 的关系

| 项 | 处理 |
|---|---|
| A2 `vue-tsc` | **先做**（半小时量级），否则 ops 的 `.vue` 改动同样不进类型门禁 |
| A1 前端主线 E2E / D2 接 CI | 顺延，与 ops 争用 Playwright 时间 |
| B1 / B2 / C1~C12 | 与 ops 无交集，继续挂起 |
| D1 chunk 拆分 | 与 ops 无关，但 ops 上线会再抬体积，届时一起做 |

## 明确排除

- 不改 `admin/**`（前端归运营端），只在 `apps/api/src/index.ts` 加挂载行。
- 不写 `public.*` 业务表；ops 响应不返回租户明细。
- 不为 ops 另立错误体；不让前端算 `isOverdue`；失败不返回 200。
- 不把 ops 表放 `public` schema。
- 不做 MFA、不做定时任务（契约里有字段，但实现排在 Wave 2 之后）。
