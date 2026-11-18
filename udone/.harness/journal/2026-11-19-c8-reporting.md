# C8 报表与统一口径（R-REPORT-01）

日期：2026-11-19 · 卡片：P2-C8（L）· 出口：报表 API + 页面 + CSV 导出共用一套口径

## 结果

| 门禁 | 结果 |
|---|---|
| pgTAP | 48 文件全绿，`tenant_reports.sql` 6 断言 |
| Vitest | 72 文件 / 907 用例全绿 |
| HTTP 集成 | 30 文件 / 437 用例全绿 |
| tsc + vue-tsc / lint / CSS token | 通过 |
| schema:check（56 迁移）/ build | 通过 |

## 交付面

- 迁移 `20261119000004_tenant_reports.sql`：
  - `tenant_report(from,to,include_cancelled)` 返回整份总览 JSONB；
  - `tenant_supplier_report(...)` 返回供应商统计；
  - 两者共用同一订单范围（创建日期 + cancelled 口径）。
- 契约：`reports.ts` + 2 个端点。
- API：`GET /api/reports/tenant`、`GET /api/reports/suppliers`。
- Web：`/reports` 报表页，日期区间、含已取消开关、状态分布、供应商表、CSV 导出。
- 测试：pgTAP 6 断言、API 单测 5 条、HTTP 集成 5 条。

## 统一口径（这是本卡存在的理由）

1. 页面、仪表盘、CSV 导出**都调同一个数据库函数**，导出直接用页面已拿到的数据，不另算一遍。
2. 按订单 `created_at` 过滤，页面明确显示「创建日期」。
3. 默认含 booking / active / completed 并分状态；cancelled 默认排除，调用方显式传 `includeCancelled` 才纳入。
4. 财务统计只计 confirmed_amount，pending_amount 单列为「在途」，不混进总额。

## 踩过的坑（下次直接照做）

1. **PostgREST RPC 返回 jsonb 标量时给对象不是数组**（与 C12 同坑）：
   `client.rest<ReportResponse[]>` 取 `rows[0]` 会得到 undefined，出站校验报 `(root) invalid_type` → 500。
   服务层要兼容对象与数组两种形状。
2. **`order.read` 是全角色基础权限**（admin/operator/finance 都有）：
   不要写「operator 读报表应 403」这种测试，实际就是 200。权限机制本身由 API 单测用空权限身份覆盖。
3. pgTAP 里 date 是 timestamptz 比较，硬编码未来日期范围会漏掉当前创建的订单；
   测试用 `current_date - 1` / `+1` 动态范围更稳。
4. numeric 的 JSON 输出带两位小数（`"6000.00"`），断言期望值要写 '6000.00' 而不是 '6000'。
5. SQL 聚合函数里不能直接 `SELECT profit FROM scoped_orders`（多行会报错），要 `SUM(profit)`。

## 边界

- 业绩「本人/全部」范围未做：当前报表按租户整体，没有按负责人拆分。
- 订单明细报表未单独做端点：总览与供应商统计已覆盖主要场景，明细可从订单列表按同日期筛选得到。
- CSV 导出是前端 Blob 生成，没有服务端异步导出/时效下载（需求里那是超 3 秒时的路径）。
