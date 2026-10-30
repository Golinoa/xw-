# 2026-10-30 · 幂等列形状收敛 + 依赖清零 + 看板回写（收口条）

本条接在 `2026-10-30-ops-identity-alignment.md`（`o-t03c`）与
`2026-10-30-ops-customer-s2-s3.md`（`o-t04`）之后，补完 HANDOFF §4 剩下的三件：
`o-t02b` 幂等列形状、`a-deps-biz` 依赖债与门禁、以及本轮四张卡的看板/journal 收口。

## 今日完成

| 单元 | 卡 | 提交 | 出口（当次实测） |
|---|---|---|---|
| 幂等记录收敛为 `PK(scope, key)` | `o-t02b` | `3731d23` | `db:local:http` 8 文件 97 条 |
| 依赖漏洞清零 + 两道新门禁 | `a-deps-biz` | `6e91ad6` | critical 0 / high 0 / moderate 0 / low 0；白名单 0 条 |
| 看板回写 + journal + 全量门禁 | 收口 | 本条提交 | 13 道全绿（数字见下） |

- `20261030000008_ops_idempotency_scope_key.sql`：加 `scope` / `key` 两列，按**最后一个冒号**
  回填（scope 自身含冒号，从左切会把 scope 截断），删 `scope_key`、删 `id` 代理主键，
  再 `ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (scope, key)`；`actor_id` 更名
  `actor_user_id`。
- `lib/idempotency-key.ts` 的 `IdempotencyScope` 去掉 `key`，`idempotencyStorageKey()` 改名
  `idempotencyScope()`（只算 scope，不含客户端键）；`lib/idempotency-store.ts` 引入结构化
  `IdempotencySlot { scope; key }`，`get/set` 都收 slot；`lib/ops-idempotency-store.ts` 改成
  `scope=eq.` + `key=eq.` 两个条件；`middleware/idempotency.ts` 组装 slot。
- 集成：`expectedScopeKey` → `expectedIdempotencyScope`；新增「同一 key 不同调用者不重放」
  与「同一 (scope,key) 不能插第二行」两条。
- 依赖：三条区间 override 进 `pnpm-workspace.yaml`（undici `>=7.30.1`、sharp `>=0.35.5`、
  fast-uri `>=3.1.9`），vite 升 7.3.7、zod 升 4.6.6、vitest 升 4.1.12；新增
  `scripts/check-deps-audit.mjs`（四条判定 + `--self-test` 五组合成数据）与
  `scripts/deps-allowlist.json`（`entries: []`）；`deps:audit` 改指新脚本、新增
  `deps:audit:raw`；门禁 11 道 → 13 道。
- 看板：`SEED_VERSION` 28 → 29；`o-t03c` 新卡（`D-01`/`D-03`/`D-04`）、`o-lastlogin`
  （`D-05`）、`o-t02b`、`o-t04`、`a-deps-biz` 改 done；`a-integrate` 从 blocked 解锁为 todo；
  `C-97` / `C-98` 闭环，`C-99` 保持 waiting 并改写成落地步骤，新增 `C-100` ~ `C-103`；
  `C-04` 与 `BLOCKERS` 里「受邀登录会拿 403」「ops 端点 0 个」「依赖审计待决策」三处过期
  描述一并订正。

## 关键决策

1. **形状与命名空间是两件事，可以同时满足**。上一版为了「scope 不含调用者会让两个成员
   撞同一 key」而把五段拼成一个 `scope_key` 字符串，代价是形状偏离契约 §3.9 且无法解释。
   正解是照契约拆两列、让 `scope` 内含调用者——偏离理由成立，但不需要用偏离来实现它。
2. **`C-99` 不关**。业务端这半边已经落完（`6e91ad6`，0 漏洞、白名单空表），但
   `DECISIONS.md` D-11 的落地动作在运营端 `quality:check`，那边还没做。把一条「等对方落地」
   写成 closed，正是看板自己警告的那种失准：读的人会以为整件事完了。改成 waiting + 四步
   可照做的 `need`，`blocks` 仍指 `a-ci` / `a-deps`。
3. **一个提交不在三张卡上重复记账**。`D-01`~`D-05` 同属 `ac1ccda`，但拆卡按交付物而不是按
   提交：`D-02` 是 RPC 参数、落 `o-t03b`；`D-05` 是 `last_login_at`、落 `o-lastlogin`；
   `o-t03c` 只记 `D-01`/`D-03`/`D-04`（激活函数、审计常量表、邀请补偿删除）。
4. **`o-w04b` 从 todo 改 blocked**。本地没有 `/auth/v1`，三件事一件也做不了；todo 会让人以为
   「排一排就能做」。它挂着两个未验证假设（refresh token 一次性、`logout` 接受 body 里的
   refresh token），后者不成立时症状是「点了退出，被拿走的 cookie 还能换新令牌」，而本地
   测不出来——这比「没做」更需要写在明面上。
5. **能升直接依赖就不写 override**。override 是绕过解析器的补丁，写得越多越难解释
   「为什么装的是这个版本」。所以只有 undici / sharp / fast-uri 走区间 override，vite 与
   zod 直接升。

## 遇到的问题

1. **迁移重放报 `multiple primary keys for table "idempotency_records" are not allowed`**。
   旧表已有 `id` 上的主键，不能再加 `PK(scope, key)`。顺序必须是先 `DROP CONSTRAINT
   idempotency_records_pkey`、再 `DROP COLUMN id`、最后加复合主键。
2. **pnpm 11 不再读 `package.json` 的 `pnpm.overrides`**，只认 `pnpm-workspace.yaml`，而且
   只在 install 时warning 一句。这意味着「加了 override 却没生效」在这个版本上是默认行为——
   上一轮把 overrides 写在 `package.json` 里，等于没加。已迁到 workspace 文件并删掉该字段。
3. **`pnpm audit --json` 返回 `{advisories, metadata}` 而不是 `{vulnerabilities}`**，两代形状
   并存。解析器两种都读，否则一次上游变更就会让门禁静默变成「0 条」。
4. **输出重定向到 `/tmp` 在 Windows 上会落到 `D:\tmp`**（不在仓库内），脚本读不到文件还
   会以为是「0 条漏洞」。改用仓库内相对路径，读完即删。
5. **sharp 升到 0.35.5 后 `licenses:check` 变红**（`@img/sharp-win32-x64` 的
   `Apache-2.0 AND LGPL-3.0-or-later`）。改例外版本号而不是放宽策略：理由（development-only）
   与范围都没变，只有版本跟着走。
6. **登录激活分支误伤并发登录**（来自 `ac1ccda`，本条一并记）：最初写成「返回不是
   `activated` 就 503」，但另一个并发登录刚激活同一行时返回的正是 `unchanged`——那是成功。
   改成 `unchanged` 时回读一次成员状态：`active` 继续、`disabled`/`missing` 回 403、
   仍是 `invited` 才 503，三条单测钉住。
7. **工作树出现过一条零差异的 `M`**（`apps/api/src/lib/idempotency-key.ts`，索引与工作区
   md5 完全一致，`git diff` 空）。不是遗漏提交，是索引 stat 信息过期；`git add` 刷一次索引
   就消失。记下来是因为「工作树干净」这句话以后需要能复核——看到 `M` 先比 md5，别直接
   当成未提交改动去 commit。

## 全量门禁（13 道，一次跑完，退出码 0）

```
board:check        SEED_VERSION 29 · 98 张卡（65 done / 2 doing / 29 todo / 2 blocked）· 协作 22 项（7 未闭环）
format:check       All matched files use Prettier code style
format:sql:check   38 file(s)
lint               eslint + css:tokens:check（apps\web\src）
schema:check       Schema inventory matches 21 migration(s)
check:deploy       Deployment configuration checks passed
deps:audit         critical 0 / high 0 / moderate 0 / low 0 / info 0，白名单 0 条
licenses:check     349 installed package groups
typecheck          web + api
test               46 files / 394 tests
build              dist/assets/index-*.js 1,638.75 kB（gzip 506.78 kB）
db:local:verify    21 迁移 / 16 文件 / 371 断言
db:local:http      8 文件 / 97 条
```

`db:local:verify` 的分项：`ops_customer_domain` 57、`ops_identity_write` 48、
`ops_identity_alignment` 37、`ops_identity_rls` 34、`finance_payment_application` 28、
`permissions_and_disabled_sessions` 26、`order_line_update` 23、`finance_application_flow` 19、
`order_rls` 16、`customer_rls` 15、`finance_scope` 15、`identity_rls` 15、
`request_organization_context` 14、`line_write_guard` 12、`ops_login_state` 6、
`organization_context` 6。

## 下一步计划

1. **`o-t05` 产品 · 套餐 · 价格版本**（P3 后半）：`products` / `product_sales_modes` /
   `feature_definitions` / `packages` / `package_features` / `package_price_versions`；
   价格版本只追加，停用套餐被草拟合同引用时返回 `OBJECT_REFERENCED`。
2. **`o-t06` 合同域**排在其后：它同时解开 `o-t04` 留下的三个未验证项（`referenced` 用的是
   替身表、`contractStatus` 与 `entitlementExpiringInDays` 接受但不生效、`counts` 只证 0 值）。
3. **等运营端回 `C-04` 的四步结果**：登录 → `/meta` → `/session` → 401/403 判定。两处预期
   必须先改，否则会把正确行为记成缺陷（受邀账号首次登录 200、`lastLoginAt` 有值）。
4. **契约回写 `C-100` ~ `C-103`**：审计词 5 → 9、三个 `details.reason` 入 §6.4、客户编号
   格式与 §7.3 的 A1 归类、`lastLoginAt` 的语义。
5. **`o-w04b` 仍缺真实环境**：需要一个有 `/auth/v1` 的 Supabase 项目（D-09 的五个值 + D-10
   的 staging），在那之前这条只能是 blocked。

## 断点（2026-10-30 23:39）

- 分支 `feat/business-slice`，本条提交之前的 HEAD 是 `6e91ad6`，工作树干净（除本条的
  journal 与看板，看板在仓库外不进版本控制）。
- 13 道门禁最后一次运行：全部通过，数字见上一节。**引用这些数字时必须是当次跑出来的**，
  不是从这条 journal 抄的。
- 下一单元从 `o-t05` 开始；`o-t03c` / `o-t04` / `o-t02b` / `o-lastlogin` / `a-deps-biz` 已 done
  且每张卡的 `desc` 里都能指回提交哈希。
- 未验证项清单（不要在不看这条的情况下宣称「已验证」）：
  - 邀请补偿删除只证到「补偿被调用」，本地无 GoTrue；
  - `logout` 调 `/auth/v1/logout` 的请求形状、refresh token 是否一次性、cookie 的
    `Secure`+`SameSite=Strict` 跨源表现——三件都要真机；
  - `customer_no_conflict` 信封造不出来（不重置序列无法制造重号）；
  - `contractStatus` / `entitlementExpiringInDays` 接受但不生效。
