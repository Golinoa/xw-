# 2026-10-30 · 长任务推进计划建立

## 做了什么

看板实测 89 卡 / 47 done / 40 todo / 2 blocked。40 张待办里 39 张归我方（`a-opsfix` 是运营端回写契约正文）。把这 39 张排成一条可连续推进的长链：

- `Docs/superpowers/plans/2026-10-30-long-run.md`：39 卡 → 约 76 个推进单元；P1 可关桩 → P8 全量回归串行主线 + P9 业务 backlog 填缝；里程碑 M1~M8。
- `.harness/LONG_RUN.md`：节奏与止损约束（单元五步、11 道全量门禁、变异抽查、断点协议、跨层禁并行）。
- 索引挂载：`.harness/README.md`、`.harness/DOCUMENT_MAP.md`、`.harness/PLANS.md`、`exec-plans/active/README.md`。

## 三处顺序判定

1. **ops 主线不能并行**：11 个域是数据链不是模块清单（身份→客户+产品→合同→应收→收款→权益，报表读全部）。下层形状未定就写上层，测试只能对 mock 断言。所以 P3~P8 严格串行。
2. **`o-cors` / `o-testjwt` 从 `o-w04` 里拆出来前置**：两者都不依赖 `ops.operators`，可在身份基座后、`/meta` 前并行收口；且登录必须先有 CORS（cookie 跨源）才有意义。顺序变成 U01→U02→U03→U04→U05→U06，比旧顺序多一步，但 CORS 的红早两个单元暴露。
3. **`a-deps` 必须前置于 `o-t08`**：`o-t08` 是唯一写钱的域（核销/冲正/退款），带已知 critical 依赖写资金逻辑等于把风险埋在不可回滚路径上。`d1`（chunk 1,638 kB）同理提前——每加一域只增不减，现在按模块边界拆，等 11 域进来就是按已成型依赖链拆。

## 为什么业务 backlog 排最后

不是不重要，是**没有等待方**。它们推迟一段损失为零；而 `o-t04` 推迟一段，运营端那一域继续停在桩上，损失是一整片无法验证的功能。主线走完 8 个域后统一做，或填缝。

## 已知会卡的点（都不阻塞 U01 开工）

U-18/U-19 契约正文未回写；两常量数组取值待确认（按提案实现）；幂等 `actor_id` 措辞待改；邀请端到端只能单测替身。

## 断点（2026-10-30 12:1x）

- 本单元：无（计划建立，非实现单元）
- 已完成：长任务计划 + LONG_RUN 协议 + 四处索引挂载
- 未完成：U01 未开始
- 下一单元：**U01 / `o-t02` 身份基座**——迁移 `20261030000003_ops_identity.sql`（`operators`/`roles`/`permissions`/`role_permissions`/`operator_roles`/`audit_events` 六表 + `current_operator_id`/`has_permission`/`get_current_ops_context`/`write_audit` 四函数 + 39 码 seed）+ `supabase/tests/ops_identity_rls.sql`
- 阻塞：无
- 环境：15 迁移；11 个 pgTAP 文件 189 断言；`OPS_ROUTES` 仍为 `{}`；`ops` schema 下只有 `idempotency_records`

## 环境提示（给下一个接手的自己）

`ops` 迁移里 `CREATE SCHEMA if NOT EXISTS ops` 已经存在，U01 不要再建 schema。`ops.idempotency_records` 的列已由 `20261030000002` 对齐契约（`response_status` / `response_body` / `actor_id`），看板旧描述里的 `status`/`body` 是历史口径。`write_audit()` 要写 `audit_events`，两者必须同一次迁移。
