# 2026-10-31 · catalog 域（`o-t05`：产品 · 套餐 · 价格版本 · 功能键）

## 今日完成

| 提交 | 内容 | 出口（当次实测） |
|---|---|---|
| `ad39b65` | 六表 + 19 个函数 + 106 条 pgTAP | `db:local:verify` 22 迁移 / 17 文件 / 477 断言 |
| `e27bcb8` | 契约 + 13 端点 + 52 条单测 + 37 条集成 | `db:local:http` 9 文件 / 134 条 |

- 表：`products`、`product_sales_modes`、`packages`、`package_price_versions`、
  `feature_definitions`、`package_features`。两处「只追加」按契约实现：价格版本
  只有 INSERT 路径；`feature_key` 不可改（PATCH 的 `strictObject` 在入站就 400）。
- 函数：5 个形状函数 + `catalog_reference_counts` + 13 个 RPC，全部 `SECURITY DEFINER`
  + `search_path = ''`；业务失败一律 `{status:...}` 信封，只有权限不足抛 42501。
- 端点：`GET/POST /products`、`PATCH /products/{id}`、`GET/POST /packages`、
  `GET/PATCH /packages/{id}`、`POST/GET /packages/{id}/price-versions`、
  `POST /packages/{id}/transition`、`GET/POST /features`、`PATCH /features/{key}`。
- 规则文档：`Docs/superpowers/specs/2026-10-31-catalog-domain.md`（两个并行会话共读的
  唯一口径，也解释了每条「推断」的来处）。

## 关键决策

1. **读侧也走 RPC，但理由与客户域不同**。契约 §7.3 把 `products` /
   `product_sales_modes` / `feature_definitions` 归 A1（可列级直写），而 §5.3 的列表项要
   `packageCount` 与 `usageCount` 两个聚合字段——直读拿不到聚合，会得到「字段缺失」的
   第二种形状。一张表两套读法比一张都不给更难解释，所以这一域统一 RPC-only，
   并在迁移头注释里写明「A1 归类与 §5.3 的聚合字段冲突」。已登记 C-102 同类问题。
2. **`list_price` 是「当前价」，不是「建套餐时定的价」**。新建价格版本后同步刷新
   `packages.list_price` / `currency` / `current_price_version_id`。不这么做，价格版本
   在列表里就是不可见的：前端只显示 `listPrice`，而它会永远停在第一版。已生效合同用
   `contract_items.unit_price` 快照，不受影响——这正是「价格版本只影响新合同」的落点。
3. **`packages.status` 是推断的**。契约 §3.2 没枚举它，§5.3 只给了 `activate` 与
   `retire` 两个动作。本轮定 `draft/active/retired`，与 `products.lifecycle_status` 对齐；
   `retired` 是终态，再次 `retire` 返回 `invalid_transition` 而不是幂等成功（否则审计里
   会出现两条「停用」，第二条什么也没做）。
4. **引用守卫用 `to_regclass` + 动态 SQL**。`ops.contract_items` 还不存在（T-06），
   所以 `draft_contracts` 现在恒为 0，`retire` 永远成功。这与客户域同一处理：本轮先把
   守卫接口接上，合同域落地时补分支，不改状态机。pgTAP 用同一事务里的临时替身表
   证明这条分支真的会拦（用完就 `DROP`）。

## 遇到的问题

1. **`POST /features` 漏了幂等键，是集成测试抓出来的**。契约 §5.3 的幂等列对它也是
   「必填」，实现只覆盖了另外四个（products / packages / price-versions / transition）。
   漏它的推理很常见：「功能键本身就是主键，重复创建已经是 409」。但 409 只覆盖
   「同一个键重试」，覆盖不了「网络重试在建行之后、响应丢失」这种真正需要幂等的场景。
   集成第一次跑就红在 `201` 而不是 `400`。已在 handler 补 `requireIdempotencyKey`，
   并补两条单测（有键 201 / 无键 400）。
2. **数据库子会话被限流打断在自验之前**。迁移与 pgTAP 已落盘（57KB / 39KB），但
   `db:local:verify`、`format:sql`、变异验证都没跑。这类「文件在、验证不在」的状态最危险：
   看起来完成了。所以本轮全部自己重跑：verify 全绿、格式已修、变异红 3 条后复原。
   **结论：子会话产出必须按「未验证」对待，直到自己跑过。**
3. **`deps:audit` 从 moderate 0 变成 moderate 1**。新增的是 `minimatch <11.0.1`
   （globparts ReDoS），审计源在两次运行之间新发的 advisory，不是依赖树变化。
   门禁仍绿——这正是 D-11 口径的设计：moderate 只计数不拦。是否 override 到 11.x
   要单独评估（minimatch 是 major 跨版本，eslint/glob 链上多处引用），不在别的单元里
   顺手改，已记进看板与 §下一步。
4. **`/tmp` → `D:\tmp` 又踩了一次**。bash 的 `> /tmp/x` 写到 `D:\tmp\x`，而 node 用
   `fs.readFileSync('/tmp/x')` 解析成同一个位置只在 shim 下成立——这次两边不一致，
   报 `ENOENT: D:\tmp\raw-audit.json`。上一轮 journal 已经记过这条，仍然复发，
   说明「临时文件放仓库内相对路径、用完即删」应当作默认动作，不是备忘。

## 全量门禁（13 道，一次跑完，退出码 0）

```
board:check        SEED_VERSION 30 · 98 张卡（66 done / 2 doing / 28 todo / 2 blocked）· 协作 22 项
format:check       Prettier 全通过          format:sql:check   40 file(s)
lint               eslint + css:tokens      schema:check       22 migrations
check:deploy       通过                     deps:audit         critical 0 / high 0 / moderate 1 / low 0，白名单 0 条
licenses:check     349 组                   typecheck          web + api
test               47 files / 446 tests     build              1,638.75 kB（gzip 506.78）
db:local:verify    22 迁移 / 17 文件 / 477 断言
db:local:http      9 文件 / 134 条
```

catalog 分项：`ops_catalog_domain` 106 条断言；集成 37 例；单测 52 例。
变异一次：删掉 `create_package` 的 `and mode.is_enabled` → pgTAP 红 3 条
（第 49 条「disabled sales mode 被拒」直接红，66/67 因脏数据连带红），复原后绿。

## 下一步

1. **`o-t06` 合同域**：它同时解开三处现在只能靠替身证明的分支——catalog 的
   `OBJECT_REFERENCED`（草拟合同引用产品/套餐）、客户域的 `referenced`、以及
   `contractStatus` / `entitlementExpiringInDays` 两个「接受但不生效」的字段。
   注意 `contract_items` 一旦落地，`catalog_reference_counts` 的守卫分支要改成真实查询，
   并补一条「引用了就拦」的集成用例（现在是 pgTAP 替身）。
2. **`minimatch >=11.0.1` 的 override 可行性评估**：单独一个单元，先看 `pnpm why`，
   再跑全量门禁确认 eslint / build 不炸；不做「顺手升」。
3. **等运营端回 `C-04` 四步结果**，以及契约回写 `C-100` ~ `C-103`（审计词已到 9 项，
   catalog 又添 8 项，下一次回写要一次补齐 17 项并说明命名规则）。

## 断点（2026-10-31 10:40）

- 分支 `feat/business-slice`，HEAD 为 journal 提交之前的 `e27bcb8`，工作树干净（看板在
  仓库外，不进版本控制）。
- 13 道门禁最后一次运行：全绿，数字见上一节。**引用这些数字必须是当次跑出来的。**
- catalog 域已完成并可联调：运营端可照 `C-04` 的四步之外，单独对 catalog 十三个端点
  做一次形状对账（`packages.status` 的推断口径要在联调时确认，这是本域唯一一个
  「契约没写死、由实现定」的枚举）。
- 未验证项（不要在不看这条的情况下宣称「已验证」）：
  - `OBJECT_REFERENCED` 只由 pgTAP 替身表证明，API 层走不出来（合同表未落地）；
  - `price_version_required` 同理（创建套餐必写首条价格版本）；
  - `packages.status` 三态是推断，契约未枚举；
  - 邀请补偿删除、GoTrue 相关三条仍在（见 `2026-10-30-idempotency-shape-and-gates.md`）。
