# 2026-10-31 · contract 域（T-06）

## 今日完成

`o-t06` 合同生命周期与版本快照，两个提交：

- `0a9f6c2` 五表 + 14 个 RPC + 144 条 pgTAP；同时交付规格
  `Docs/superpowers/specs/2026-10-31-contract-domain.md`。
- `f992015` 契约、14 个端点、57 条单测、37 条集成（集成文件总 182 条）。

范围比 catalog 域大：五张表、七个状态边、一个「金额全部 SQL 重算」的写入路径、
一个两段式附件的元数据层。14 个端点里两条前缀不同（`/contract-attachments/{id}/...`），
不是 `/contracts/{id}/` 的子路径。

## 关键决策

1. **`current_version_no` 默认 0，不是契约写的 1。** draft 阶段没有任何
   `contract_versions` 行，默认 1 会让「已有一版快照」与「还没有版本」不可区分。
   `activate` 时才写 1。已作为推断记入卡片与 C-104。
2. **`POST /contracts` 必须判销售方式。** 契约 §5.4 的 400「销售方式未开放」写在
   POST 行，不是只写在 sign 上。等到签署才拒，会留下一张永远卖不出去的草稿——
   PATCH 改不了 `sales_mode`（换销售方式等于换一份合同），它只能被 terminate 掉。
   条目只写 `packageId` 时要从套餐反查产品，否则漏判。
3. **变更单审批必须校验路径上的合同 id。** 原来的 RPC 只有 `p_amendment_id`，
   把变更单挂到别的合同路径下也能批成功。权限码一样（都是 `contract.approve`），
   所以这不构成越权，但审计里的 `contract_id` 会记成路径上那张——事后追「谁改了
   哪份合同」就是错的。归属不符按 `amendment_not_found` 处理，不区分「不存在」与
   「不属于这份合同」：区分等于允许用别的合同 id 探测变更单是否存在。
4. **形状函数的 JSON 键一律 snake_case。** 我在规格 §5 里把 `tenant_commands`
   写成了 `tenantCommands`，DB 会话照做了，结果所有 transition 出站校验 503。
   改库、不动 row schema——schema 那一侧才是与项目惯例一致的一边。
5. **`GET /contract-attachments/{id}/access` 按契约回 `url`。** 实现原来写
   `downloadUrl`（大概是顺着上传那行的 `uploadUrl` 推的）。契约这一行就是 `url`，
   前端按契约取值，改名等于签名链接永远取不到。
6. **客户域与 catalog 域的替身表改成真实表。** 它们此前用同事务内的
   `CREATE TABLE ops.contracts` 模拟「合同域尚未落地」，T-06 一落地就撞名
   （`relation "contracts" already exists`），两个文件直接在 setup 阶段中断。
   改成写真实行（catalog 那边还要补一个客户夹具，真表的 `customer_id` 是
   NOT NULL + FK），并删掉对应 `DROP`——留着会把真表删了。

## 遇到的问题

- **三个「单测 stub 过得去、真库过不去」的缺陷**：camelCase 键（503）、
  漏销售方式守卫（201 而不是 400）、变更单归属不校验（别的合同路径下也 200）。
  单测全是 stub 出站形状，根本碰不到这些；集成测试一跑就露。这一类问题只有
  真实 PostgREST 能抓，以后每个域都该先跑集成再补单测。
- **`reason` 契约可选、实现必填**：本域 transition 一律要求 reason，理由是
  `contract.transitioned` 的审计摘要要带 `{from,to,reason}`。这是「更严」而不是
  错，但在契约层是偏差，记 C-104 而不是偷偷改契约。
- **变更单状态起点与契约不一致**：契约 §5.4 写建单即 `pending_approval`，
  实现是 `draft` + 一次 `submit`。保留实现（§3.3 的状态枚举里有 `draft`，
  若建单不能是 draft 这个值就永远不可达），偏差记 C-104 请运营端裁决。
- **`approve → apply` 在集成层证不了**：本地夹具只有一个带 `contract.approve`
  的运营账号，第二个审批人不存在，自己批自己必然被 `SELF_APPROVAL` 拦。
  改成断言「自批被拒」（这比「能批」更值得证），apply 的快照这一段交给 pgTAP。
- **修 `p_contract_id` 时忘了授权块的显式签名**：`REVOKE ALL ON function
  ops.transition_contract_amendment (uuid, text, text, integer)` 在参数加了一个
  uuid 后直接报 `function ... does not exist`。迁移里凡是写显式签名的授权/注释
  语句，改参数列表时必须一起改，三处。
- **看板被并行会话改过**：我这轮开始时是 SEED_VERSION 30 / 66 done，跑门禁时
  已经是 31 / 67 done（运营端那边闭环了一个协作项）。回写前先读现状再编辑，
  没有覆盖对方的改动。

## 下一步计划

合同表落地后，三张此前只能靠 `to_regclass` 替身证明的卡解锁：

- `o-t07` 应收计划与展期 —— 依赖合同 `total_amount`，现在可做；
- `o-t09` 订阅·授权·权益快照 —— `contract_items.entitlement_snapshot_id` 现在是
  软引用无 FK，T-09 落地后要回来补 FK 与 `entitlementLines`（快照里现在是空数组）；
- `o-t12` 售后工单 —— `tickets.contract_id` 可以建真 FK 了，但它还隐性等
  `ops.settings`（`isOverdue` 要用 `ticket.dueHours`），建议把 settings 单独
  先落一张小表，让 o-t12 与 o-t13 共享。

`o-t08`（收款）依赖 o-t07，且是全项目风险最高域，建议单独一轮、不并行。

## 断点（2026-10-31 11:27）

- 分支 `feat/business-slice`，HEAD `f992015`（contract 端点）；`0a9f6c2` 是数据库层。
- 13 道门禁一次跑完退出码 0：23 迁移 / 18 文件 / 620 断言；集成 10 文件 182 条；
  单测 48 文件 503 例；build 主 chunk 1,638.75 kB（无增长）；
  deps:audit critical 0 / high 0 / moderate 1（`minimatch <11.0.1`，审计源新发）/ low 0。
- 看板 SEED_VERSION 32 · 99 卡（68 done / 1 doing / 28 todo / 2 blocked）·
  协作 24 项（8 未闭环，新增 C-104 五处口径裁决、C-105 审计词 9→17）。
- 下一步建议：`o-t07` + `o-t12`（先落 `ops.settings`）两会话并行；`o-t09` 接在
  o-t07 之后（同属权益/订阅链条，改动会碰同一批契约文件）。
