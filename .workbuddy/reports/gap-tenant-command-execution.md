# 租户命令执行侧缺口定位

> 结论先行：台账（表/RPC/端点/前端）已完整，**执行侧（谁去发、发了怎么记、超时怎么办）为 0**。
> `record_tenant_command_attempt` 是唯一能推进终态的函数，全仓**生产代码零调用方**（仅测试调用）。
> 命令从「创建」到「完成」的实际路径：创建 → 停在 `pending` → 永不结束。

## 1. 现状：四层拆解

### 1.1 表（`udone/supabase/migrations/20261031000007_ops_tenant_integration_domain.sql`）

| 表 | 关键列 | 状态/约束 | 行号 |
|---|---|---|---|
| `ops.tenant_mappings` | `udone_organization_id`（可空）、`mapping_status`、`last_known_state`、`last_synced_at`、`sync_version`、`version` | `pending/active/suspended/terminated`；org id 唯一（NULL 不冲突） | :69-102 |
| `ops.tenant_commands` | `idempotency_key`(UNIQUE)、`command_type`(8 种)、`status`、`attempt_count`、`last_error_code/category`、`request_summary`、`response_summary`、`request_id`、`next_retry_at`、`expected_sync_version`、`completed_at`、`version` | `pending/retrying/succeeded/failed/cancelled`；终态 ⟺ `completed_at` 非空；`permanent` 禁进 `retrying` | :111-185 |
| `ops.tenant_command_attempts` | `attempt_no`、`started_at`、`finished_at`、`outcome`、`http_status`、`error_category`、`request_id`、`response_summary` | `succeeded/failed/timeout`；`UNIQUE(command_id,attempt_no)`；UPDATE/DELETE 触发器直接 raise（:234-245） | :199-226 |

三张表都没有 RLS 策略（只 `ENABLE` 不给 policy，:1341-1347），访问完全走 SECURITY DEFINER RPC + 表级 REVOKE（:1332）。

### 1.2 RPC（22 个函数，业务相关的 6 个）

| RPC | 作用 | 谁能调 | 行号 |
|---|---|---|---|
| `ops.create_tenant_command` | 幂等建命令，落 `pending`，`request_summary ← p_payload` | `authenticated`+`service_role` | :610-790 |
| `ops.transition_tenant_command` | 只允许 `pending→cancel`、`failed→retry` | 同上 | :794-894 |
| `ops.record_tenant_command_attempt` | **唯一**能把命令推进 `succeeded/failed` 的函数，同时改 mapping 与 `sync_version+1` | **仅 `service_role`**（:1561 REVOKE，:1577 GRANT） | :900-1115 |
| `ops.allowed_command_actions` | `pending→[cancel]`、`failed→[retry]`、其余 `[]` | 内部 | :252-260 |
| `ops.tenant_retry_backoff` | `2^attempt` 分钟，封顶 60 | 内部 | :283-287 |
| `ops.get_tenant_command` | 出站含 `retryable = failed && category<>permanent`（**不看** `next_retry_at`） | `authenticated` | :1266-1296 |

### 1.3 端点（`udone/apps/api/src/modules/ops/tenant-integration/routes.ts`，10 个）

`GET/POST /tenant-mappings`、`GET/PATCH /tenant-mappings/:id`、`POST /tenant-mappings/:id/commands`（202，:403-443）、`GET /tenant-commands`、`/tenant-commands/:id`、`/attempts`、`POST .../retry`（202）、`POST .../cancel`。
handler 只做三件事：鉴权（按 `commandType` 映射权限 :187-196）、校验 `Idempotency-Key` 头存在（:124-133，**只查存在，不做重放**）、转发 RPC。**没有任何端点能写入执行结果**。

### 1.4 谁来消费

| 可能的消费方 | 实际 | 证据 |
|---|---|---|
| Worker 定时器 / cron | 不存在 | `wrangler.toml` 无 `[triggers]`；`apps/api/src/index.ts:99` 只 `export default app`，无 `scheduled` |
| 队列消费者 | 不存在 | 全仓无 `queues`/`consumers` 配置 |
| 独立下发服务/脚本 | 不存在 | `udone/scripts/` 无 tenant 相关；全仓 `record_tenant_command_attempt` 命中仅测试 |
| 运营前端 | 只读 + retry/cancel | `admin/.../views/ops/tenant-integration/`；`commands.vue:89` 渲染「下次重试」列，但**没有任何东西会去重试** |
| 租户侧接收端 | 不存在 | 本仓库对外的组织创建是用户令牌（`routes/organizations.ts:29-43`），无机器对机器鉴权（无 API Key/HMAC） |
| 计划本身 | 明确不做 | `Docs/superpowers/plans/2026-10-29-p0-architecture-hardening.md:23`「不做 cron 定时任务」 |

**一条命令的真实生命周期**：`POST /commands` → RPC 落 `pending` → 202 返回 → **结束**。`next_retry_at`/`attempt_count`/`retryable` 全是死字段，`failed` 永远不会出现（除非有人手工用 service_role 调 record）。

## 2. 缺口清单

| # | 缺口 | 依据 |
|---|---|---|
| G1 | **无执行器**：没有任何进程/定时器把 `pending` 捞出来发出去 | `wrangler.toml` 无 triggers；`index.ts:99`；全仓 record 无生产调用方 |
| G2 | **无租约/认领**：没有 `claimed_at/claimed_by/lease_expires_at`，两个 worker 会同时拿到同一条 | `tenant_commands` 全列见 :111-185，无此类列 |
| G3 | **无 fencing**：`record` 不校验调用方是不是当前认领者，僵尸 worker 可以在租约过期后写入 | :900-1115 只做终态判断与 mapping 校验 |
| G4 | **无超时回收**：`timeout` outcome 只能由执行器自己上报；执行器崩了命令永久 `pending` | :1065-1079 是唯一 `timeout` 分支，只能被 record 触发 |
| G5 | **无自动重试**：`failed` 只能人工 `retry`，`next_retry_at` 写入后全仓无人读 | :1058-1061 / :1075 写入；全仓 grep 无 SELECT 使用（仅 :194 索引空转） |
| G6 | **无重试上限/死信**：attempt 无限增长，无 `max_attempts`、无 dead-letter 状态 | :1047-1064 无上限判断 |
| G7 | **backoff 会溢出**：`power(2,n)::integer` 在 `attempt_no≥31` 抛 22003，record 直接失败（推断，未实测） | :286 |
| G8 | **无远端幂等键**：命令只带本地 `command_no`，`request_summary` 里没有随请求下发的幂等标识；`provision` 本身非幂等 | :760-763；migration 头注释 :40「`provision` 不是幂等的」 |
| G9 | **同一 mapping 可并存多条 pending `provision`**：只校验 org id 是否已绑，不校验是否已有未终结命令 | :712-718 |
| G10 | **取消/下发竞态**：`cancel` 只看 `attempt_count=0`，而 attempt 只在**结束时**才写（:1009），在途命令可被取消 → 远端建成孤儿租户 | :862-867 + :1007-1017 |
| G11 | **版本不复核**：`record` 从不比较 `expected_sync_version` 与当前 `sync_version`，乱序成功会把 mapping 改回旧状态 | :900-1115 内无 `expected_sync_version` 引用 |
| G12 | **状态机缺「在途」分支**：`pending` 同时表示「排队中」与「正在发」，无法区分也无法设租约 | :252-260 `allowed_command_actions` |
| G13 | **attempt 时长恒为 0**：`started_at` 与 `finished_at` 都写 `now()`，且表不可 UPDATE，无法记录真实起止 | :1014 |
| G14 | **租户侧接收端缺失**：契约 §3.6 说「由 udone 内部接口确认」，该接口不存在 | `admin/Docs/ops-api-contract.md:159`；全仓无 internal 端点 |
| G15 | **远端契约未定义**：请求字段名未知，`protocol.ts:17-18` 明说「远端契约不在本仓库」 | `protocol.ts:17-18` |

## 3. 最小可行补法

分两刀，**M0 可本地全量验证，M1 必须 staging**。

### M0：执行机构（一个迁移 + 一个 worker 入口）

**新增列（`ops.tenant_commands`）**：`claimed_at`、`claimed_by text`、`lease_expires_at`、`max_attempts int default 8`、`remote_idempotency_key text`。
**状态机加一条**：`pending → dispatching → (succeeded | failed | pending[timeout])`；`dispatching` 下 `allowed_command_actions = []`（不可取消），`record` 允许从 `dispatching` 推进。
**部分唯一索引**（治 G9）：`unique (mapping_id, command_type) where status in ('pending','dispatching','retrying')`。

**三个新函数（均只授 `service_role`）**：

| 函数 | 语义 |
|---|---|
| `ops.claim_tenant_commands(p_worker text, p_limit int, p_lease interval)` | `update ... where id in (select ... where status in ('pending','retrying') and (next_retry_at is null or next_retry_at<=now()) and (lease_expires_at is null or lease_expires_at<now()) order by next_retry_at nulls first, created_at limit n for update skip locked) returning`；置 `status='dispatching'`、`claimed_by`、`lease_expires_at` |
| `ops.complete_tenant_command(p_command_id, p_worker, ...)` | 先校验 `claimed_by=p_worker and status='dispatching'`（治 G3），再复核 `expected_sync_version = mapping.sync_version`（治 G11：不等则落 `failed/conflict` 且**不动 mapping**），最后内部转调 `record_tenant_command_attempt` |
| `ops.reap_tenant_commands(p_lease_grace interval, p_max_attempts int)` | 扫 `dispatching and lease_expires_at < now()-grace`：写一条 `outcome='timeout'` attempt、置回 `pending` + `next_retry_at`；`attempt_count >= max_attempts` 时落 `failed/permanent`（治 G4/G6） |

**触发方**：同 Worker 加 `export const scheduled` + `wrangler.toml` 的 `[triggers] crons = ["* * * * *"]`（1 分钟粒度，Cloudflare 最小单位）。`scheduled` 用 `createServiceRestClient`（已有，`lib/rest-client.ts:227`）调 claim；对每条命令 `fetch` 远端，带 `Idempotency-Key: <command_no>`（治 G8），HTTP 超时用 `AbortSignal.timeout`，再调 `complete_tenant_command`。**不要**在 handler 里调 claim（否则把运营请求变成下发请求）。

**下发前的顺序约束**：先 claim（写库提交）再发 HTTP，禁止一个事务里跨 HTTP。`attempt` 仍在结束时写（保持不可变表性质），在途性由 `dispatching`+租约表达。

### M1：租户侧接收端

新增机器对机器端点（新 secret `INTERNAL_TOKEN` + `X-Internal-Token` 常量时间比较，**不要**复用 operator JWT）。最小覆盖 4 个动作：`provision`（建 org + owner）、`activate`、`suspend`/`resume`（改 org 状态）、`sync_entitlement`（写权益快照）。`bind`/`extend` 语义未确认，先返回 `unsupported` 让命令落 `permanent`（宁可不做，不要猜）。
**幂等**：接收端对 `Idempotency-Key` 建表去重，重复请求返回首次结果（这是防双租户的唯一可靠手段）。

## 4. 风险与边界

| 风险 | 后果 | 必须先有 |
|---|---|---|
| `provision` 超时后重发（G4+G8） | **双租户**：远端建了两个 org，本地只认一个 | 远端幂等键 + 「超时先查远端」那次查询（migration 头注释 :36-40 已明确要求） |
| 双 pending provision（G9） | 运营双击 / 两人同时点开，两次下发 | 部分唯一索引，纯本地可验 |
| cancel 与在途竞态（G10） | 本地 `cancelled`、远端已开通 → 孤儿租户、账单缺口 | `dispatching` 状态禁 cancel |
| 僵尸 worker 回写（G3） | 租约过期后旧结果覆盖新结果，mapping 状态跳变 | `claimed_by` 校验 |
| 乱序成功（G11） | `suspend` 的成功晚于 `extend` 的成功落地，mapping 回退 | 版本复核，纯本地可验 |
| backoff 溢出（G7） | 第 31 次尝试直接抛异常，命令永久卡住 | 一行 `least(...)` 前置截断；需先在本地库实测确认 |

**能本地证明（pgTAP，纯 SQL，不碰网络）**：G2/G3/G6/G7/G9/G11 + `reap` 的时间推进（可用 `p_now` 参数或改系统时间不必要——建议函数签名带 `p_now timestamptz default now()` 便于测试）。
**能本地证明（集成，真 PostgREST + 本地假远端 http server）**：claim→dispatch→complete 全链路、并发两个 claim 只出一条、假远端超时/500/409 的三条落库分支。
**只能 staging**：远端真的建出 org、远端幂等键行为、真实网络超时与 Cloudflare cron 的最小间隔、`service_role` 在 cron 上下文里的可用性。

## 5. 工作量

| 范围 | 规模 | 理由 |
|---|---|---|
| 只补 M0（执行机构，远端打桩） | **M** | 1 个迁移（3 列 + 1 状态 + 1 索引 + 3 函数，约 250 行）、1 个 `scheduled` 入口 + 1 个远端 client（约 200 行）、pgTAP 1 组（约 20 断言）+ 集成 1 组（约 10 用例）；无新端点、无新权限码 |
| M0 + M1（真正能开通租户） | **L** | 再加：租户侧 internal 端点 1 个 + 幂等表 1 个 + 4 个动作实现（provision 要建 org/owner/默认配置，是最重的一块）、staging 验收（真实 org 创建、重复请求、超时重放）、运营端「执行中」状态展示改造 |

**仍需再查（不要猜）**：① 远端 internal 接口的字段与错误码（`provision` 的成功响应必须含 `udoneOrganizationId`，见 :968-993，但其余 7 种命令的响应形状完全未知）；② `bind` 与 `provision` 的区别；③ `sync_entitlement` 的载荷由谁生成（`request_summary ← p_payload` 现在完全靠调用方手填，前端未验证）。
