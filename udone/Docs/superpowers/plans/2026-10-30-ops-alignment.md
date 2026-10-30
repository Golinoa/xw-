# ops 双端差异对齐与执行顺序（2026-10-30）

> **一句话结论：** 15 处差异逐条裁决完毕。5 处是我的口径要改（含 2 处数字错误），3 处是运营端要回写契约正文，4 处是我这边新发现的实现细节，3 处已闭环只需告知。执行顺序固定为 **T-02a → T-01(`/meta`) → W0.4(登录) → T-03a(`/session`)**，因为这四步的依赖是硬的（`/meta` 的权限是「已认证运营成员」、`login` 要判 `OPS_MEMBER_MISSING`，两者都要查 `ops.operators`）。

**读者边界：** 本文件是**我方执行清单与差异台账**。ops 的字段、端点、错误码仍以 `admin/Docs/ops-api-contract.md` 为唯一真源，本文件不重定义契约，只记录「哪里不一致、为什么、谁改」。

---

## 1. 差异清单（DIF-01 ~ DIF-15）

| 编号 | 事项 | 运营端口径 | 我方口径 | 裁决 | 依据（可复核） |
|---|---|---|---|---|---|
| **DIF-01** | 落地顺序 | `/meta` 提前到 W0.4 并行，T-02 放最后 | T-02a 必须最先 | **采纳我方** | 契约 §5.1：`GET /meta` 权限列＝「已认证运营成员」；`POST /auth/login` 要返 `OPS_MEMBER_MISSING`/`INACTIVE` 且不下发 cookie。两处都查 `ops.operators`，而表在 T-02 里 |
| **DIF-02** | 幂等 scope 派生 | 改 `operator_id` | 验签后的 `sub` | 诊断采纳、实现另择；契约写「调用者标识」不锁算法 | 中间件链 `requestId→cors→rateLimit→idempotency→routes`，幂等跑在路由级 `requireAuth` **之前**；`sub` = `auth.users.id` = 契约 §3.9 `ops.operators.user_id`（`UNIQUE`），与 operator 一对一 |
| **DIF-03** | `actor_id` 语义 | 未表态 | `ops.idempotency_records.actor_id` 存 `auth.users.id`（uuid） | 成立，需契约加一句措辞 | 迁移 `20261030000002` 已定义为 `uuid`；契约 §3.9 审计表本就分 `actor_operator_id` 与 `actor_user_id` 两列，写审计时两列都填 |
| **DIF-04** | 幂等表列形状 | `PK(scope, key)`，scope 示例 `POST /api/v1/ops/receipts` | `scope_key` 单列 `UNIQUE` | **我方主动收敛**（非阻塞） | 我的偏离理由（scope 不含调用者→撞 key 共享槽）成立，但可以用「`scope` 内含调用者」同时满足形状与命名空间。纯口径问题，无安全增益，排 T-02b |
| **DIF-05** | U-17/U-18/U-19 落正文 | 三条都「按接受处理」 | 按裁决实现 | **他们改正文** | 实测：U-17 已入正文（§5.9 `POST /exports` 有 `reason`）；U-18（`GET /operators` 的 `version`/`mfaRequired`）、U-19（`GET /dictionaries` 条目 `id`）**只在 §11 不确定性表**，正文未动 |
| **DIF-06** | 域数 | 8 业务域 + identity | 我方文档写「6 个业务域 + identity」 | **采纳他们** | 契约 §3.1~§3.9 共 9 节 = 8 业务域 + identity-audit |
| **DIF-07** | 权限码数 | 契约 39 | 看板写「动作码定义 48 条」 | **39 是唯一口径，看板改** | 逐行提取 `constants/permissions.ts` = **39** 个码，与契约 §4 一一对应；48 无出处 |
| **DIF-08** | `supportedSalesModes` / `supportedCurrencies` 取值集 | 要求与 C12 同构（另给两条附加条件） | 我方 C12 未做，且全仓无定义 | 我提案取值，写进契约常量 | 契约 §3.2 `ops.product_sales_modes.sales_mode` ∈ `saas`/`private` → `['saas','private']`；币种全契约只出现 `char(3) DEFAULT 'CNY'`、无多币种需求 → `['CNY']` |
| **DIF-09** | `/auth/*` 豁免 Authorization | 三个 `POST /auth/*` 豁免，其余全要求 | 我方只认 Bearer，无路径级豁免 | 采纳 | 契约 §5.1 「认证端点例外」；`refresh`/`logout` 凭 cookie，无 Bearer |
| **DIF-10** | CORS 凭证 | 跨源 `None; Secure` + credentials + 白名单，断言 `*` 被忽略、凭证响应带 `Vary: Origin` | `credentials:false`（`cors.ts:44`） | 采纳，并补一条更严的 | 读 hono 4.13.12 源码：`Vary: Origin` **只在 `opts.origin !== '*'` 时** append（我们传函数，成立）；而 `Access-Control-Allow-Credentials: true` 是**无条件**设置的，不看来源是否命中 → 必须把 credentials 与「白名单非空 + 来源命中」绑定 |
| **DIF-11** | 测试 JWT 通道 | 要求能签测试令牌 | `jwt.ts` 只有验签，无签发入口 | 采纳，但必须独立开关 | 不能「配了 `SUPABASE_JWT_SECRET` 就启用」——生产也配它。用 `ALLOW_LOCAL_JWT_AUTH`，并在 `check:deploy` 断言生产禁止 |
| **DIF-12** | 根 `test:unit` 拉全仓 | 已改为 `--filter` | — | **不适用** | 我根 `package.json` 只有 `"test": "vitest run"`，没有 `test:unit`、没有 `quality:check`，单一 `vitest.config.ts`（`maxWorkers: 6`） |
| **DIF-13** | `contractVersion` | `1.0.0`（semver，无前缀） | 一致 | 无分歧 | 契约 §2.1.1：`v1.0.0`/`1.0.0-beta` 均判 `MALFORMED` |
| **DIF-14** | 邀请端到端 | 未回应 | §11.6 声明本地无 GoTrue → 只能单测替身 | **要他们书面确认** | `ops.operators.user_id NOT NULL REFERENCES auth.users(id)`：邀请要先在 GoTrue 建号，本地无 GoTrue |
| **DIF-15** | 前端直连 `/rest/v1` 会不会 42501 | 提问 | 已证：会 | 已闭环，只需告知 | `tests/integration/ops-schema.test.ts`：客户端令牌请求 ops 表 → `42501 permission denied`；`ops` schema 未授予 `anon`/`authenticated` USAGE |

### 1.1 我先改的三处（自我纠正）

1. **域数 6 → 8**（DIF-06）：本文件与计划文档同步改。
2. **权限码 48 → 39**（DIF-07）：看板数字改，并给出取数口径（`grep -o "'[a-z]*\.[a-z.]*'" constants/permissions.ts | sort -u | wc -l`）。
3. **幂等列形状**（DIF-04）：登记为 T-02b，不改变已有语义。

---

## 2. 四态进度（回应运营端 §13 的四态要求）

| 项 | 四态 | 证据（当次实测，非引用历史） |
|---|---|---|
| W0.1 幂等命名空间 + 落库 | **已交付已验证** | `3df4fe2` / `fe4e184` / `d585392`；单测 9 条 + 集成 4 条；变异三轮（退回哈希派生→单测 1 条 + 集成 1 条刷新断言红；跳过验签→3 条伪造令牌断言红；`set()` 空操作→2 条重放红）；集成还断言库里 `scope_key` 必须等于中间件派生值 |
| W0.2 PostgREST 暴露 `ops` | **已交付已验证** | `9aba9ce`；`ops-schema.test.ts` 4 条（service_role 往返 / 不带 profile 表不可见 `PGRST205` / 客户端令牌 `42501` / `request_hash` 长度约束）+ `rest-client` 5 条头映射；变异：拿掉 `db-schemas` 的 ops → `PGRST106 Invalid schema: ops` |
| W0.3 契约双注册表 | **已交付已验证** | `36b2cc8`；`compareRegistries` 6 条合成输入（未挂载 / 未登记 / 双表同名 / 前缀写错 / 不检查无前缀表 / 全对时四数组为空）；变异两轮：登记未挂载 → 点名 `GET /api/v1/ops/meta`；改成 `/api/ops/meta` → 前缀红 |
| W0.4 认证代理 + 受控 CORS | **未开始** | `cors.ts:44` 仍 `credentials: false`；`apps/api/src` 无 auth 路由；全仓无 cookie 处理代码 |
| T-01 `/meta` | **未开始**（依赖 T-02a） | `packages/contracts/src/routes.ts` 的 `OPS_ROUTES` 仍是 `{}` |
| T-02 | **未开始** | `ops` 下只有 1 张表（`idempotency_records`）、0 个函数；15 个迁移 |
| T-03 | **未开始** | 无 `operators`/`roles`/`audit_events` 表 |

> 四态口径：**已交付已验证**＝有提交哈希 + 当次命令输出 + 变异证据；**已交付未验证**＝代码在、门禁绿，但关键验收是替身或未跑；**进行中**＝有未提交的工作；**未开始**＝无代码。

---

## 3. 我方推进任务列表（固定顺序）

| 序 | 任务 | 规模 | 依赖 | 状态 | 验收（可执行断言） |
|---|---|---|---|---|---|
| N1 | **T-02a** ops 身份基座：**六**表 + 四函数 + 39 码 seed | M | — | 未开始 | pgTAP：P1 `anon` 无 USAGE；P2 租户成员查 ops 表 0 行；P4 `invited`/`disabled` 0 行；全部函数 `search_path=''` 且无 `public`/`anon` EXECUTE；39 码与契约 §4 对账；6 角色 seed 抽样矩阵（`support_agent` 无任何 `receivable.*`、`ops_viewer` 无 `write`） |
| N2 | **T-01** 契约包 + `GET /meta` | M | N1 | 未开始 | route-parity 双向 + 前缀；匿名 401；租户用户 403；`contractVersion` 匹配 `^\d+\.\d+\.\d+$` 且等于常量；`serverTime` 以 `Z` 结尾；两个常量数组内容与长度断言 |
| N3 | **W0.4** 登录代理 + 受控凭证 | M | N1 | 未开始 | 「非运营成员 → 403 + 无 `Set-Cookie`」「停用 → 403 `OPS_MEMBER_INACTIVE`」「坏凭证 → 401」「连失败 → 429」「refresh 轮换旧 cookie 失效」；CORS：`*` 被忽略、命中来源有 ACAO+ACAC+`Vary: Origin`、未命中来源**无** ACAC；测试签发通道仅在 `ALLOW_LOCAL_JWT_AUTH=1` 时可用，`check:deploy` 断言生产禁用 |
| N4 | **T-03a** `/session` + `/permissions` | S | N1、N2 | 未开始 | `/session` 的 `permissions[]` 与 `ops.has_permission()` 抽样一致（≥3 码）；`permissionVersion` 单调递增（改角色后严格变大）；`/permissions` 返回 39 条且 `isHighRisk` 与契约 §4 高风险清单一致（14 个） |
| N5 | **可关桩里程碑**（告知节点，非开发项） | — | N2+N3+N4 | 未开始 | 一次真实链路：`login → /meta → /session → 403 用例`，四步全绿才通知运营端 `VITE_OPS_MOCK=false` |
| N6 | **T-03b** `/operators*` `/roles*` `/audit-events` | L | N4 | 未开始 | 分层验收：pgTAP（LAST_ROLE / LAST_ADMIN / 角色变更前后摘要入审计）；HTTP（P6 无敏感权限时响应不含 `phone`/`email` 键、P11 租户管理员 403、P12 无 token 401）；邀请＝**单测替身**且在 journal 标注 |
| N7 | **T-02b** 幂等列形状收敛 `PK(scope,key)` | S | N1 | 未开始 | `scope` 内含调用者标识；两条碰撞断言仍绿；契约列名与实际库一致 |
| N8 | Wave 2：T-04 → T-14 | L×11 | N6 | 未开始 | 按契约 §8 依赖图，一域一轮：迁移 → RPC → 端点 → pgTAP → 集成 → 提交 |

**并行约束：** N1 与其余全部串行（迁移串行追加，一个节点一个迁移）。N7 可在任意空闲窗口插入，不阻塞 N2~N6。

### 3.1 复核补正（2026-10-30 第二次过表，三处原表写错）

| 原写法 | 实际 | 为什么 |
|---|---|---|
| N1「五表」 | **六表**：`operators`、`roles`、`permissions`、`role_permissions`、`operator_roles`、**`audit_events`** | `write_audit()` 是 N1 的交付物之一，表不在同一次迁移里它写不了。漏的是审计表 |
| `permission_version` 列没写在 N1 | 写进 N1 迁移（`ops.operators.permission_version bigint NOT NULL DEFAULT 1`） | N4 的 `/session` 要读它。放到 N4 才加列等于多一次迁移，而且中间态 `/session` 无从返回值 |
| N3 验收写「非运营成员 → 403」 | 拆开：GoTrue 上游用**注入替身**，`ops.get_current_ops_context()` 走**真实 PostgREST** | 本地没有 GoTrue（DIF-14）。不写清这条，验收看着像不可能完成；写清了才知道「403 判定」这段是真跑过的，「密码校验」那段是替身 |

**业务端 backlog 位置不变：** A1（主线 E2E）、A5（供应商测试）、B1/B2、C1–C12、D1/D2 继续挂起，理由同计划文档 §与既有 backlog 的关系——ops 是当前唯一有外部等待方的工作。

---

## 4. 需要运营端动作的 6 件事

| # | 事项 | 为什么必须他们做 | 不做的后果 |
|---|---|---|---|
| 1 | 回写 §5.1 `GET /operators` 加 `version`、`mfaRequired` | 契约正文是三方唯一真源 | 他们前端继续「禁用成员编辑」，我实现后仍"未定义" |
| 2 | 回写 §5.9 `GET /dictionaries` 条目加 `id`（含 `POST /dictionaries/{code}/items` 响应） | 同上 | 字典项只能只读 |
| 3 | 书面确认「邀请验收按替身记账」 | 本地无 GoTrue，`auth.admin` 无法端到端 | 我只能在 journal 标替身，他们会误以为已验收 |
| 4 | 确认两个常量数组取值（`['saas','private']` / `['CNY']`）及其两条附加条件原文 | 我只记得「与 C12 同构」 | 若他们要别的值集，T-01 要返工 |
| 5 | 定稿三处「未定义形状」 | 他们在 §13.2 主动提出 | T-13 报表/导出返工 |
| 6 | `ops.idempotency_records.actor_id` 措辞改为「auth 用户 id，非 operator 主键」 | 一词两义会让审计查询读错列 | 排障时口径打架 |

### 4.1 我给出的三处定稿建议（对应第 5 项）

| 字段 | 定稿 | 依据 |
|---|---|---|
| `overview.partialFailures[]` | `{ code: string, message: string, section?: string }` | 他们前端已按 `{code?, message?, section?}` 全可选读取，此形状是其超集，不需要改前端 |
| `requestedBy` / `updatedBy` | **对象** `{ id, displayName }` | 与 `/audit-events` 的 `actor{id,displayName}` 同形；他们前端 `OpsActorLike = OpsActorRef \| string` 两种都吃，对象优先显示 |
| `retention.exportDays` | 整数 `1–365`（与 `overview.expiryWindowDays` 同区间） | 契约 §5.9 已给窗口 1–365、工单时限 1–720；导出保留未给，无理由超一年 |

---

## 5. 给运营端的提示词（整段可粘贴）

```text
【后端回执 · 差异对齐（feat/business-slice @ cf93cbb）】

一、四态（当我次实测，不引用历史）
- W0.1 幂等命名空间 + 落库：已交付已验证（3df4fe2/fe4e184/d585392，单测 9 + 集成 4，变异三轮）
- W0.2 PostgREST 暴露 ops：已交付已验证（9aba9ce，集成 4 条含 42501，变异 PGRST106）
- W0.3 契约双注册表：已交付已验证（36b2cc8，parity 6 条合成输入，变异两轮）
- W0.4 认证代理 + 受控 CORS：未开始（cors.ts:44 仍 credentials:false，无 auth 路由）
- T-01 /meta：未开始（OPS_ROUTES 还是空表）；T-02：未开始（ops 下 1 张表 0 个函数）；T-03：未开始

二、顺序裁决（这条我要改你的建议）
你说的「/meta 提前与 W0.4 并行、T-02 放最后」技术上不成立：契约 §5.1 里 /meta 的权限是「已认证运营成员」，
login 要返 OPS_MEMBER_MISSING / INACTIVE 且不下发 cookie —— 两者都要查 ops.operators，而表在 T-02。
固定顺序：T-02a（identity 五表 + 四函数 + 39 码 seed）→ T-01(/meta) → W0.4(login) → T-03a(/session)。
四步全绿我一并通知你，你就可以 VITE_OPS_MOCK=false。

三、三条裁决的落地状态
- U-17：你已写进 §5.9 正文，收到。
- U-18 / U-19：**只在 §11 不确定性表，正文没改**。GET /operators 的响应字段仍无 version/mfaRequired，
  GET /dictionaries 的条目仍无 id。我按裁决实现，但请你回写正文，否则三方再次不一致。
- 我额外要一条：幂等表 actor_id 的措辞请改为「auth 用户 id（= operators.user_id），非 operator 主键」，
  因为审计表里本就分 actor_operator_id 与 actor_user_id 两列，一词两义会让排障读错列。

四、幂等 scope：你的诊断成立，实现我换了一条
sha256(Authorization) 在令牌轮换下必失效，我认。但你建议的 operator_id 需要中间件先拿到身份，而它跑在
requireAuth 之前（要先查缓存才决定是否执行 handler）；改用自己验一次 HS256 便宜几个数量级。
所以取验签后的 sub —— 它 = auth.users.id = 你要的 operators.user_id，与 operator 一对一。
三级退化都朝安全方向收敛：无令牌→anonymous；验签失败→令牌哈希（仍隔离调用者，只是自己刷新后换格）；验签通过→user:<sub>。

五、两个常量数组（我提案，请确认或否掉）
- supportedSalesModes = ['saas','private']（取自契约 §3.2 product_sales_modes.sales_mode 的全部取值）
- supportedCurrencies = ['CNY']（契约全文只出现 char(3) DEFAULT 'CNY'，无多币种需求）
你上次给的两条附加条件，我按「①必须是 contracts 里的常量数组（as const），不得在 handler 内硬编码；
②C12 落地后复用同一数组，不得另立」实现。若不是这两条，请复述原文。

六、CORS：你的两条断言我照做，但实测源码后要加严一条
hono 4.13.12 的 cors 里，Vary: Origin 只在 opts.origin !== '*' 时 append（我们传的是函数，所以成立）；
但 Access-Control-Allow-Credentials: true 是**无条件**设置的，不看来源是否命中白名单。
所以我的实现把 credentials 与「白名单非空 + 来源命中」绑定，断言三条：
① ALLOWED_ORIGINS 含 * 时该来源不被接受；② 命中来源必须同时有 ACAO + ACAC + Vary: Origin；
③ 未命中来源不得出现 ACAC（你原来只要求前两条）。

七、测试 JWT 通道
jwt.ts 验签已就位，W0.4 里补签发入口。开关用独立的 ALLOW_LOCAL_JWT_AUTH，**不是**「配了 SUPABASE_JWT_SECRET 就启用」
——生产也配那个变量。check:deploy 会断言生产环境禁止打开，这条我写进门禁。

八、三处「未定义形状」我今天定稿，你有反对现在说
- overview.partialFailures[] = { code, message, section? }（你前端读的是三者全可选，这是超集，前端不用改）
- requestedBy / updatedBy = 对象 { id, displayName }（与 /audit-events 的 actor 同形，你的 OpsActorLike 两种都吃）
- retention.exportDays ∈ 1–365（与 overview.expiryWindowDays 同区间）

九、两件只需要你点头的事
1. 邀请端到端：本地无 GoTrue，而 ops.operators.user_id 外键到 auth.users —— 邀请必须先建 auth 用户。
   这条验收只能是单测替身，请书面确认按替身记账，不要算作已验证。
2. 根 test:unit 那条对我这边不适用：我根 package.json 只有 "test": "vitest run"，单一 vitest.config.ts
   （maxWorkers: 6），没有 test:unit / quality:check 两条脚本。

十、数字口径（两处纠正）
- 域数：8 业务域 + identity-audit（我之前写 6，是我按旧版数错了）。
- 权限码：**39**。我逐行提取你 constants/permissions.ts 是 39 个，与契约 §4 一一对应；
  我这边 48 是错的口径，已改看板。

十一、42501 已闭环
客户端令牌请求 ops 表 → 42501 permission denied，集成里就有这条（ops-schema.test.ts）。
结论：前端不得直连 /rest/v1，ops 数据只能走 Worker 的 /api/v1/ops/*。
```

---

## 6. 我暂不承诺的三件事

1. **`/meta` + `/session` 的具体日期**：N1 的 pgTAP 断言数未知（P1/P2/P4/P5 需要新写），我不给估时；做完立刻通知。
2. **T-03b 的邀请能真跑**：见 DIF-14，本地无 GoTrue，只能替身。
3. **Wave 2 的节奏**：T-04 之后每域一轮（迁移→RPC→端点→pgTAP→集成→提交），不承诺并行，因为迁移必须串行追加。

---

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-30 | 建立本台账。15 条差异裁决；六项运营端待办；执行顺序 N1~N8；三处形状定稿提案 |
| 2026-10-30 | 复核过表：N1 由「五表」改「六表」（漏了 `audit_events`，而 `write_audit()` 要靠它）、`permission_version` 挪进 N1 迁移、N3 验收拆成「GoTrue 替身 + 真实 ops 表」两段。见 §3.1 |
