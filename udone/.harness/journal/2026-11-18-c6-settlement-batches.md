# C6 批量结算（R-SETTLE-01）

日期：2026-11-18 · 卡片：P2-C6（L）· 出口：迁移 + 4 个 API 端点 + Web 页面 + 三级测试全绿

## 结果

| 门禁 | 结果 |
|---|---|
| ESLint + CSS token | 通过 |
| `tsc --noEmit`（api）/ `vue-tsc --noEmit`（web） | 通过 |
| Vitest | 67 文件 / 883 用例全绿 |
| pgTAP | 43 文件全绿，`settlement_batches.sql` 22 断言 |
| 真实 PostgREST HTTP 集成 | 25 文件 / 412 用例全绿 |
| `schema:check` / `check:deploy` | 通过 |
| `vite build` | 通过（入口 40.73 kB；`vendor-antd` 895 kB 告警属 D1 已知边界） |

格式检查的说明：本机工作区是 CRLF 检出、Prettier 配置 `endOfLine: lf`，
全量 `format:check` 会把未改动的旧文件也报红；已对本次改动的 TS/Vue 逐个跑
Prettier（按各自行尾）通过，两份新增 SQL 用 `sql-formatter` 同配置比对一致。
Vite 清空 `dist/assets` 被沙箱的 safe-delete 拦截，构建输出到 Temp 下完成。

## 交付面

- 契约：`settlements.ts`（批次/候选/列表/过渡 DTO）、`routes.ts` 新增 4 条路由、2 个专用错误码。
- API：`modules/settlements/`（路由 + 服务 + 单测），挂载在付款申请之后。
- 数据：`20261118000002_settlement_batches.sql`，批次/明细两表 + 3 个 `SECURITY DEFINER` RPC。
- Web：结算列表 + 创建弹窗 + 导航/路由 + 错误文案映射。
- 测试：pgTAP 22 断言、API 单测、`tests/integration/settlements.test.ts`（真实 PostgREST 10 条）。

## 集成测试抓出的真缺陷：拒绝时留下 0 金额草稿

第一次跑 HTTP 集成有 1 条失败：封顶拒绝后列表第一条是 `status='draft'`、`totalAmount=0`。
打印响应后确认，是「累计封顶」那条用例建的 `2027-01` 空批次。

根因在 `create_settlement_batch`：先 `INSERT settlement_batches`，再逐条校验明细；
`ITEM_INVALID` / `DUPLICATE_ITEM` / `PAYABLE_NOT_FOUND` / `SUPPLIER_MISMATCH` /
`AMOUNT_EXCEEDS_AVAILABLE` 五条失败路径用 `RETURN QUERY` 返回错误码，
而 PostgreSQL 函数内的 `RETURN` **不回滚**已执行的 INSERT。用户重试同一个月会再撞
`BATCH_EXISTS`，永远清不掉这条草稿 —— 这是资损口径之外的可用性坑。

修法：把批次 INSERT 挪到全部明细校验通过之后。同一循环里先把校验过的明细收进
`validated_items` JSONB（含订单号/名称快照），循环结束再一次性插批次和明细。
锁仍按 `payable_id` 排序，在校验循环里拿到，顺序不变。

回归断言：pgTAP 新增「封顶被拒后 supplier+period 下批次数为 0」，
`plan` 从 21 调到 22。集成用例末尾改为按 `batchId` 找目标批次，不再假设它排第一。

## 未做

- 结算凭证/附件（需求 R-FILE-01 暂缓）。
- 月结自动跑批：当前只有手动建批次 + 确认/作废，没有 Cron。
- 列表导出（归 C8 报表统一口径）。
- 真人点过 Web 页面吗：没有，只有类型检查 + 构建 + 单测覆盖显示映射。
